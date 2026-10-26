/**
 * assets 仓储 —— 内容寻址资产元数据。
 *
 * 双重唯一约束决定了本层的语义（0001_init.sql:240-241）：
 * - `ux_assets_storage_key (storage_key)`：一个逻辑键只对应一行；
 * - `ux_assets_sha256_driver (sha256, storage_driver)`：同驱动下同内容只落一行。
 *
 * 因此"写资产"一律是 **INSERT OR IGNORE + 回读**：
 * - 同 key 同内容重复 PUT → 幂等成功（返回已有行）；
 * - 同 key 不同内容 → 由 service 层判定为 409（键被别的图片占了）；
 * - 不同 key 同内容 → 命中 sha 唯一约束，回读后把 key 视为别名（T02 直接把已有
 *   storage_key 返回，避免同一张图出现两个可写键）。
 */

import { getDb } from "../client";

/** assets 行。 */
export type AssetRow = {
    id: string;
    owner_id: string;
    canvas_id: string | null;
    job_id: string | null;
    kind: "image" | "video" | "audio" | "file";
    storage_driver: string;
    storage_key: string;
    mime: string;
    bytes: number;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    sha256: string;
    prompt: string | null;
    model: string | null;
    meta: string | null;
    created_at: string;
};

/** 建资产入参。 */
export type InsertAssetInput = {
    ownerId: string;
    canvasId?: string | null;
    jobId?: string | null;
    kind: "image" | "video" | "audio" | "file";
    storageDriver: string;
    storageKey: string;
    mime: string;
    bytes: number;
    sha256: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    prompt?: string | null;
    model?: string | null;
    /** 任意附加信息（JSON 字符串），T02 用来记物理相对路径便于排障。 */
    meta?: string | null;
    /** 创建时间（决定物理路径分桶，必须与写入驱动时用的时间一致）。 */
    createdAt: string;
};

const SQL_INSERT_ASSET = `
INSERT OR IGNORE INTO assets
    (id, owner_id, canvas_id, job_id, kind, storage_driver, storage_key, mime, bytes,
     width, height, duration_ms, sha256, prompt, model, meta, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SQL_SELECT_ASSET_BY_KEY = `
SELECT id, owner_id, canvas_id, job_id, kind, storage_driver, storage_key, mime, bytes,
       width, height, duration_ms, sha256, prompt, model, meta, created_at
  FROM assets
 WHERE storage_key = ?
`;

const SQL_SELECT_ASSET_BY_SHA = `
SELECT id, owner_id, canvas_id, job_id, kind, storage_driver, storage_key, mime, bytes,
       width, height, duration_ms, sha256, prompt, model, meta, created_at
  FROM assets
 WHERE sha256 = ? AND storage_driver = ?
`;

const SQL_SELECT_ASSET_BY_ID = `
SELECT id, owner_id, canvas_id, job_id, kind, storage_driver, storage_key, mime, bytes,
       width, height, duration_ms, sha256, prompt, model, meta, created_at
  FROM assets
 WHERE id = ?
`;

const SQL_DELETE_ASSET_BY_KEY = `DELETE FROM assets WHERE storage_key = ? AND owner_id = ?`;

/**
 * 按画布列举资产。
 *
 * **owner 过滤下沉到 SQL**（QA P2-6）：`assets.canvas_id` 是"按画布列举"的便利字段，
 * 本身不带归属语义。仅按 `canvas_id` 查会让安全性完全依赖调用方先做归属校验，
 * 因此这里 JOIN `canvases` 并显式比对 `owner_id`。
 *
 * 参数顺序：1. owner_id  2. canvas_id
 */
const SQL_LIST_ASSETS_BY_CANVAS = `
SELECT a.id, a.owner_id, a.canvas_id, a.job_id, a.kind, a.storage_driver, a.storage_key, a.mime, a.bytes,
       a.width, a.height, a.duration_ms, a.sha256, a.prompt, a.model, a.meta, a.created_at
  FROM assets a
  JOIN canvases c ON c.id = a.canvas_id AND c.owner_id = ?
 WHERE a.canvas_id = ?
 ORDER BY a.created_at ASC
`;

/**
 * 写入（幂等）并回读。
 *
 * @returns 最终生效的行（可能是本次插入的，也可能是内容去重命中的既有行）。
 */
export function upsertAsset(input: InsertAssetInput): AssetRow {
    const db = getDb();

    db.query(SQL_INSERT_ASSET).run(
        crypto.randomUUID(),
        input.ownerId,
        input.canvasId ?? null,
        input.jobId ?? null,
        input.kind,
        input.storageDriver,
        input.storageKey,
        input.mime,
        input.bytes,
        input.width ?? null,
        input.height ?? null,
        input.durationMs ?? null,
        input.sha256,
        input.prompt ?? null,
        input.model ?? null,
        input.meta ?? null,
        input.createdAt,
    );

    // 先按 key 回读：同 key 重复 PUT 时在这里命中，语义最直观。
    // 若既有的 sha256 与本次不同，说明"这个键已被别的内容占用"，
    // 本层只如实返回既有行，由 service 层判定为 409。
    const byKey = findAssetByStorageKey(input.storageKey);
    if (byKey) return byKey;

    // key 未命中 → 可能是同内容不同 key（内容去重）。回读后把已有 key 视为规范键。
    const bySha = findAssetBySha(input.sha256, input.storageDriver);
    if (bySha) return bySha;

    throw new Error(`资产写入后无法回读（key=${input.storageKey}, sha256=${input.sha256}）`);
}

/** 按逻辑键查。 */
export function findAssetByStorageKey(storageKey: string): AssetRow | null {
    return (getDb().query(SQL_SELECT_ASSET_BY_KEY).get(storageKey) as AssetRow | null) ?? null;
}

/** 按内容查（用于判断"这份内容是否已经存过"）。 */
export function findAssetBySha(sha256: string, storageDriver: string): AssetRow | null {
    return (getDb().query(SQL_SELECT_ASSET_BY_SHA).get(sha256, storageDriver) as AssetRow | null) ?? null;
}

/** 按 id 查。 */
export function findAssetById(id: string): AssetRow | null {
    return (getDb().query(SQL_SELECT_ASSET_BY_ID).get(id) as AssetRow | null) ?? null;
}

/**
 * 删除元数据（不删物理文件）。
 *
 * 物理文件是内容寻址的，可能被别的 key 共享，因此**只能**在确认
 * 没有其它行引用同一 sha256 时才允许删盘 —— 该判断留给 T05 的清理任务。
 *
 * @returns 实际删除行数。
 */
export function deleteAssetByStorageKey(ownerId: string, storageKey: string): number {
    const result = getDb().query(SQL_DELETE_ASSET_BY_KEY).run(storageKey, ownerId);
    return Number(result.changes);
}

/** 列出某画布下的资产（仅该 owner 的）。 */
export function listAssetsByCanvas(ownerId: string, canvasId: string): AssetRow[] {
    return getDb().query(SQL_LIST_ASSETS_BY_CANVAS).all(ownerId, canvasId) as AssetRow[];
}

/** 统计同一内容被多少行引用（决定能否删物理文件）。 */
export function countAssetsBySha(sha256: string, storageDriver: string): number {
    const row = getDb()
        .query("SELECT COUNT(*) AS total FROM assets WHERE sha256 = ? AND storage_driver = ?")
        .get(sha256, storageDriver) as { total: number } | null;
    return row?.total ?? 0;
}
