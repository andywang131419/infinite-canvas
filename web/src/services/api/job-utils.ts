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

import { inferVideoRatio } from "@/lib/media-size";

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
 * **必须稳定，绝不能随机。** 服务端按 `(user_id, idempotency_key)` 唯一
 * （`server/src/jobs/queue.ts` 的 `ux_jobs_idempotency_user`）去重：键相同就返回
 * 已存在的那个 job，而不是再建一个。所以只要同一次生成被重复提交 —— 用户连点两下、
 * 网络层重试了一次 POST、React 重渲染导致提交跑了第二遍 —— 只有稳定键能保证
 * 上游只被调一次。随机键 = 同一张图提交两次 = 上游扣两次费。
 *
 * 注意**恢复路径不重新提交**：它只查 open jobs 再轮询写回（见 `attachOpenJobs`）。
 * 稳定键防的是"同一个动作被提交两次"，不是"刷新后重新提交"。
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
 * `size`（"16:9" / "1920x1080" / "auto" …）→ 视频任务要的 `ratio`。
 *
 * **这个参数必须传**：服务端 `jobs/handlers/video.ts` 里
 * `ratio: readString(params, "ratio")` 是真在用、不是摆设。不传的话服务端拿到空
 * ratio，出来的视频比例可能不对 —— 这是**用户能看见**的质量问题。
 *
 * 与浏览器直连路径里 `services/api/video.ts` 的私有 `videoAspectRatio()` 等价，
 * 但刻意放在这里：它是"给任务拼参数"的纯逻辑、可单测，也不依赖 `video.ts`
 * 那个模块将来还在不在（`video.ts` 已列入清理候选，函数留在里面会被一起删掉）。
 */
export function videoAspectRatioForJob(size: string | null | undefined): string {
    const ratio = inferVideoRatio(size ?? "");
    return ratio === "auto" ? "16:9" : ratio;
}

/** 恢复时，一个**图像**任务的结果该写到哪里。 */
export type ImageWriteTarget =
    /** 批量图节点：写到 `metadata.images` 里这张（定位到了具体 imageId）。 */
    | { kind: "image"; imageId: string }
    /** 单图节点（局部重绘 / 多角度 / 内置面板写回 / 重试）：写到节点本身。 */
    | { kind: "node" }
    /**
     * 有 `images[]` 但**没有安全落点**（最常见：每一张都已经 success）：
     * 调用方必须**什么都不写**，不能退化成"写第一张"。
     */
    | { kind: "skip" }
    /** 节点都找不到了 —— 调用方只能放弃写回。 */
    | null;

/** 判定写回落点时需要的节点最小形状（刻意不 import canvas 类型，避免循环依赖）。 */
type WriteTargetNode = {
    metadata?: {
        images?: readonly { id?: string; jobId?: string | null; status?: string | null }[] | null;
    } | null;
} | null | undefined;

/**
 * 图像任务的结果该写回哪里。
 *
 * 判定顺序（**越靠前越可信**）：
 *   1. `jobId` 精确匹配 —— 这张图就是为这个任务建的
 *   2. 还在 `loading` 的空位
 *   3. `error` 的空位 —— 重试的目标本来就是它
 *   4. 状态为空 / `idle` 的空位
 *   5. 以上都没有 → `skip`
 *
 * **第 2 条刻意不看槽位上有没有旧 jobId。** 批量生成 4 张、第 3 张失败时，
 * 那个槽位会留着上次失败任务的 id；单张重试后刷新，精确匹配按新 jobId 找不到
 * （槽位上还是旧的），如果再要求 `!image.jobId`，这个槽位就被跳过、兜底到
 * `images[0]` —— **重试出来的图会覆盖第 1 张已经成功的图**：钱花两次，好图
 * 还被冲掉。陈旧 jobId 属于那个已经结束的任务，不该阻止新的认领。
 *
 * **兜底绝不能落到 `success` 的槽位上。** 宁可 `skip`（什么都不写、让用户
 * 看到失败），也绝不能冲掉已经生成好的图 —— 覆盖成功结果是不可逆的数据丢失，
 * 而"少写一张"是可以重试的。
 *
 * 没有 `images[]` 就是单图节点（次级入口建的），结果写节点本身。
 *
 * @param job 待写回的任务（需要 `id` 做精确匹配）
 * @param node 任务所属节点，找不到就传 undefined
 */
export function resolveImageWriteTarget(job: { id?: string } | null | undefined, node: WriteTargetNode): ImageWriteTarget {
    if (!node) return null;
    const images = node.metadata?.images || [];
    // 单图节点：结果落在 `metadata.content`，不走 images[]。
    if (!images.length) return { kind: "node" };

    const jobId = job?.id;
    const matched = jobId ? images.find((image) => image.jobId === jobId) : undefined;
    if (matched?.id) return { kind: "image", imageId: matched.id };

    // 剩下的顺序就是"这个槽位还能不能安全地接一张新图"。
    for (const status of ["loading", "error", "idle", undefined, null]) {
        const slot = images.find((image) => image.status === status);
        if (slot?.id) return { kind: "image", imageId: slot.id };
    }
    // 走到这里说明每张图都已经是 success（或其它未知状态）：
    // 没有安全落点，什么都不写。
    return { kind: "skip" };
}

/** 参与配对的任务最小形状（比 `JobDto` 宽，方便单测里手搓）。 */
type PairableJob = { id?: string; createdAt?: string | null };

/** 槽位可接管程度：数字越小越优先。`null` 表示这个槽位不能碰。 */
function slotPriority(status: string | null | undefined): number | null {
    if (status === "loading") return 0;
    if (status === "error") return 1;
    if (status === "idle") return 2;
    if (status === undefined || status === null) return 3;
    // `success` 和任何未知状态都**不能**被接管 —— 覆盖成功结果是不可逆的数据丢失。
    return null;
}

/**
 * **一次性**把 N 个任务配到 N 个空槽位上（P1-1）。
 *
 * 为什么不能对 N 个 job 逐个调 `resolveImageWriteTarget`：批量生成 4 张时，如果
 * 刷新发生在"jobId 写回槽位"之前（画布持久化是防抖的，这个窗口真实存在），
 * 4 个 job 看到的都是同一批"无 jobId 的 loading 槽位"，于是**全部选中第一个** ——
 * 后写的覆盖先写的：3 张结果丢失，而上游照扣 4 次费。
 *
 * 逐个调用时，第一个 job 占了槽位 1 之后，槽位 1 上新增的 jobId 未必已经落盘，
 * 第二个 job 调同一个函数时看到的还是老样子。所以配对必须在**一次调用内**完成，
 * 结果不依赖"上一次的 jobId 是否已持久化"。
 *
 * 配对顺序：先按 jobId 精确匹配；剩下的任务按 `createdAt` 升序（提交顺序）依次
 * 领走剩余的安全槽位。槽位优先级 loading → error → idle/空，`success` 永不参与。
 * 任务比安全槽位多时，多出来的拿 `skip`。
 *
 * @returns 与 `jobs` 等长、下标一一对应的落点数组
 */
export function pairImageWriteTargets(jobs: readonly PairableJob[] | null | undefined, node: WriteTargetNode): ImageWriteTarget[] {
    const list = jobs ?? [];
    if (!node) return list.map(() => null);
    const images = node.metadata?.images || [];
    // 单图节点：结果落在 `metadata.content`，不走 images[]。
    if (!images.length) return list.map(() => ({ kind: "node" }) as ImageWriteTarget);

    const targets: ImageWriteTarget[] = list.map(() => null);
    const claimedSlots = new Set<number>();

    // 1) 精确匹配优先：这张图本来就是为这个任务建的。
    list.forEach((job, index) => {
        if (!job?.id) return;
        const slot = images.findIndex((image, slotIndex) => !claimedSlots.has(slotIndex) && image.jobId === job.id);
        if (slot < 0 || !images[slot].id) return;
        claimedSlots.add(slot);
        targets[index] = { kind: "image", imageId: images[slot].id as string };
    });

    // 2) 剩下的任务按提交顺序领走剩余的安全槽位。
    const safeSlots = images
        .map((image, slotIndex) => ({ slotIndex, priority: slotPriority(image.status), id: image.id }))
        .filter((slot) => slot.priority !== null && Boolean(slot.id))
        .sort((a, b) => (a.priority as number) - (b.priority as number) || a.slotIndex - b.slotIndex)
        .map((slot) => slot.slotIndex);

    const unpaired = list
        .map((job, index) => ({ index, createdAt: job?.createdAt ?? "" }))
        .filter((item) => targets[item.index] === null)
        // createdAt 相同时按下标兜底，保证配对顺序稳定可复现。
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || a.index - b.index);

    let cursor = 0;
    for (const { index } of unpaired) {
        while (cursor < safeSlots.length && claimedSlots.has(safeSlots[cursor])) cursor += 1;
        const slot = cursor < safeSlots.length ? safeSlots[cursor] : undefined;
        if (slot === undefined) {
            // 任务比安全槽位多：没有落点就什么都不写，绝不挤掉任何一张。
            targets[index] = { kind: "skip" };
            continue;
        }
        cursor += 1;
        claimedSlots.add(slot);
        targets[index] = { kind: "image", imageId: images[slot].id as string };
    }

    return targets;
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
