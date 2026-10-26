/**
 * 画布服务 —— 乐观锁、doc 清洗、体积闸门的**唯一**执行点。
 *
 * 一次 `PUT /api/canvases/:id` 的完整流水线：
 *
 *   1. 校验 canvasId 形状（前端 nanoid）
 *   2. 校验 body（zod）：`baseRevision` / `doc` / `title?` / `deviceLabel?`
 *   3. `sanitizeCanvasDoc` —— 内联 base64 提取为 asset、`blob:` 置空
 *      （T02 第 4 条；覆盖 `chatSessions[].messages[].references[].dataUrl`）
 *   4. 清洗后重新序列化并量体积 → 超 `MAX_DOC_JSON_MB` 返回 413
 *   5. 写库：
 *      - `baseRevision === 0` → INSERT（`revision` 从 1 开始）
 *      - 否则 → 单条 CAS UPDATE
 *   6. 0 行受影响 → 查一次现状：画布不存在/已删 → 404；否则 409 + `details.latestDoc`
 *
 * 「返回 409 时把最新 doc 一起给前端」是刻意的：前端拿到后可以就地做
 * 三方合并或提示用户刷新，不需要再发一次 GET（弱网下体验差别很大）。
 */

import { z } from "zod";

import {
    countCanvasRows,
    findCanvasDetail,
    findCanvasRevision,
    insertCanvas,
    listCanvases,
    listOpenJobs,
    softDeleteCanvas,
    updateCanvasCas,
    type CanvasRow,
    type CanvasSummaryRow,
    type OpenJobRow,
} from "../db/repos/canvases";
import type { SessionUser } from "../auth/session";
import { getEnv } from "../env";
import { ApiError } from "../http/errors";
import { formatMb } from "../http/request";
import { collectStorageKeys, sanitizeCanvasDoc, type SanitizeStats } from "./doc-sanitizer";
import { createDocIngest } from "./asset-service";

/** 画布 id 形状（前端 `nanoid()` 生成，与 `CanvasProject.id` 一致）。 */
const CANVAS_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 校验 `PUT /api/canvases/:id` 的 body。
 *
 * `doc` 用 `z.unknown()` 收下（它是一整棵任意 JSON 树），
 * 但**必须**是非 null 的普通对象 —— 数组、字符串、null 都说明前端调用错了。
 */
const putCanvasSchema = z.object({
    /** 客户端读到的版本号；`0` 表示"这是新建"。 */
    baseRevision: z.number().int().min(0, "baseRevision 不能为负"),
    /** 整份 CanvasProject。 */
    doc: z.unknown(),
    /** 可选：列表页标题（不传则取 `doc.title`）。 */
    title: z.string().trim().max(200).optional(),
    /** 可选：设备标识，写入 `canvases.updated_by_device`，便于排查"是哪台设备覆盖了"。 */
    deviceLabel: z.string().trim().max(128).optional(),
});

/** 校验后的 body。 */
export type PutCanvasInput = z.infer<typeof putCanvasSchema>;

/** 列表项 DTO。 */
export type CanvasSummaryDto = {
    id: string;
    title: string;
    revision: number;
    nodeCount: number;
    thumbnailAssetId: string | null;
    openJobCount: number;
    createdAt: string;
    updatedAt: string;
};

/** 详情 DTO —— **一次返回 canvas + openJobs**（T02 第 3 条）。 */
export type CanvasDetailDto = CanvasSummaryDto & {
    doc: unknown;
    updatedByDevice: string | null;
};

/** 任务 DTO（T02 只读，字段与 T03 对齐）。 */
export type OpenJobDto = {
    id: string;
    nodeId: string;
    type: string;
    capability: string;
    model: string;
    status: string;
    progress: number;
    stage: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
};

/** 写入结果。 */
export type PutCanvasResult = {
    canvas: CanvasSummaryDto;
    /** 本次写入触发的清洗统计（前端可在 dev 模式下打日志）。 */
    sanitize: SanitizeStats;
    /** 是否新建（true = baseRevision 0 走 INSERT）。 */
    created: boolean;
};

/** `MAX_DOC_JSON_MB` 对应的字节数。 */
export function docByteLimit(): number {
    return getEnv().MAX_DOC_JSON_MB * 1024 * 1024;
}

/** 校验并规范化画布 id（非法 → 400，而不是 404，便于前端尽快发现拼错）。 */
export function requireCanvasId(id: string): string {
    if (!CANVAS_ID_PATTERN.test(id)) {
        throw ApiError.validation("画布 id 非法（只允许 A-Za-z0-9_-，长度 1..64）", { field: "id", value: id.slice(0, 64) });
    }
    return id;
}

/** 解析 body（zod）。 */
export function parsePutCanvasBody(body: unknown): PutCanvasInput {
    const parsed = putCanvasSchema.safeParse(body);
    if (!parsed.success) {
        throw ApiError.validation(
            "请求体校验失败",
            parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        );
    }

    const doc = parsed.data.doc;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw ApiError.validation("doc 必须是 CanvasProject 对象");
    }

    return parsed.data;
}

/** 行 → 列表 DTO。 */
export function toSummaryDto(row: CanvasSummaryRow): CanvasSummaryDto {
    return {
        id: row.id,
        title: row.title,
        revision: row.revision,
        nodeCount: row.node_count,
        thumbnailAssetId: row.thumbnail_asset_id,
        openJobCount: row.open_job_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** 行 → 详情 DTO（doc 反序列化；脏数据不抛错，置空并留白）。 */
export function toDetailDto(row: CanvasRow): CanvasDetailDto {
    return {
        id: row.id,
        title: row.title,
        revision: row.revision,
        nodeCount: row.node_count,
        thumbnailAssetId: row.thumbnail_asset_id,
        openJobCount: 0, // 由调用方用 openJobs.length 覆盖
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        updatedByDevice: row.updated_by_device,
        doc: parseDocOrNull(row.doc),
    };
}

/** 行 → 任务 DTO。 */
export function toJobDto(row: OpenJobRow): OpenJobDto {
    return {
        id: row.id,
        nodeId: row.node_id,
        type: row.type,
        capability: row.capability,
        model: row.model,
        status: row.status,
        progress: row.progress,
        stage: row.stage,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
    };
}

/** doc 文本 → JSON。损坏时返回 null（不让一条脏数据把整个详情接口弄成 500）。 */
export function parseDocOrNull(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        console.warn("[canvas] doc 反序列化失败，返回 null");
        return null;
    }
}

/**
 * 列表（不含 doc）。T02 第 3 条。
 *
 * 分页用 limit/offset；`openJobCount` 由相关子查询实时计算（T02 阶段恒为 0）。
 */
export function getCanvasList(ownerId: string, limit = 100, offset = 0): CanvasSummaryDto[] {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const safeOffset = Math.max(0, Math.trunc(offset));
    return listCanvases(ownerId, safeLimit, safeOffset).map(toSummaryDto);
}

/**
 * 该用户的画布**总数**（不受分页影响）。
 *
 * 供列表接口的 `total` 使用：`total: items.length` 返回的是本页条数，
 * 前端一旦按它做分页就永远只有一页（QA P2-1）。
 */
export function countCanvases(ownerId: string): number {
    return countCanvasRows(ownerId);
}

/**
 * 详情：一次返回 `canvas` + `openJobs`（避免前端"打开画布"要发两个请求，
 * 弱网下能少一个 RTT）。
 *
 * @throws {ApiError} 404 不存在 / 已删除 / 不属于该用户
 */
export function getCanvasDetail(ownerId: string, canvasId: string): { canvas: CanvasDetailDto; openJobs: OpenJobDto[] } {
    const id = requireCanvasId(canvasId);

    const row = findCanvasDetail(ownerId, id);
    if (!row || row.deleted_at !== null) {
        throw ApiError.notFound("画布不存在");
    }

    const openJobs = listOpenJobs(ownerId, id).map(toJobDto);
    const canvas = toDetailDto(row);
    canvas.openJobCount = openJobs.length;

    return { canvas, openJobs };
}

/**
 * 轻量版本探针：**不读 doc**。
 *
 * 用途：前端定时/切回标签页时确认"我手上的 revision 是否还是最新的"，
 * 8MB 的 doc 每次全读会让这个探针失去意义。
 */
export function getCanvasRevision(ownerId: string, canvasId: string): { revision: number; updatedAt: string } {
    const id = requireCanvasId(canvasId);

    const row = findCanvasRevision(ownerId, id);
    if (!row) throw ApiError.notFound("画布不存在");

    return { revision: row.revision, updatedAt: row.updated_at };
}

/**
 * 保存画布（乐观锁）。
 *
 * @throws {ApiError} 400 body 非法 / 413 doc 过大 / 404 画布不存在 / 409 版本冲突
 */
export async function putCanvas(user: SessionUser, canvasId: string, body: unknown): Promise<PutCanvasResult> {
    const id = requireCanvasId(canvasId);
    const input = parsePutCanvasBody(body);

    // ---- doc 清洗（T02 第 4 条）----
    // ingest 为 null 表示"存储不可用"：此时 data URL 会被丢弃而不是写库，
    // 保证「DB 里绝不出现 data:image」这条底线在任何情况下都成立。
    //
    // ⚠️ 新建（baseRevision === 0）时**不能**把画布 id 绑给资产（QA P0-1）：
    // 清洗发生在 `insertCanvas` 之前，而 `assets.canvas_id` 是**立即生效**的外键
    // （`PRAGMA foreign_keys = ON`）。绑定一个尚不存在的画布 id 会让每一次
    // `INSERT INTO assets` 都 `FOREIGN KEY constraint failed`，异常被 tryIngest 吞掉
    // → 图被置空 + `dropped += 1`，但接口仍返回 201：**首次保存必丢图**。
    // `assets.canvas_id` 允许 NULL，且它只是「按画布列举」的便利字段，
    // 不是一致性依据，因此新建阶段直接不绑定。
    const ingest = createDocIngest(user.id, input.baseRevision === 0 ? null : id);
    const { doc: cleaned, stats } = await sanitizeCanvasDoc(input.doc, ingest);

    // ---- 体积闸门（清洗之后量，因为提取 base64 会让 doc 显著变小）----
    const docJson = JSON.stringify(cleaned);
    const docBytes = new TextEncoder().encode(docJson).byteLength;
    const limit = docByteLimit();
    if (docBytes > limit) {
        throw new ApiError("DOC_TOO_LARGE", `画布内容 ${formatMb(docBytes)} 超过上限 ${formatMb(limit)}`, {
            bytes: docBytes,
            limitBytes: limit,
        });
    }

    const title = resolveTitle(input.title, cleaned);
    /** CAS 用标题：`null` 表示"本次请求没带标题，别动库里已有的名字"（QA P2-2）。 */
    const casTitle = resolveTitleOrNull(input.title, cleaned);
    const nodeCount = resolveNodeCount(cleaned);

    // ---- 新建 ----
    if (input.baseRevision === 0) {
        try {
            insertCanvas({
                id,
                ownerId: user.id,
                title,
                doc: docJson,
                nodeCount,
                deviceLabel: input.deviceLabel ?? null,
            });
        } catch (error) {
            // 主键冲突 = 另一台设备已经用同一个 id/或同一份 baseRevision=0 建好了。
            if (isUniqueViolation(error)) {
                throw revisionConflict(user.id, id, 0);
            }
            throw error;
        }

        const created = findCanvasDetail(user.id, id);
        const createdAt = created?.created_at ?? created?.updated_at ?? new Date().toISOString();
        return {
            canvas: {
                id,
                title,
                revision: created?.revision ?? 1,
                nodeCount,
                thumbnailAssetId: created?.thumbnail_asset_id ?? null,
                openJobCount: 0,
                createdAt,
                updatedAt: created?.updated_at ?? createdAt,
            },
            sanitize: stats,
            created: true,
        };
    }

    // ---- 更新（CAS）----
    const updated = updateCanvasCas({
        id,
        ownerId: user.id,
        baseRevision: input.baseRevision,
        doc: docJson,
        nodeCount,
        title: casTitle,
        deviceLabel: input.deviceLabel ?? null,
    });

    if (!updated) throw revisionConflict(user.id, id, input.baseRevision);

    const summary = findCanvasDetail(user.id, id);
    return {
        canvas: {
            id,
            // 没带标题时库里保留原名，响应也要如实回显原名（不能用 "未命名画布" 覆盖）。
            title: summary?.title ?? title,
            revision: updated.revision,
            nodeCount,
            thumbnailAssetId: summary?.thumbnail_asset_id ?? null,
            openJobCount: 0,
            createdAt: summary?.created_at ?? updated.updated_at,
            updatedAt: updated.updated_at,
        },
        sanitize: stats,
        created: false,
    };
}

/**
 * 软删画布。
 *
 * @throws {ApiError} 404 画布不存在
 */
export function deleteCanvas(ownerId: string, canvasId: string): { deleted: true } {
    const id = requireCanvasId(canvasId);

    const changes = softDeleteCanvas(ownerId, id);
    if (changes === 0) {
        // 区分"不存在"与"已删除"对前端没意义，统一 404（幂等语义）。
        throw ApiError.notFound("画布不存在或已删除");
    }

    return { deleted: true };
}

/**
 * 构造 409 冲突错误：把库里**当前最新**的 doc 一起带给前端。
 *
 * 注意顺序：先查画布是否存在，再查最新 doc。
 * - 不存在/已软删 → 404（说明客户端的 baseRevision 指向了一个已被删除的画布）
 * - 存在 → 409 + `details.latestDoc` + `details.latestRevision`
 *
 * 声明为 `never`（同步抛错）：调用点统一写 `throw revisionConflict(...)`，
 * 让控制流分析认可"这条分支不会返回"。
 */
function revisionConflict(ownerId: string, canvasId: string, baseRevision: number): never {
    const current = findCanvasDetail(ownerId, canvasId);
    if (!current || current.deleted_at !== null) {
        throw ApiError.notFound("画布不存在或已删除");
    }

    throw new ApiError("REVISION_CONFLICT", "画布已被另一端更新，请基于最新版本重试", {
        baseRevision,
        latestRevision: current.revision,
        updatedAt: current.updated_at,
        updatedByDevice: current.updated_by_device,
        latestDoc: parseDocOrNull(current.doc),
    });
}

/** 标题推导：显式 title > `doc.title` > 默认值；并截断到 200 字符。 */
function resolveTitle(explicit: string | undefined, doc: unknown): string {
    const fromDoc = readStringField(doc, "title");
    const candidate = explicit?.trim() || fromDoc?.trim() || "未命名画布";
    return candidate.slice(0, 200);
}

/**
 * 更新路径的标题推导：**没有可用的标题时返回 `null`**（QA P2-2）。
 *
 * 语义差别很关键：新建必须有一个标题（`canvases.title` 是 NOT NULL），
 * 但更新时"请求没带 title、`doc.title` 也缺失"绝不意味着"把标题改成未命名画布"。
 * 原先无条件 `title = ?` 会静默**覆盖用户已经起好的名字**。
 * 返回 `null` 后由 SQL 的 `COALESCE(?, title)` 保留原值。
 */
function resolveTitleOrNull(explicit: string | undefined, doc: unknown): string | null {
    const fromDoc = readStringField(doc, "title");
    const candidate = explicit?.trim() || fromDoc?.trim();
    if (!candidate) return null;
    return candidate.slice(0, 200);
}

/** 节点数推导（`doc.nodes.length`）。 */
function resolveNodeCount(doc: unknown): number {
    if (!doc || typeof doc !== "object") return 0;
    const nodes = (doc as { nodes?: unknown }).nodes;
    return Array.isArray(nodes) ? nodes.length : 0;
}

/** 读对象上的字符串字段。 */
function readStringField(value: unknown, key: string): string | null {
    if (!value || typeof value !== "object") return null;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : null;
}

/** 判断是否是唯一约束冲突（bun:sqlite 与 node:sqlite 的报错文案都含这个前缀）。 */
function isUniqueViolation(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /UNIQUE constraint failed/i.test(message) || /SQLITE_CONSTRAINT/i.test(message);
}

/**
 * 保存后自检：doc 里引用的 storageKey 是否有对应的资产行。
 *
 * 只记 warning 不阻塞 —— 上游历史数据本来就可能有悬空 key
 * （见 BASE-SURVEY §4.7 第 1、2 条：CORS 不可读的远程图没有 storageKey）。
 * T05 的孤儿/悬空清理任务会消费这些信息。
 */
export function auditStorageKeys(doc: unknown, knownKeys: Set<string>): string[] {
    const referenced = collectStorageKeys(doc);
    const missing: string[] = [];
    for (const key of referenced) {
        if (!knownKeys.has(key)) missing.push(key);
    }
    return missing;
}
