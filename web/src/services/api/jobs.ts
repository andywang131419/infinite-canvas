/**
 * `/api/jobs` 客户端（T04-B 阶段 1）—— 与 `server-api.ts` 同一套风格：
 * 只管"路径 + 超时/取消 + 类型"，信封解包仍在 `lib/api-client.ts`。
 *
 * 为什么要有这一层（服务端能力早就有了，前端从没接上）：
 * - 刷新后画布里所有 `loading` 节点会被 `resetInterruptedGeneration` 一律标成
 *   "已中断"，而服务端其实还在跑 —— 表现就是"看起来能接续、实际不能"；
 * - 生成放在浏览器里直连上游时，页面一关就什么都没了。
 *
 * 三条硬约束（违反会出真事故）：
 * 1. **幂等键必须稳定**：见 `buildImageJobIdempotencyKey`；
 * 2. **恢复前必须先查再决定**：`listOpenJobs` 命中就 attach，绝不重新提交；
 * 3. 轮询必须能被 `AbortSignal` 取消，且取消时抛 `AbortError`
 *    （`isGenerationCanceled` 认这个名字）。
 */

import { apiDelete, apiGet, apiPost } from "../server-api";
import { isTerminalJobStatus, type JobStatus } from "./job-utils";

/** 任务 DTO（字段与 `server/src/services/job-service.ts` 的 `JobDto` 一一对应）。 */
export type JobDto = {
    id: string;
    canvasId: string;
    nodeId: string;
    type: string;
    capability: string;
    model: string;
    channelId: string | null;
    status: JobStatus | string;
    progress: number;
    stage: string | null;
    resultStorageKeys: string[];
    upstreamTaskId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    retryable: boolean;
    attempt: number;
    maxAttempts: number;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    updatedAt: string;
};

/** 入队请求体（与服务端 `createJobSchema` 对齐）。 */
export type CreateJobInput = {
    canvasId: string;
    nodeId: string;
    type: "image" | "image_edit" | "video" | "audio" | "llm";
    model?: string;
    channelId?: string;
    params?: Record<string, unknown>;
    idempotencyKey?: string;
    priority?: number;
    maxAttempts?: number;
};

/** 入队响应：`created=false` 表示命中幂等键，这次**没有**真的新建任务。 */
export type CreateJobResult = {
    job: JobDto;
    created: boolean;
    jobId: string;
};

/** 列表响应。 */
export type ListJobsResult = {
    items: JobDto[];
    total: number;
};

/** 轮询默认间隔（服务端租约 60s，图像任务一般几秒到几十秒）。 */
export const JOB_POLL_INTERVAL_MS = 1500;

/** 轮询默认总时限：留足余量，超时后由调用方决定怎么提示。 */
export const JOB_POLL_TIMEOUT_MS = 15 * 60_000;

/** 入队（幂等）。命中已有键时服务端返回 200、`created=false`。 */
export function createJob(input: CreateJobInput, signal?: AbortSignal): Promise<CreateJobResult> {
    return apiPost<CreateJobResult>("/api/jobs", input, { signal });
}

/**
 * 列出画布上未完成的任务（`queued|running`）。
 *
 * 打开画布时**先**调它：命中的节点要保持 loading 并 attach，
 * 而不是被 reset 成"已中断"，更不能重新提交一次。
 */
export async function listOpenJobs(canvasId: string, limit = 100, signal?: AbortSignal): Promise<JobDto[]> {
    const query = new URLSearchParams({ canvasId, open: "true", limit: String(limit) });
    const result = await apiGet<ListJobsResult>(`/api/jobs?${query.toString()}`, { signal });
    return result.items ?? [];
}

/**
 * 单个任务（轮询点）。
 *
 * 注意信封里是 `{ job: ... }` 而不是裸 DTO —— `routes/jobs.ts` 的
 * `GET /jobs/:id` 就是 `ok(c, { job })`。直接按 `JobDto` 解包会拿到
 * `undefined.status`，`isTerminalJobStatus` 恒为 false，于是**永远轮询不停**。
 */
export async function getJob(jobId: string, signal?: AbortSignal): Promise<JobDto> {
    const envelope = await apiGet<{ job: JobDto }>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
    return envelope.job;
}

/** 取消任务（只允许自己的、且未终态）。 */
export function cancelJob(jobId: string): Promise<{ job: JobDto }> {
    return apiDelete<{ job: JobDto }>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

/** 轮询选项。 */
export type WaitForJobOptions = {
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
    /** 每次拿到非终态时回调（给 UI 展示 progress / stage 用）。 */
    onProgress?: (job: JobDto) => void;
};

function abortError(): DOMException {
    return new DOMException("Aborted", "AbortError");
}

/**
 * 轮询直到终态。
 *
 * 取消时抛 `AbortError` —— `isGenerationCanceled` 认这个名字，
 * 否则"用户点了停止"会被当成生成失败弹出红字。
 */
export async function waitForJob(jobId: string, options: WaitForJobOptions = {}): Promise<JobDto> {
    const { signal, intervalMs = JOB_POLL_INTERVAL_MS, timeoutMs = JOB_POLL_TIMEOUT_MS, onProgress } = options;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        if (signal?.aborted) throw abortError();

        const job = await getJob(jobId, signal);
        if (isTerminalJobStatus(job.status)) return job;

        onProgress?.(job);
        if (Date.now() >= deadline) {
            throw new Error(`任务 ${jobId} 超过 ${Math.round(timeoutMs / 1000)}s 仍未结束（当前状态：${job.status}）`);
        }

        await sleep(intervalMs, signal);
    }
}

/** 可取消的等待。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
