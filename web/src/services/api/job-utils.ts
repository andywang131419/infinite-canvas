/**
 * 任务（job）相关的**纯逻辑**（T04-B）。
 *
 * 为什么单独成文件、不写在组件里：
 * `project.tsx` 是 198KB 的组件，生成流程里全是 setState 与 ref，没法被单测。
 * 而下面这两处恰恰是最不能出错的：
 *   - 幂等键不稳定 → 刷新恢复时同一份生成重复提交 → **重复扣费**（真金白银）；
 *   - 状态映射写错 → 节点永远停在 loading，或者把还在跑的任务标成失败。
 * 抽出来之后它们可以被 `bun test` 真实执行。
 */

/** 服务端 job 状态（与 `jobs` 表的 CHECK 约束一致）。 */
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** 图像类任务类型。 */
export const IMAGE_JOB_TYPES = ["image", "image_edit"] as const;

/** 音频类任务类型。 */
export const AUDIO_JOB_TYPES = ["audio"] as const;

/** 视频类任务类型。 */
export const VIDEO_JOB_TYPES = ["video"] as const;

/**
 * 画布生成里**接队列**的任务类型（阶段 1：image；阶段 2：+ audio/video）。
 *
 * 刻意**不含** `llm`：画布的文本节点走浏览器直连流式输出，
 * 队列是"提交 → 轮询结果"，没有 delta 通道，接上去会丢掉逐字输出
 * （结论与理由见阶段 2 报告）。恢复逻辑因此也不回收 llm 任务。
 */
export const RECOVERABLE_JOB_TYPES = [...IMAGE_JOB_TYPES, ...AUDIO_JOB_TYPES, ...VIDEO_JOB_TYPES] as const;

/** 画布节点状态（与本文件解耦，避免引入 canvas 类型导致循环依赖）。 */
export type NodeStatusFromJob = "loading" | "success" | "error";

/** 终态：到了这里就不必再轮询。 */
export function isTerminalJobStatus(status: string | null | undefined): boolean {
    return status === "succeeded" || status === "failed" || status === "canceled";
}

/** 是否图像类任务。 */
export function isImageJobType(type: string | null | undefined): boolean {
    return (IMAGE_JOB_TYPES as readonly string[]).includes(type ?? "");
}

/** 是否音频类任务。 */
export function isAudioJobType(type: string | null | undefined): boolean {
    return (AUDIO_JOB_TYPES as readonly string[]).includes(type ?? "");
}

/** 是否视频类任务。 */
export function isVideoJobType(type: string | null | undefined): boolean {
    return (VIDEO_JOB_TYPES as readonly string[]).includes(type ?? "");
}

/**
 * 是否在画布恢复范围内（image / audio / video）。
 *
 * `llm` 不在内 —— 它没有走队列，服务端也就没有它的未完成任务可恢复。
 */
export function isRecoverableJobType(type: string | null | undefined): boolean {
    return (RECOVERABLE_JOB_TYPES as readonly string[]).includes(type ?? "");
}

/**
 * 图像任务的幂等键。
 *
 * **必须稳定，绝不能随机**：刷新页面后走的是"先查 open jobs 再 attach"的恢复路径，
 * 但如果查不到（比如画布还没同步上去），会退化成重新提交 —— 此时只有稳定的键
 * 才能让服务端按 `(user_id, idempotency_key)` 去重（`server/src/jobs/queue.ts`
 * 的 `ux_jobs_idempotency_user`），返回已存在的那个 job 而不是再建一个。
 * 随机键 = 同一张图提交两次 = 上游扣两次费。
 *
 * 粒度是 **每张图一个 job**：一次"生成 4 张"会产生 4 个 imageId，
 * 其中 2 张失败时要能单独重试那 2 张，所以 `nodeId` 只作归组键
 * （服务端 `jobs.node_id` 列），键里必须带上 `imageId`。
 *
 * @param nodeId 图片所在节点 id（归组键，不是来源节点）
 * @param imageId 这张图在 `metadata.images` 里的 id
 */
export function buildImageJobIdempotencyKey(nodeId: string, imageId: string): string {
    return `${nodeId}:${imageId}`;
}

/**
 * 音频任务的幂等键。
 *
 * 音频节点一次只出一条，没有"第几张"这样的子项 id，所以第二个参数是
 * **每次生成动作的新种子**（`metadata.jobKey`）。
 *
 * 为什么不能只用 `nodeId`：服务端幂等是"键存在就直接返回已有任务"，
 * **不看任务是否已终态**（`queue.ts: enqueueJob`）。只用 nodeId 的话，
 * 用户对同一个音频节点点"重新生成"会拿回上一次那个已完成的 job ——
 * 界面转一圈，出来的还是旧的音频，而用户以为重新生成了。
 *
 * @param nodeId 音频节点 id
 * @param jobKey 本次生成的种子（随节点持久化，同一动作内不变）
 */
export function buildAudioJobIdempotencyKey(nodeId: string, jobKey: string): string {
    return `${nodeId}:${jobKey}`;
}

/**
 * 视频任务的幂等键。规则与音频完全一致，理由同上。
 *
 * @param nodeId 视频节点 id
 * @param jobKey 本次生成的种子（随节点持久化，同一动作内不变）
 */
export function buildVideoJobIdempotencyKey(nodeId: string, jobKey: string): string {
    return `${nodeId}:${jobKey}`;
}

/**
 * job 状态 → 画布节点状态。
 *
 * 只有 `succeeded` 是 success，`failed` / `canceled` 是 error，
 * 其余（含任何未知状态）一律按 **loading** 处理 —— 未知状态当成失败会
 * 让"其实还在排队"的图被标红，比多转一圈严重。
 */
export function mapJobStatusToNodeStatus(status: string | null | undefined): NodeStatusFromJob {
    if (status === "succeeded") return "success";
    if (status === "failed" || status === "canceled") return "error";
    return "loading";
}

/** 从任务结果里挑出第一个**图片** storageKey；没有则 null。 */
export function firstImageStorageKey(keys: readonly string[] | null | undefined): string | null {
    return firstStorageKeyWithPrefix(keys, "image:");
}

/** 从任务结果里挑出第一个带指定命名空间前缀的 storageKey；没有则 null。 */
export function firstStorageKeyWithPrefix(keys: readonly string[] | null | undefined, prefix: string): string | null {
    if (!keys) return null;
    for (const key of keys) {
        if (typeof key === "string" && key.startsWith(prefix)) return key;
    }
    return null;
}

/**
 * job 失败时给用户的文案。
 *
 * 服务端 `error_message` 是英文/上游原文，`error_code` 是机器码。
 * 都拿不到时返回空串，调用方回落到本地兜底文案。
 */
export function jobErrorMessage(job: { errorMessage?: string | null; errorCode?: string | null } | null | undefined): string {
    if (!job) return "";
    return (job.errorMessage || job.errorCode || "").trim();
}
