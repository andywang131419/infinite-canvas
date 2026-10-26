/**
 * 内嵌 Worker 骨架（ARCH §R2.5：`jobs` 表 + 租约 + 进程内 Worker）。
 *
 * T01 范围：**只保证生命周期与可观测性**，不消费任务。
 * 任务 claim / 执行 / 租约续期 / 退避重试在 **T03** 接入，接入点已明确标注在
 * `processOnce()` 内。当前处理器注册表为空是**正确状态**（没有任何 job type
 * 已实现），而不是占位符：`processOnce()` 在空表时直接返回 0。
 *
 * 设计要点：
 * - 单进程内运行，不引入 Redis/队列中间件（§R3「明确不引入」）
 * - 可优雅停机：`stopWorker()` 会等待进行中的 tick 结束后退出
 * - 状态可查：`getWorkerStatus()` 供 `/api/health` 使用
 */

import { getEnv } from "../env";

/** 单个任务处理器。T03 由 `jobs/handlers/*` 注册进来。 */
export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** 被 worker 领取到的任务最小形状（T03 由 repos 填充完整字段）。 */
export type ClaimedJob = {
    id: string;
    type: string;
    capability: "image" | "video" | "audio" | "text";
    attempt: number;
};

/** Worker 生命周期状态。 */
export type WorkerState = "stopped" | "idle" | "running" | "stopping";

/** Worker 可观测状态。 */
export type WorkerStatus = {
    /** 是否由环境变量启用（WORKER_ENABLED）。 */
    enabled: boolean;
    state: WorkerState;
    /** 并发上限（WORKER_CONCURRENCY）。 */
    concurrency: number;
    /** 轮询间隔毫秒（WORKER_POLL_MS）。 */
    pollMs: number;
    /** 已注册的 job type 数量（T01 为 0）。 */
    registeredTypes: number;
    /** 进程内累计成功处理的 tick 次数。 */
    ticks: number;
    /** 当前正在执行的任务数。 */
    inFlight: number;
};

const handlers = new Map<string, JobHandler>();

let state: WorkerState = "stopped";
let pollTimer: ReturnType<typeof setInterval> | null = null;
let ticks = 0;
let inFlight = 0;
let stopping: Promise<void> | null = null;

/**
 * 注册一个 job type 的处理器（T03 使用）。
 *
 * 同一 type 重复注册会抛错——避免启动期静默覆盖导致任务被错误实现处理。
 */
export function registerJobHandler(type: string, handler: JobHandler): void {
    if (handlers.has(type)) {
        throw new Error(`job handler 已注册：${type}`);
    }
    handlers.set(type, handler);
}

/** 清空处理器注册表（仅测试用）。 */
export function clearJobHandlers(): void {
    handlers.clear();
}

/**
 * 启动 Worker。
 *
 * 顺序要求（由 `index.ts` 保证）：先完成 DB 迁移，再启动 Worker，最后监听端口。
 * 若 `WORKER_ENABLED=false`，直接保持 stopped 状态，不创建定时器。
 */
export function startWorker(): void {
    const env = getEnv();

    if (!env.WORKER_ENABLED) {
        state = "stopped";
        console.info("[worker] WORKER_ENABLED=false，Worker 不启动（仅 API 模式）");
        return;
    }

    if (pollTimer) {
        console.warn("[worker] 已在运行，忽略重复启动");
        return;
    }

    state = "idle";
    pollTimer = setInterval(() => {
        void tick();
    }, env.WORKER_POLL_MS);

    // Node/Bun 中 unref 可让定时器不阻塞进程退出；Bun 支持该 API。
    (pollTimer as unknown as { unref?: () => void }).unref?.();

    console.info(
        `[worker] 已启动：poll=${env.WORKER_POLL_MS}ms concurrency=${env.WORKER_CONCURRENCY} lease=${env.WORKER_LEASE_SECONDS}s types=${handlers.size}`,
    );
}

/**
 * 停止 Worker 并等待进行中的 tick 完成。
 *
 * 幂等：重复调用返回同一个 Promise。
 */
export function stopWorker(): Promise<void> {
    if (stopping) return stopping;

    stopping = (async () => {
        const previous = state;
        state = "stopping";

        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        // 等待在途任务结束（上限 10s，避免停机被单个长任务永久拖住）。
        const deadline = Date.now() + 10_000;
        while (inFlight > 0 && Date.now() < deadline) {
            await sleep(50);
        }

        state = "stopped";
        stopping = null;
        console.info(`[worker] 已停止（此前状态：${previous}，在途剩余：${inFlight}）`);
    })();

    return stopping;
}

/** 读取 Worker 状态。 */
export function getWorkerStatus(): WorkerStatus {
    const env = getEnv();
    return {
        enabled: env.WORKER_ENABLED,
        state,
        concurrency: env.WORKER_CONCURRENCY,
        pollMs: env.WORKER_POLL_MS,
        registeredTypes: handlers.size,
        ticks,
        inFlight,
    };
}

/**
 * 单次轮询。
 *
 * 职责边界（重要）：
 * - T01：没有任何已注册处理器时，`claimable` 必为 0，直接返回，不做任何 DB 写。
 * - T03：在此处替换为「按 `ix_jobs_queue` claim → 加租约 → 分派 handler →
 *   写回 status/progress/result_storage_keys」。届时需要引入 `jobs/queue.ts`。
 */
async function tick(): Promise<void> {
    if (state !== "idle") return;

    state = "running";
    try {
        const claimable = handlers.size === 0 ? 0 : await claimBatch();
        if (claimable > 0) {
            inFlight += claimable;
            try {
                await dispatchBatch();
            } finally {
                inFlight -= claimable;
            }
        }
        ticks += 1;
    } catch (error) {
        // 单次 tick 失败不能杀死 worker：记录后等待下一轮。
        console.error("[worker] tick 失败", error);
    } finally {
        if (state === "running") state = "idle";
    }
}

/**
 * 领取一批任务（T03 实现）。
 *
 * T01 返回恒为 0：`tick()` 只在存在已注册处理器时才会调用本函数，
 * 而 T01 的处理器注册表为空，因此这里实际不会被触达。
 *
 * T03 接入点：
 *   SELECT id, type, capability, attempt FROM jobs
 *    WHERE status = 'queued' AND run_after <= :now
 *    ORDER BY priority DESC, created_at
 *    LIMIT :concurrency
 *   然后 UPDATE status='running', lease_until=:now+lease, attempt=attempt+1
 */
async function claimBatch(): Promise<number> {
    return 0;
}

/** 分派已领取任务给对应 handler（T03 实现）。 */
async function dispatchBatch(): Promise<void> {
    // T03 接入点：对每个 claimed job 调用 handlers.get(job.type)，聚合并写回结果。
}

/** Promise 化的 sleep。 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
