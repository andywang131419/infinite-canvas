/**
 * SSE 心跳包装。
 *
 * 背景（T01 的 `idleTimeout: 255` 约束）：Bun 的 `serve({ idleTimeout })`
 * 上限是 255s，且不接受 0。如果上游模型"思考"超过 255s 一个字节都不写，
 * 连接会被运行时直接掐断 —— 画布助手的流式回答会表现为"答到一半消失"。
 *
 * 对策：在服务端包装上游响应流，**空闲时注入 SSE 注释行** `: keep-alive\n\n`。
 * 按 SSE 规范（WHATWG HTML §9.2.4），以 `:` 开头的行是注释，客户端会忽略，
 * 但它是真实的字节流量，足以续活连接。
 *
 * 为什么在流里注入而不是用定时器单独 write：
 * Hono/Bun 的流式响应只允许通过 ReadableStream 控制器写数据，
 * 旁路写会造成帧序错乱（心跳插到某个事件中间）。
 */

/** 心跳注释（符合 SSE 注释语法，客户端解析器会忽略）。 */
export const HEARTBEAT_LINE = ": keep-alive\n\n";

/** 默认空闲阈值：远小于 255s，又不会把日志刷爆。 */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * 一次读取的结果。
 *
 * 不直接用全局 `ReadableStreamReadResult`：它属于 DOM / undici 的 lib 声明，
 * 而本项目 tsconfig 只有 `lib: ["ESNext"]`（刻意如此，服务端不需要 DOM）。
 */
type ReadResult = { done: boolean; value?: Uint8Array };

/**
 * 包装一个字节流，在空闲超过 `intervalMs` 时插入心跳注释。
 *
 * 关键实现细节：`reader.read()` 的 Promise 被**跨 pull 保留**在 `pending` 里。
 * 如果每次 pull 都重新发起 read 并在超时后丢弃，超时那次读到的数据就会永久丢失
 * —— 这是流包装最常见的 bug（表现为偶尔丢一个 SSE 事件）。
 *
 * @param source 上游响应体（`fetch(...).body`）
 * @param intervalMs 空闲阈值；<=0 表示不注入（纯透传）
 */
export function withHeartbeat(source: ReadableStream<Uint8Array>, intervalMs: number = DEFAULT_HEARTBEAT_MS): ReadableStream<Uint8Array> {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return source;

    const reader = source.getReader();
    const encoder = new TextEncoder();

    /** 跨 pull 保留的在途读取（见上方注释）。 */
    let pending: Promise<ReadResult> | null = null;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            pending ??= reader.read();

            let timer: ReturnType<typeof setTimeout> | null = null;
            const timeout = new Promise<"timeout">((resolve) => {
                /**
                 * 这里**刻意不 unref**。
                 *
                 * unref 会让"只在等这个定时器"的进程直接退出 ——
                 * 而 `pull()` 正处于 `await` 中，进程退出会让这次 await 永远不落地
                 * （Node 报 `Detected unsettled top-level await`）。
                 * 定时器每次 pull 都会在 finally 里清掉，不会拖住优雅停机。
                 */
                timer = setTimeout(() => resolve("timeout"), intervalMs);
            });

            try {
                const winner = await Promise.race([pending, timeout]);

                if (winner === "timeout") {
                    // 心跳不算"流结束"，pending 保留给下一次 pull。
                    controller.enqueue(encoder.encode(HEARTBEAT_LINE));
                    return;
                }

                pending = null;
                if (winner.done) {
                    controller.close();
                    return;
                }
                if (winner.value) controller.enqueue(winner.value);
            } catch (error) {
                pending = null;
                controller.error(error);
            } finally {
                if (timer) clearTimeout(timer);
            }
        },

        async cancel(reason) {
            // 客户端断开：必须把上游也取消，否则上游会继续生成并计费。
            pending = null;
            await reader.cancel(reason).catch(() => undefined);
        },
    });
}

/**
 * SSE 响应头。
 *
 * `X-Accel-Buffering: no` 是给 nginx 类反代的显式指令（Caddy 会忽略），
 * 没有它，即便服务端逐块 flush，反代也可能攒够缓冲才下发。
 * `Cache-Control: no-store` 防止中间缓存把流式回答缓存成"一次性快照"。
 */
export function sseHeaders(): Record<string, string> {
    return {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    };
}
