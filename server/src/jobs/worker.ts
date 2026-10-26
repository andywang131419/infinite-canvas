/**
 * 内嵌 Worker（ARCH §R2.5：`jobs` 表 + 租约 + 进程内 Worker）。
 *
 * T03 起真正消费任务。一次 tick 的完整动作：
 *
 *   1. `requeueExpired()`（每 N 个 tick 一次）—— 把"上次进程被杀"留下的
 *      过期租约要么回队（还有重试余量）要么判失败（已用尽）；
 *   2. 按 `WORKER_CONCURRENCY - inFlight` 的空位循环 `claimNextJob()`
 *      —— 每次认领都是**单条** `UPDATE ... RETURNING *`，并发安全由 SQLite 保证；
 *   3. 每个任务起一个并发的 `executeJob()`：
 *      - 起心跳定时器续租；续租失败 = 租约已归别人 → abort + 丢弃结果；
 *      - 分派给 handler；成功写 `succeeded` + 结果键，失败按"可否重试"决定
 *        是回队退避还是终态 `failed`。
 *
 * 为什么心跳失败要"丢弃结果"而不是继续写：
 * 租约过期后另一个 Worker 会重新跑同一个任务（可能已经成功并写了结果），
 * 此时旧 Worker 再写一次就会把新结果覆盖成旧结果，且 `attempt` 计数已乱。
 * 宁可浪费一次上游调用，也不能污染状态。
 */

import { ApiError } from "../http/errors";
import { isProviderError } from "../providers";
import { getEnv } from "../env";
import {
    claimNextJob,
    heartbeat,
    markFailed,
    markSucceeded,
    requeueExpired,
    setUpstreamTaskId,
    updateProgress,
    type JobRow,
} from "./queue";
import { JobFailure, LeaseLostError } from "./types";
import type { JobHandler, JobHandlerContext } from "./types";

export type { JobHandler, JobHandlerContext, JobHandlerResult } from "./types";
export { LeaseLostError, JobFailure } from "./types";

/** Worker 生命周期状态。 */
export type WorkerState = "stopped" | "idle" | "running" | "stopping";

/** Worker 可观测状态（`/api/health` 用）。 */
export type WorkerStatus = {
    /** 是否由环境变量启用（WORKER_ENABLED）。 */
    enabled: boolean;
    state: WorkerState;
    /** 并发上限（WORKER_CONCURRENCY）。 */
    concurrency: number;
    /** 轮询间隔毫秒（WORKER_POLL_MS）。 */
    pollMs: number;
    /** 已注册的 job type 数量（T03 起为 5）。 */
    registeredTypes: number;
    /** 进程内累计处理的 tick 次数。 */
    ticks: number;
    /** 当前正在执行的任务数。 */
    inFlight: number;
};

/** 进度写库节流：上游可能每 2.5s 回调一次，没必要每次都写。 */
const PROGRESS_MIN_INTERVAL_MS = 1500;

/** 每多少个 tick 做一次过期租约回收（1s tick 下约 15s 一次）。 */
const REQUEUE_EVERY_TICKS = 15;

const handlers = new Map<string, JobHandler>();

let state: WorkerState = "stopped";
let pollTimer: ReturnType<typeof setInterval> | null = null;
let ticks = 0;
let inFlight = 0;
let stopping: Promise<void> | null = null;
const running = new Set<Promise<void>>();

/**
 * 注册一个 job type 的处理器。
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

/** 已注册的类型（排障用）。 */
export function registeredJobTypes(): string[] {
    return [...handlers.keys()].sort();
}

/**
 * 启动 Worker。
 *
 * 顺序要求（由 `index.ts` 保证）：先完成 DB 迁移 → 注册 handler → 启动 Worker → 监听端口。
 * 若 `WORKER_ENABLED=false`，保持 stopped 状态，不创建定时器。
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

    // 启动即回收一次：上次进程被杀留下的 running 任务不该再等 15s。
    const reclaimed = requeueExpired(env.JOB_RETRY_BACKOFF_S);
    if (reclaimed.requeued > 0 || reclaimed.failed > 0) {
        console.info(`[worker] 启动回收过期租约：重新排队 ${reclaimed.requeued} 个，判失败 ${reclaimed.failed} 个`);
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
 * 停止 Worker 并等待进行中的任务完成（上限 10s，超时后强停）。
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
 * 只做"认领 + 拉起并发执行"，**不 await** 任务完成 ——
 * 否则一个视频任务（几分钟）会堵死整个 Worker。
 */
async function tick(): Promise<void> {
    if (state !== "idle") return;

    state = "running";
    try {
        const env = getEnv();

        if (ticks > 0 && ticks % REQUEUE_EVERY_TICKS === 0) {
            const reclaimed = requeueExpired(env.JOB_RETRY_BACKOFF_S);
            if (reclaimed.requeued > 0 || reclaimed.failed > 0) {
                console.warn(`[worker] 回收过期租约：重新排队 ${reclaimed.requeued} 个，判失败 ${reclaimed.failed} 个`);
            }
        }

        if (handlers.size > 0) {
            const free = Math.max(0, env.WORKER_CONCURRENCY - inFlight);
            for (let slot = 0; slot < free; slot += 1) {
                const job = claimNextJob(env.WORKER_LEASE_SECONDS);
                if (!job) break;

                inFlight += 1;
                const task = executeJob(job).finally(() => {
                    inFlight -= 1;
                    running.delete(task);
                });
                running.add(task);
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
 * 执行一个已认领的任务。
 *
 * 整个函数**不抛异常**：所有失败都在内部翻译成 `markFailed`，
 * 否则未捕获的 rejection 会在 Bun 里变成进程级警告甚至退出。
 */
async function executeJob(job: JobRow): Promise<void> {
    const env = getEnv();
    const controller = new AbortController();

    let leaseLost = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    /** 续租间隔取租约的 1/3，保证两次续租之间至少有 2 次容错机会。 */
    const heartbeatMs = Math.max(1000, Math.floor((env.WORKER_LEASE_SECONDS * 1000) / 3));
    timer = setInterval(() => {
        try {
            if (!heartbeat(job.id, env.WORKER_LEASE_SECONDS)) {
                leaseLost = true;
                controller.abort();
                console.warn(`[worker] 任务 ${job.id} 租约已被回收，abort 执行`);
            }
        } catch (error) {
            console.error(`[worker] 任务 ${job.id} 心跳失败`, error);
        }
    }, heartbeatMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    let lastProgressAt = 0;
    let lastProgressValue = -1;

    const ctx: JobHandlerContext = {
        job,
        signal: controller.signal,
        reportProgress: (progress, stage) => {
            const now = Date.now();
            const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
            // 节流：1.5s 内不重复写；进度变化 < 1% 且没有 stage 也不写。
            if (now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
            if (Math.abs(clamped - lastProgressValue) < 0.01 && !stage) return;
            lastProgressAt = now;
            lastProgressValue = clamped;
            try {
                updateProgress(job.id, clamped, stage ?? null);
            } catch (error) {
                console.warn(`[worker] 任务 ${job.id} 进度写库失败`, error);
            }
        },
        setUpstreamTask: (upstreamTaskId) => {
            try {
                setUpstreamTaskId(job.id, upstreamTaskId);
            } catch (error) {
                console.warn(`[worker] 任务 ${job.id} 记录上游任务 id 失败`, error);
            }
        },
        assertLease: () => {
            if (leaseLost || controller.signal.aborted) throw new LeaseLostError(job.id);
        },
    };

    const handler = handlers.get(job.type);

    try {
        if (!handler) {
            markFailed(job, { code: "INTERNAL", message: `没有注册 ${job.type} 类型的处理器`, retryable: false }, env.JOB_RETRY_BACKOFF_S);
            return;
        }

        const startedAt = Date.now();
        const result = await handler(ctx);

        if (leaseLost || controller.signal.aborted) {
            console.warn(`[worker] 任务 ${job.id} 租约已失效，丢弃本次结果（${result.storageKeys.length} 个资产）`);
            return;
        }

        const written = markSucceeded(job.id, result.storageKeys, result.costActual);
        if (!written) {
            // 0 行受影响：任务已不在 running（被取消或被判失败），结果只能记录无法写回。
            console.warn(`[worker] 任务 ${job.id} 收尾失败（状态已变更），结果键：${result.storageKeys.join(",")}`);
            return;
        }

        console.info(
            `[worker] 任务 ${job.id} 成功：type=${job.type} attempt=${job.attempt} 耗时=${Math.round((Date.now() - startedAt) / 1000)}s keys=${result.storageKeys.length}`,
        );
    } catch (error) {
        if (error instanceof LeaseLostError || leaseLost) {
            console.warn(`[worker] 任务 ${job.id} 租约丢失，放弃写回（${describe(error)}）`);
            return;
        }

        const failure = classifyError(error);
        const outcome = markFailed(job, failure, env.JOB_RETRY_BACKOFF_S);
        const suffix = outcome.nextAttemptInSeconds === null ? "（不再重试）" : `（${outcome.nextAttemptInSeconds}s 后重试）`;
        console.error(`[worker] 任务 ${job.id} 失败：${failure.code} ${failure.message}${suffix}`);
    } finally {
        if (timer) clearInterval(timer);
    }
}

/** 异常 → 任务失败信息。 */
function classifyError(error: unknown): { code: string; message: string; retryable: boolean } {
    if (error instanceof JobFailure) {
        return { code: error.code, message: error.message, retryable: error.retryable };
    }

    if (isProviderError(error)) {
        return { code: error.code, message: error.message, retryable: error.retryable };
    }

    if (error instanceof ApiError) {
        // 无可用渠道/密钥缺失属于配置问题，重试无意义；
        // 限流与上游错误则值得再试一次。
        const retryable = error.code === "QUOTA_EXCEEDED" || error.code === "RATE_LIMITED" || error.code === "PROVIDER_TIMEOUT";
        return { code: error.code, message: error.message, retryable };
    }

    if (error instanceof Error) {
        // 未知异常按可重试处理：大多是网络抖动或临时性 bug，
        // 让 max_attempts 兜住，比直接放弃更符合"任务队列"的语义。
        return { code: "INTERNAL", message: error.message || error.name, retryable: true };
    }

    return { code: "INTERNAL", message: String(error), retryable: true };
}

/** 错误描述（日志用，不进入数据库）。 */
function describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Promise 化的 sleep。 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
