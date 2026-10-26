/**
 * 资产服务 —— 逻辑键（storageKey）↔ 内容寻址对象 的映射与读写。
 *
 * 全链路（T02 第 5 条）：
 *
 *   PUT /api/assets?key=image:xxxx   （body 是原始字节）
 *     → parseStorageKey（拒绝 `..`、绝对路径、非法字符，**落盘前**就 400）
 *     → sha256(bytes)
 *     → 内容已存在？是 → 直接复用既有行（不再写盘）
 *     → 否则 storage.put() 走 `{yyyy}/{mm}/{sha256}.{ext}` + 原子 rename
 *     → assets 表写一行（逻辑键 ↔ sha256）
 *
 *   GET /api/assets/raw?key=image:xxxx
 *     → 查行拿到 sha256/mime/created_at
 *     → 推导物理路径 → storage.get(range) → 206 + Content-Range + ETag
 *
 * 关键安全不变量：**用户给的 key 永远不参与文件路径拼接**。
 * 路径只由「数据库里的 sha256 + mime + created_at」推导，
 * 所以即使 key 校验被绕过，也无法读到存储根目录之外的任何文件。
 */

import { createHash } from "node:crypto";

import {
    countAssetsBySha,
    deleteAssetByStorageKey,
    findAssetBySha,
    findAssetByStorageKey,
    upsertAsset,
    type AssetRow,
} from "../db/repos/assets";
import { getEnv } from "../env";
import { ApiError } from "../http/errors";
import { formatMb, parseRangeHeader } from "../http/request";
import { getStorageDriver } from "../storage";
import { deriveObjectRelPath, generateStorageKey, kindFromPrefix, parseStorageKey, type StorageKeyPrefix } from "../storage/key";
import { StorageObjectNotFoundError, StorageRangeError } from "../storage/types";
import type { IngestedAsset } from "./doc-sanitizer";
import { canonicalAssetMime, OCTET_STREAM_MIME } from "./mime-whitelist";

/** 资产种类（与 `assets.kind` 的 CHECK 约束一致）。 */
type AssetKind = "image" | "video" | "audio" | "file";

/** 把 storageKey 前缀映射回"新建资产时该用的前缀"。 */
function prefixForMime(mime: string, fallback: StorageKeyPrefix = "image"): StorageKeyPrefix {
    const base = (mime || "").toLowerCase();
    if (base.startsWith("image/")) return "image";
    if (base.startsWith("video/")) return "video";
    if (base.startsWith("audio/")) return "audio";
    if (base.length > 0) return "file";
    return fallback;
}

/**
 * 由「storageKey 前缀 + 归一后的 MIME」决定 `assets.kind`。
 *
 * 规则（QA P0-2 的落地）：**MIME 被归一成 octet-stream 时一律 `kind=file`**。
 * 否则会出现「`kind=image` 但实际内容是 HTML」这种自相矛盾的行，
 * 未来任何按 `kind` 决定"能不能内联展示"的代码都会踩到它。
 */
function kindFor(prefix: StorageKeyPrefix, mime: string): AssetKind {
    if (mime === OCTET_STREAM_MIME) return "file";
    return kindFromPrefix(prefix);
}

/** sha256（十六进制）。与驱动内部算法一致，便于"先算哈希再决定要不要写盘"。 */
function sha256Of(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 把一小段二进制收进存储并登记，返回逻辑键。
 *
 * 供 doc 清洗（内联 base64）与 T03 的上游生成结果复用。
 *
 * @param ownerId 归属用户（多租户隔离的依据）。
 * @param payload MIME + 字节。
 * @param canvasId 可选：把资产关联到画布，便于按画布列举。
 */
export async function ingestAssetBytes(
    ownerId: string,
    payload: { mime: string; bytes: Uint8Array },
    canvasId?: string | null,
): Promise<IngestedAsset> {
    const sha256 = sha256Of(payload.bytes);
    const driver = getStorageDriver();

    // 白名单在**落盘之前**生效：内容来自 doc 内联 base64 或 T03 上游响应，
    // 上游/客户端声明的类型不可信（QA P0-2）。非白名单 → octet-stream + kind=file。
    const mime = canonicalAssetMime(payload.mime) ?? OCTET_STREAM_MIME;

    // ---- 1. 先按内容查：同内容只落一份 ----
    const existing = findAssetBySha(sha256, driver.name);
    if (existing) {
        return { storageKey: existing.storage_key, sha256: existing.sha256, bytes: existing.bytes, mime: existing.mime };
    }

    // ---- 2. 落盘（内容寻址）----
    const createdAt = new Date().toISOString();
    const prefix = prefixForMime(mime);
    const storageKey = generateStorageKey(prefix);

    const written = await driver.put({ bytes: payload.bytes, mime, createdAt });

    // ---- 3. 登记元数据 ----
    upsertAsset({
        ownerId,
        canvasId: canvasId ?? null,
        kind: kindFor(prefix, mime),
        storageDriver: driver.name,
        storageKey,
        mime: written.mime,
        bytes: written.bytes,
        sha256: written.sha256,
        createdAt,
        meta: JSON.stringify({ relPath: written.relPath }),
    });

    return { storageKey, sha256: written.sha256, bytes: written.bytes, mime: written.mime };
}

/** 供 doc 清洗使用的 ingest 回调（保持 IngestFn 签名）。 */
export function createDocIngest(ownerId: string, canvasId: string | null) {
    return (payload: { mime: string; bytes: Uint8Array }): Promise<IngestedAsset> => ingestAssetBytes(ownerId, payload, canvasId);
}

/**
 * `PUT /api/assets?key=` 的服务实现。
 *
 * @param ownerId 归属用户。
 * @param rawKey 查询参数里的 key（未校验）。
 * @param bytes 请求体原始字节。
 * @param declaredMime `Content-Type` 头。
 * @param canvasId 可选归属画布。
 * @throws {ApiError} 400 非法 key / 413 超出 `MAX_UPLOAD_MB` / 409 键被占用
 */
export async function putAsset(
    ownerId: string,
    rawKey: string | undefined,
    bytes: Uint8Array,
    declaredMime: string,
    canvasId?: string | null,
): Promise<AssetRow> {
    const env = getEnv();

    // ---- 校验 1：key 合法性（**必须在任何写盘动作之前**）----
    const parsed = requireStorageKey(rawKey);

    // ---- 校验 2：体积 ----
    const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
    if (bytes.byteLength === 0) throw ApiError.validation("上传内容为空");
    if (bytes.byteLength > maxBytes) {
        throw new ApiError("DOC_TOO_LARGE", `资产 ${formatMb(bytes.byteLength)} 超过上限 ${formatMb(maxBytes)}`);
    }

    const mime = normalizeMime(declaredMime, parsed.prefix);
    const sha256 = sha256Of(bytes);
    const driver = getStorageDriver();

    // ---- 校验 3：同一个 key 不允许装两份不同内容 ----
    const byKey = findAssetByStorageKey(parsed.raw);
    if (byKey) {
        if (byKey.sha256 === sha256) return byKey; // 幂等重传
        throw new ApiError("IDEMPOTENCY_DUPLICATE", "该 storageKey 已被另一份内容占用，请换一个 key");
    }

    // ---- 内容去重：同内容已在别处，直接复用（不再写盘）----
    const bySha = findAssetBySha(sha256, driver.name);
    if (bySha) {
        // 返回规范行（其 storageKey 是首次落库时生成的键），
        // 客户端应以响应里的 storageKey 为准。
        return bySha;
    }

    const createdAt = new Date().toISOString();
    const written = await driver.put({ bytes, mime, createdAt });

    return upsertAsset({
        ownerId,
        canvasId: canvasId ?? null,
        kind: kindFor(parsed.prefix, mime),
        storageDriver: driver.name,
        storageKey: parsed.raw,
        mime: written.mime,
        bytes: written.bytes,
        sha256: written.sha256,
        createdAt,
        meta: JSON.stringify({ relPath: written.relPath }),
    });
}

/** 读取结果（供路由组装 HTTP 响应）。 */
export type OpenedAsset = {
    row: AssetRow;
    /** 完整对象大小（用于 Content-Range）。 */
    size: number;
    /** 本次返回的字节流。 */
    stream: ReadableStream<Uint8Array>;
    /** 本次区间（开区间）。 */
    range: { start: number; end?: number };
    /** 是否为部分响应（206）。 */
    partial: boolean;
};

/**
 * `GET /api/assets/raw?key=` 的服务实现（支持 Range）。
 *
 * @param rangeHeader 原始 `Range` 请求头。
 * @throws {ApiError} 400 非法 key / 404 不存在或不属于该用户 / 416 区间不可满足
 */
export async function openAsset(ownerId: string, rawKey: string | undefined, rangeHeader: string | undefined): Promise<OpenedAsset> {
    const parsed = requireStorageKey(rawKey);

    const row = findAssetByStorageKey(parsed.raw);
    // 不区分"不存在"和"不是你的" —— 否则就成了枚举他人资产的探测接口。
    if (!row || row.owner_id !== ownerId) {
        throw new ApiError("NOT_FOUND", "资产不存在");
    }

    const driver = getStorageDriver();
    const relPath = relPathFor(row);
    const stat = await driver.stat(relPath);
    if (!stat) {
        throw new ApiError("NOT_FOUND", "资产文件已丢失（元数据存在但磁盘上找不到）", { storageKey: row.storage_key, relPath });
    }

    const size = stat.bytes;
    const requested = parseRangeHeader(rangeHeader, size);
    if (requested === "unsatisfiable") {
        throw new ApiError("RANGE_NOT_SATISFIABLE", "请求的字节范围不可满足", { size });
    }

    try {
        const body = await driver.get(relPath, requested ?? undefined);
        return {
            row,
            size,
            stream: body.stream,
            range: body.range,
            partial: requested !== null,
        };
    } catch (error) {
        if (error instanceof StorageRangeError) {
            throw new ApiError("RANGE_NOT_SATISFIABLE", "请求的字节范围不可满足", { size });
        }
        if (error instanceof StorageObjectNotFoundError) {
            throw new ApiError("NOT_FOUND", "资产文件已丢失");
        }
        throw error;
    }
}

/**
 * 删除资产：先删元数据行，确认没有其它行引用同一内容后再删物理文件。
 *
 * 顺序不能反：先删文件再删行的话，"删行失败"会留下悬空元数据，
 * 对前端表现为永久 404 但列表里还在。
 */
export async function removeAsset(ownerId: string, rawKey: string | undefined): Promise<boolean> {
    const parsed = requireStorageKey(rawKey);

    const row = findAssetByStorageKey(parsed.raw);
    if (!row || row.owner_id !== ownerId) return false;

    const removed = deleteAssetByStorageKey(ownerId, parsed.raw) > 0;
    if (!removed) return false;

    const driver = getStorageDriver();
    if (countAssetsBySha(row.sha256, row.storage_driver) === 0) {
        // 内容已无人引用 → 才允许删盘。失败不影响 204（孤儿文件由 T05 清理任务兜底）。
        await driver.delete(relPathFor(row)).catch(() => undefined);
    }

    return true;
}

/**
 * 用 `parseStorageKey` 校验，并把 `StorageKeyError` 翻译成 400。
 *
 * 这里是"非法 key 不落盘"的执行点：抛错发生在 `storage.put` 之前，
 * 因此 `key=../../etc/passwd` 这类请求不会产生任何文件系统副作用。
 */
function requireStorageKey(rawKey: string | undefined) {
    try {
        return parseStorageKey(rawKey);
    } catch (error) {
        throw new ApiError("VALIDATION_FAILED", error instanceof Error ? error.message : "key 不合法", {
            field: "key",
            value: typeof rawKey === "string" ? rawKey.slice(0, 128) : rawKey,
        });
    }
}

/** 行 → 物理相对路径（与写入时完全一致的推导规则）。 */
export function relPathFor(row: AssetRow): string {
    return deriveObjectRelPath({ sha256: row.sha256, mime: row.mime, createdAt: row.created_at });
}

/**
 * MIME 归一化（**默认拒绝**，QA P0-2 的核心执行点）。
 *
 * 三种输入要分开处理：
 *
 * 1. **未声明**（空）或 `application/octet-stream`：
 *    前端从 `Blob` 直接 PUT 时常常不带 `Content-Type`。这时按 storageKey 前缀兜底
 *    （`image` → `image/png` …），否则存进去的 mime 全是 octet-stream，
 *    `<img>` 无法内联显示，前端体验会明显变差。
 * 2. **声明了且在白名单内**：归一成标准写法（`image/jpg` → `image/jpeg`）。
 * 3. **声明了但不在白名单**（`text/html`、`image/svg+xml`…）：
 *    一律降级为 `application/octet-stream`，**不再参考 storageKey 前缀** ——
 *    调用方给的 key 前缀是用户可控的，不能拿它来"证明"内容类型。
 *
 * @param declared 原始 `Content-Type` 头。
 * @param prefix 已校验过的 storageKey 前缀（仅用于第 1 种情况的兜底）。
 */
function normalizeMime(declared: string, prefix: StorageKeyPrefix): string {
    const canonical = canonicalAssetMime(declared);
    const declaredBase = (declared || "").split(";")[0]!.trim().toLowerCase();
    const unspecified = declaredBase.length === 0 || declaredBase === OCTET_STREAM_MIME;

    if (unspecified) {
        if (prefix === "image") return "image/png";
        if (prefix === "video") return "video/mp4";
        if (prefix === "audio") return "audio/mpeg";
        return OCTET_STREAM_MIME;
    }

    // 白名单之外的声明值（含 text/html、image/svg+xml 等可执行内容）→ 只保留字节。
    return canonical ?? OCTET_STREAM_MIME;
}

/**
 * 供路由/测试复用的导出（避免把归一规则散落到多处）。
 *
 * @param declared 原始 `Content-Type` 头。
 * @param prefix 已校验过的 storageKey 前缀。
 */
export function resolveAssetMime(declared: string, prefix: StorageKeyPrefix): string {
    return normalizeMime(declared, prefix);
}
