/**
 * canvases / jobs（只读部分）仓储。
 *
 * 这一层只负责「SQL ↔ 对象」与「CAS 是否命中」的事实判定，
 * **不做**任何 HTTP 语义决定（404 还是 409 由 service 层判断）。
 */

import { getDb } from "../client";
import {
    SQL_INSERT_CANVAS,
    SQL_SELECT_CANVAS_DETAIL,
    SQL_SELECT_CANVAS_LIST,
    SQL_SELECT_CANVAS_REVISION,
    SQL_SELECT_OPEN_JOBS,
    SQL_SOFT_DELETE_CANVAS,
    SQL_UPDATE_CANVAS_CAS,
} from "./canvas-sql";

/** 画布完整行（含 doc）。 */
export type CanvasRow = {
    id: string;
    owner_id: string;
    title: string;
    doc: string;
    revision: number;
    node_count: number;
    thumbnail_asset_id: string | null;
    updated_by_device: string | null;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
};

/** 列表行（不含 doc，带 openJobCount）。 */
export type CanvasSummaryRow = {
    id: string;
    title: string;
    revision: number;
    node_count: number;
    thumbnail_asset_id: string | null;
    created_at: string;
    updated_at: string;
    open_job_count: number;
};

/** 未完成任务行（T02 只读，写入在 T03）。 */
export type OpenJobRow = {
    id: string;
    node_id: string;
    type: string;
    capability: string;
    model: string;
    status: string;
    progress: number;
    stage: string | null;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
    started_at: string | null;
    updated_at: string;
};

/** 版本探针结果。 */
export type CanvasRevisionRow = { revision: number; updated_at: string };

/** 建画布入参。 */
export type InsertCanvasInput = {
    /** 前端生成的 `CanvasProject.id`（nanoid）。 */
    id: string;
    ownerId: string;
    title: string;
    /** 已序列化的 doc JSON 字符串。 */
    doc: string;
    nodeCount: number;
    deviceLabel?: string | null;
};

/**
 * 新建画布（`revision` 从 1 开始）。
 *
 * @throws 主键冲突时抛出（调用方应把它翻译成 409）。
 */
export function insertCanvas(input: InsertCanvasInput): void {
    const now = new Date().toISOString();
    getDb()
        .query(SQL_INSERT_CANVAS)
        .run(input.id, input.ownerId, input.title, input.doc, input.nodeCount, input.deviceLabel ?? null, now, now);
}

/** CAS 更新入参。 */
export type UpdateCanvasCasInput = {
    id: string;
    ownerId: string;
    /** 客户端读到的版本号；只有等于库里当前 revision 才会写成功。 */
    baseRevision: number;
    /** 清洗后、已序列化的 doc JSON 字符串。 */
    doc: string;
    nodeCount: number;
    title: string;
    deviceLabel?: string | null;
};

/**
 * **乐观锁写入**（T02 验收点 3）。
 *
 * 整条语句是 `SQL_UPDATE_CANVAS_CAS`（单条 UPDATE + WHERE revision = ?），
 * 因此并发安全来自 SQLite 本身，而不是应用层加锁。
 *
 * @returns 命中时返回新版本；`null` 表示 0 行受影响（版本冲突或画布不存在/已删）。
 */
export function updateCanvasCas(input: UpdateCanvasCasInput): CanvasRevisionRow | null {
    const now = new Date().toISOString();
    const row = getDb()
        .query(SQL_UPDATE_CANVAS_CAS)
        .get(
            input.doc,
            input.nodeCount,
            input.title,
            input.deviceLabel ?? null,
            now,
            input.id,
            input.ownerId,
            input.baseRevision,
        ) as CanvasRevisionRow | null;

    return row ?? null;
}

/** 读完整画布（含 doc）。找不到（或不属于该用户）返回 `null`。 */
export function findCanvasDetail(ownerId: string, id: string): CanvasRow | null {
    return (getDb().query(SQL_SELECT_CANVAS_DETAIL).get(id, ownerId) as CanvasRow | null) ?? null;
}

/** 轻量版本探针（不读 doc）。 */
export function findCanvasRevision(ownerId: string, id: string): CanvasRevisionRow | null {
    return (getDb().query(SQL_SELECT_CANVAS_REVISION).get(id, ownerId) as CanvasRevisionRow | null) ?? null;
}

/** 列表（不含 doc，按 updated_at 倒序）。 */
export function listCanvases(ownerId: string, limit = 100, offset = 0): CanvasSummaryRow[] {
    return getDb().query(SQL_SELECT_CANVAS_LIST).all(ownerId, limit, offset) as CanvasSummaryRow[];
}

/**
 * 软删。
 *
 * @returns 实际更新行数：0 表示不存在、不属于该用户、或已删除（幂等）。
 */
export function softDeleteCanvas(ownerId: string, id: string): number {
    const now = new Date().toISOString();
    const result = getDb().query(SQL_SOFT_DELETE_CANVAS).run(now, now, id, ownerId);
    return Number(result.changes);
}

/** 该画布未完成的任务（详情接口一次返回）。 */
export function listOpenJobs(canvasId: string): OpenJobRow[] {
    return getDb().query(SQL_SELECT_OPEN_JOBS).all(canvasId) as OpenJobRow[];
}
