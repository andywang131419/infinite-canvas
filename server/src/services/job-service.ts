/**
 * 任务服务 —— 入队、查询、取消的**唯一**业务入口。
 *
 * `POST /api/jobs` 的 300ms 预算是这个文件存在的核心原因：
 * 路由层只做"取参数 + 调本文件 + 包信封"，而本文件里**没有任何**上游调用，
 * 只有 1 次画布归属查询 + 1 次 INSERT（幂等时是 1 次 SELECT）。
 * 真正的生成发生在 Worker 里（`jobs/worker.ts`）。
 *
 * 参数安全（`jobs.params` 会原样进数据库）：
 * - 禁止出现 `apiKey` / `authorization` 之类的键 —— 密钥只走 channels 表；
 * - 禁止出现 `data:` 内联 base64 —— 参考图必须写成 `storageKey`
 *   （否则一个 tasks 表就能把 8MB 的 doc 反过来再存一遍）。
 */

import { z } from "zod";

import type { SessionUser } from "../auth/session";
import { findCanvasRevision } from "../db/repos/canvases";
import { ApiError } from "../http/errors";
import {
    cancelJob,
    enqueueJob,
    findJobByIdOwned,
    IdempotencyConflictError,
    listJobs,
    listOpenJobsByCanvas,
    type JobRow,
    type JobType,
} from "../jobs/queue";
import { getEnv } from "../env";

/** job type → 渠道能力。 */
const CAPABILITY_BY_TYPE: Record<JobType, "image" | "video" | "audio" | "text"> = {
    image: "image",
    image_edit: "image",
    video: "video",
    audio: "audio",
    llm: "text",
};

/** `jobs.params` 序列化后的上限（64KB：远超正常 prompt，又不会撑爆表）。 */
const MAX_PARAMS_BYTES = 64 * 1024;

/** 幂等键最大长度（前端把请求体哈希塞进来，通常 32~64 字符）。 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** 入队请求体。 */
const createJobSchema = z.object({
    canvasId: z.string().min(1).max(64),
    nodeId: z.string().min(1).max(128),
    type: z.enum(["image", "image_edit", "video", "audio", "llm"]),
    /** 模型名；可省略 —— 省略时由渠道里声明的第一个同能力模型兜底。 */
    model: z.string().max(200).optional(),
    channelId: z.string().min(1).max(64).optional(),
    params: z.unknown().optional(),
    /** 幂等键：同键重复提交只会得到同一个 job（不会重复计费）。 */
    idempotencyKey: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
});

/** 校验后的入队请求。 */
export type CreateJobInput = z.infer<typeof createJobSchema>;

/** 任务 DTO（前端只认这个形状）。 */
export type JobDto = {
    id: string;
    canvasId: string;
    nodeId: string;
    type: string;
    capability: string;
    model: string;
    channelId: string | null;
    status: string;
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

/** 解析并校验入队请求体。 */
export function parseCreateJobBody(body: unknown): CreateJobInput {
    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) {
        throw ApiError.validation(
            "请求体校验失败",
            parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        );
    }
    return parsed.data;
}

/** 行 → DTO。 */
export function toJobDto(row: JobRow): JobDto {
    return {
        id: row.id,
        canvasId: row.canvas_id,
        nodeId: row.node_id,
        type: row.type,
        capability: row.capability,
        model: row.model,
        channelId: row.channel_id,
        status: row.status,
        progress: row.progress,
        stage: row.stage,
        resultStorageKeys: parseStorageKeys(row.result_storage_keys),
        upstreamTaskId: row.upstream_task_id,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        retryable: row.retryable === 1,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at,
    };
}

/** `result_storage_keys` → 字符串数组（脏数据返回空数组）。 */
function parseStorageKeys(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is string => typeof item === "string");
    } catch {
        return [];
    }
}

/** 入队结果。 */
export type CreatedJob = {
    job: JobDto;
    /** false = 命中幂等键，返回的是已有任务（**没有**重复调用上游）。 */
    created: boolean;
};

/**
 * 入队。
 *
 * @throws {ApiError} 400 参数非法 / 404 画布不存在
 */
export function createJobForUser(user: SessionUser, body: unknown): CreatedJob {
    const input = parseCreateJobBody(body);

    // 画布归属校验：任务挂在画布上，越权写入等于给别人的画布塞任务。
    const canvas = findCanvasRevision(user.id, input.canvasId);
    if (!canvas) throw ApiError.notFound("画布不存在");

    const params = normalizeParams(input.params);
    const capability = CAPABILITY_BY_TYPE[input.type];

    const request = {
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        userId: user.id,
        type: input.type,
        capability,
        channelId: input.channelId ?? null,
        model: (input.model ?? "").trim(),
        params,
        idempotencyKey: input.idempotencyKey ?? null,
        maxAttempts: input.maxAttempts ?? getEnv().JOB_MAX_ATTEMPTS,
        priority: input.priority ?? 0,
    };

    try {
        const result = enqueueJob(request);
        return { job: toJobDto(result.job), created: result.created };
    } catch (error) {
        // 幂等键被同一用户的另一个画布/类型占用：409 而不是 200，
        // 否则前端会拿着别的画布的任务 id 一直轮询，永远等不到结果。
        if (error instanceof IdempotencyConflictError) {
            throw new ApiError("IDEMPOTENCY_DUPLICATE", error.message, { jobId: error.jobId, reason: error.reason });
        }
        throw error;
    }
}

/** 列表：`?canvasId=&open=true&limit=`。 */
export function listJobsForUser(user: SessionUser, canvasId: string, openOnly: boolean, limit: number): JobDto[] {
    const canvas = findCanvasRevision(user.id, canvasId);
    if (!canvas) throw ApiError.notFound("画布不存在");

    const rows = openOnly ? listOpenJobsByCanvas(canvasId, limit) : listJobs(canvasId, limit);
    return rows.map(toJobDto);
}

/** 单个任务（限定 owner）。 */
export function getJobForUser(user: SessionUser, jobId: string): JobDto {
    const row = findJobByIdOwned(user.id, jobId);
    if (!row) throw ApiError.notFound("任务不存在");
    return toJobDto(row);
}

/** 取消任务。 */
export function cancelJobForUser(user: SessionUser, jobId: string): JobDto {
    const cancelled = cancelJob(user.id, jobId);
    if (!cancelled) {
        // 区分"不存在"与"已是终态"对前端有意义：后者不该提示"任务不存在"。
        const row = findJobByIdOwned(user.id, jobId);
        if (!row) throw ApiError.notFound("任务不存在");
        throw new ApiError("VALIDATION_FAILED", `任务当前状态为 ${row.status}，无法取消`, { status: row.status });
    }
    return getJobForUser(user, jobId);
}

/**
 * 参数归一与安全校验。
 *
 * 三道闸：
 * 1. 必须是普通对象（数组/字符串说明前端调用错了）；
 * 2. 键名不得出现密钥/鉴权字段，字符串值不得是 `data:` 内联内容；
 * 3. 序列化后不超过 64KB。
 */
export function normalizeParams(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw ApiError.validation("params 必须是对象", { field: "params" });
    }

    const params = raw as Record<string, unknown>;
    assertNoSecretFields(params, "params");

    const encoded = new TextEncoder().encode(JSON.stringify(params));
    if (encoded.byteLength > MAX_PARAMS_BYTES) {
        throw new ApiError("DOC_TOO_LARGE", `params 超过 ${Math.floor(MAX_PARAMS_BYTES / 1024)}KB 上限`, {
            bytes: encoded.byteLength,
        });
    }

    return params;
}

/** 递归扫描禁止字段（最多 6 层，防深嵌套绕过）。 */
function assertNoSecretFields(value: unknown, path: string, depth = 0): void {
    if (depth > 6 || value === null || value === undefined) return;

    if (typeof value === "string") {
        if (value.startsWith("data:") && value.length > 256) {
            throw ApiError.validation(`${path} 不能内联 base64 内容，请先上传为资产并用 storageKey 引用`, { field: path });
        }
        return;
    }

    if (Array.isArray(value)) {
        value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`, depth + 1));
        return;
    }

    if (typeof value !== "object") return;

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (/^(api[_-]?key|authorization|bearer|access[_-]?token|secret)$/i.test(key)) {
            throw ApiError.validation(`${path}.${key} 不允许出现在任务参数里（密钥只存 channels 表）`, { field: `${path}.${key}` });
        }
        assertNoSecretFields(nested, `${path}.${key}`, depth + 1);
    }
}
