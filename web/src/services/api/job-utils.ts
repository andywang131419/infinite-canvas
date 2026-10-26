/**
 * 任务（job）相关的**纯逻辑**（T04-B 阶段 1）。
 *
 * 为什么单独成文件、不写在组件里：
 * `project.tsx` 是 198KB 的组件，生成流程里全是 setState 与 ref，没法被单测。
 * 而下面这两处恰恰是最不能出错的：
 *   - 幂等键不稳定 → 刷新恢复时同一张图重复提交 → **重复扣费**（真金白银）；
 *   - 状态映射写错 → 节点永远停在 loading，或者把还在跑的任务标成失败。
 * 抽出来之后它们可以被 `bun test` 真实执行。
 */

/** 服务端 job 状态（与 `jobs` 表的 CHECK 约束一致）。 */
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** 本轮（阶段 1：image 分支）接管的 job 类型。 */
export const IMAGE_JOB_TYPES = ["image", "image_edit"] as const;

/** 画布节点状态（与本文件解耦，避免引入 canvas 类型导致循环依赖）。 */
export type NodeStatusFromJob = "loading" | "success" | "error";

/** 终态：到了这里就不必再轮询。 */
export function isTerminalJobStatus(status: string | null | undefined): boolean {
    return status === "succeeded" || status === "failed" || status === "canceled";
}

/** 是否本轮接管的图像类任务（阶段 2 接入 video/audio/text 后再扩）。 */
export function isImageJobType(type: string | null | undefined): boolean {
    return (IMAGE_JOB_TYPES as readonly string[]).includes(type ?? "");
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
 * job 状态 → 画布节点状态。
 *
 * 只有 `succeeded` 是 success，`failed` / `canceled` 是 error，
 * 其余（含任何未知状态）一律按 **loading** 处理 —— 未知状态当成失败会
 * 让"其实还在排队"的图被标红，比多转两圈严重。
 */
export function mapJobStatusToNodeStatus(status: string | null | undefined): NodeStatusFromJob {
    if (status === "succeeded") return "success";
    if (status === "failed" || status === "canceled") return "error";
    return "loading";
}

/** 从任务结果里挑出第一个**图片** storageKey；没有则 null。 */
export function firstImageStorageKey(keys: readonly string[] | null | undefined): string | null {
    if (!keys) return null;
    for (const key of keys) {
        if (typeof key === "string" && key.startsWith("image:")) return key;
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
