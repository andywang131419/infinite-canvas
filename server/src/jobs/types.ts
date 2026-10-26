/**
 * Worker / Handler 共享类型。
 *
 * 单独成文件的目的：`worker.ts` 要 import `handlers/index.ts`（注册表），
 * handler 又要用到这里的类型。若类型放在 worker.ts 里就会形成运行时环，
 * 放到这里 + 全部 `import type` 后，运行时依赖是单向的：
 *
 *     handlers/* → jobs/types.ts
 *     jobs/worker.ts → handlers/index.ts → handlers/* → jobs/types.ts
 */

import type { JobRow } from "./queue";

/** Handler 执行上下文。 */
export type JobHandlerContext = {
    /** 认领时的任务行快照（`attempt` 已 +1）。 */
    job: JobRow;
    /** 租约丢失时被 abort；handler 应尽快放弃并让异常冒泡。 */
    signal: AbortSignal;
    /** 上报进度（会被夹到 [0,1] 并按节流写库）。 */
    reportProgress: (progress: number, stage?: string) => void;
    /** 记录上游二级任务 ID（视频）。 */
    setUpstreamTask: (upstreamTaskId: string) => void;
    /**
     * 断言租约仍然有效，无效时抛 `LeaseLostError`。
     *
     * 在"落存储之前"调用一次，可以避免把成果写进一个已经被别人重跑的任务里。
     */
    assertLease: () => void;
};

/** Handler 成功返回。 */
export type JobHandlerResult = {
    /** 结果资产的逻辑键（`image:xxx` / `video:xxx` / `audio:xxx` / `file:xxx`）。 */
    storageKeys: string[];
    /** 上游回报的真实花费。 */
    costActual: number | null;
};

/** 单个任务处理器。 */
export type JobHandler = (ctx: JobHandlerContext) => Promise<JobHandlerResult>;

/**
 * 租约丢失。
 *
 * 与"任务失败"不同：租约丢失意味着**另一个 Worker 已经接手**，
 * 当前 Worker 必须静默退出，既不能写成功也不能写失败（否则会把新 Worker 的
 * 状态覆盖掉）。Worker 捕获它后只记日志。
 */
export class LeaseLostError extends Error {
    constructor(jobId: string) {
        super(`任务 ${jobId} 的租约已失效，放弃本次执行`);
        this.name = "LeaseLostError";
    }
}

/**
 * 业务侧可预期的任务失败（带错误码与可重试判断）。
 *
 * Worker 的映射顺序：`JobFailure` → `ApiError` → `ProviderError` → 未知异常（`INTERNAL`，可重试）。
 * 有这一个类，handler 就不必为了"可重试/不可重试"去伪造 ProviderError。
 */
export class JobFailure extends Error {
    readonly code: string;
    readonly retryable: boolean;

    constructor(code: string, message: string, retryable = false) {
        super(message);
        this.name = "JobFailure";
        this.code = code;
        this.retryable = retryable;
    }
}
