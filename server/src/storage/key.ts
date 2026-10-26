/**
 * storageKey 与对象物理路径 —— **纯函数模块，零业务依赖**。
 *
 * 为什么单独抽出来：
 * 1. 路径安全是 T02 最容易出洞的地方（`../../etc/passwd`、绝对路径、URL 编码绕过），
 *    必须能被"纯逻辑单测"直接覆盖，不能埋在路由里靠读代码保证；
 * 2. 本文件**不 import 任何东西**（除 node:crypto），因此可以直接用
 *    `node --experimental-strip-types` 跑测试，不需要 Bun 运行时。
 *
 * ---------------------------------------------------------------------------
 * 【关键设计】storageKey 与物理路径**完全解耦**
 * ---------------------------------------------------------------------------
 * - storageKey 是**逻辑键**，格式沿用上游 `image:{nanoid}`：
 *     web/src/services/image-storage.ts:53   `image:${nanoid()}`
 *     web/src/services/file-storage.ts:13    `${prefix}:${nanoid()}`
 *     web/src/services/app-sync.ts:82        /^(image|video|audio|file|video-reference|audio-reference):/
 *   这样 doc 里已有的 `metadata.storageKey` / `chatSessions[].messages[].references[].storageKey`
 *   一个字符都不用改（ARCH Rev2 §R4.2）。
 *
 * - 物理路径是**内容寻址**：`{STORAGE_LOCAL_ROOT}/{yyyy}/{mm}/{sha256}.{ext}`
 *   （STORAGE_LOCAL_ROOT 默认 `/data/media`，即 ARCH 所说的 `media/{yyyy}/{mm}/...`）。
 *
 * 解耦带来的两个直接收益：
 *   1. **路径穿越在构造上不可能** —— 用户传来的 key 永远不参与文件路径拼接，
 *      只作为 DB 查询条件；即便校验漏了，也无法拼出 `..`。
 *   2. 同一份内容重复上传自然去重（与 assets 表
 *      `ux_assets_sha256_driver ON (sha256, storage_driver)` 一致）。
 *
 * 物理路径由 `created_at + sha256 + mime` 确定性推导，**不需要额外数据库列**。
 */

import { randomBytes } from "node:crypto";

/** 允许的 storageKey 前缀，与上游 `app-sync.ts:82` 正则逐字一致。 */
export const STORAGE_KEY_PREFIXES = [
    "image",
    "video",
    "audio",
    "file",
    "video-reference",
    "audio-reference",
] as const;

/** 前缀字面量联合类型。 */
export type StorageKeyPrefix = (typeof STORAGE_KEY_PREFIXES)[number];

/** 解析后的 storageKey。 */
export type ParsedStorageKey = {
    /** 原始字符串，例如 `image:V1StGXR8_Z5jdHi6B-myT`。 */
    raw: string;
    /** 前缀（决定 assets.kind 与落盘子目录语义）。 */
    prefix: StorageKeyPrefix;
    /** `:` 之后的 nanoid 部分。 */
    id: string;
};

/**
 * storageKey 严格格式：`前缀:标识`。
 *
 * 标识部分只允许 `[A-Za-z0-9_-]`（nanoid 默认字母表），长度 1..64。
 * 这条正则同时挡掉了 `/`、`\`、`.`、空白、`%`、`空字节` 等一切危险字符。
 */
const STORAGE_KEY_PATTERN = /^(image|video|audio|file|video-reference|audio-reference):([A-Za-z0-9_-]{1,64})$/;

/** storageKey 最大总长度（27 左右是常态，给到 128 足够宽松）。 */
const MAX_STORAGE_KEY_LENGTH = 128;

/** 校验失败。**故意不用 ApiError**：本模块要保持零依赖，由 http 层翻译成 400。 */
export class StorageKeyError extends Error {
    readonly reason: StorageKeyErrorReason;

    constructor(reason: StorageKeyErrorReason, message: string) {
        super(message);
        this.name = "StorageKeyError";
        this.reason = reason;
    }
}

/** 校验失败原因（供 http 层组装 details）。 */
export type StorageKeyErrorReason =
    | "empty"
    | "too_long"
    | "path_traversal"
    | "absolute_path"
    | "illegal_character"
    | "bad_prefix"
    | "bad_format";

/**
 * 解析并严格校验 storageKey。
 *
 * @param raw 来自 query / body 的原始值（可能是 `undefined` / 数组 / 对象）。
 * @returns 解析结果。
 * @throws {StorageKeyError} 任何不合法输入。
 *
 * 拒绝顺序刻意从"最危险的"开始，便于测试断言具体原因：
 * `empty` → `too_long` → `path_traversal` → `absolute_path` → `illegal_character`
 * → `bad_prefix` → `bad_format`
 */
export function parseStorageKey(raw: unknown): ParsedStorageKey {
    if (typeof raw !== "string") {
        throw new StorageKeyError("empty", "缺少 key 参数");
    }

    const value = raw.trim();
    if (value.length === 0) {
        throw new StorageKeyError("empty", "key 不能为空");
    }
    if (value.length > MAX_STORAGE_KEY_LENGTH) {
        throw new StorageKeyError("too_long", `key 长度不得超过 ${MAX_STORAGE_KEY_LENGTH}`);
    }

    // --- 防御层 1：路径穿越（含 URL 解码后的 ../ 与 ..\）---
    if (value.includes("..")) {
        throw new StorageKeyError("path_traversal", "key 不得包含 `..`");
    }

    // --- 防御层 2：绝对路径 / 任何目录分隔符 ---
    if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) {
        throw new StorageKeyError("absolute_path", "key 不得为绝对路径");
    }
    if (value.includes("/") || value.includes("\\")) {
        throw new StorageKeyError("path_traversal", "key 不得包含路径分隔符");
    }

    // --- 防御层 3：控制字符 / 空字节 / 空白 ---
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\s]/.test(value)) {
        throw new StorageKeyError("illegal_character", "key 不得包含控制字符或空白");
    }

    // --- 防御层 4：前缀白名单 ---
    const colonAt = value.indexOf(":");
    const prefix = colonAt > 0 ? value.slice(0, colonAt) : "";
    if (!isStorageKeyPrefix(prefix)) {
        throw new StorageKeyError("bad_prefix", `key 前缀必须是 ${STORAGE_KEY_PREFIXES.join(" / ")} 之一，且形如 "image:xxxx"`);
    }

    // --- 防御层 5：整体格式（字符白名单 + 长度）---
    const matched = STORAGE_KEY_PATTERN.exec(value);
    if (!matched) {
        throw new StorageKeyError("bad_format", "key 格式非法，标识部分只允许 A-Za-z0-9_-");
    }

    return { raw: value, prefix: matched[1] as StorageKeyPrefix, id: matched[2] };
}

/** 判断是否合法前缀。 */
export function isStorageKeyPrefix(value: string): value is StorageKeyPrefix {
    return (STORAGE_KEY_PREFIXES as readonly string[]).includes(value);
}

/**
 * 宽松判断"某个字符串看起来像不像 storageKey"。
 *
 * 用途：doc 清洗时识别 `metadata.references[]` 里已经合格的键，避免误伤。
 * **不能**用于安全校验（安全校验必须用 {@link parseStorageKey}）。
 */
export function looksLikeStorageKey(value: unknown): value is string {
    return typeof value === "string" && STORAGE_KEY_PATTERN.test(value);
}

/**
 * 生成一个新的 storageKey，形如 `image:V1StGXR8_Z5jdHi6B-myT`。
 *
 * 标识部分用 `randomBytes(16).toString("base64url")` 取前 21 个字符 ——
 * 与上游 `nanoid()` 默认长度 21、默认字母表 `A-Za-z0-9_-` 完全同构，
 * 因此前端拿到后无需区分"是服务端造的"还是"本地造的"。
 *
 * @param prefix 资产种类前缀。
 */
export function generateStorageKey(prefix: StorageKeyPrefix): string {
    const id = randomBytes(16).toString("base64url").slice(0, 21);
    return `${prefix}:${id}`;
}

/** storageKey 前缀 → assets.kind（数据库 CHECK 约束只允许 image/video/audio/file）。 */
export function kindFromPrefix(prefix: StorageKeyPrefix): "image" | "video" | "audio" | "file" {
    if (prefix === "image") return "image";
    if (prefix === "video" || prefix === "video-reference") return "video";
    if (prefix === "audio" || prefix === "audio-reference") return "audio";
    return "file";
}

// =============================================================================
// 物理路径（内容寻址）
// =============================================================================

/** 常见 MIME → 扩展名。未收录的统一落到 `bin`。 */
const MIME_EXTENSION: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/webm": "weba",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
};

/**
 * MIME → 文件扩展名。
 *
 * @param mime `Content-Type` 头，可带 `; charset=...` 参数（会自动裁掉）。
 */
export function extensionFromMime(mime: string): string {
    const base = (mime || "").split(";")[0]!.trim().toLowerCase();
    const known = MIME_EXTENSION[base];
    if (known) return known;

    // 兜底：尝试从子类型里取一个合法扩展名（`image/x-icon` → `x-icon` 不合法，故再清洗）。
    const subtype = base.includes("/") ? base.slice(base.indexOf("/") + 1) : "";
    const cleaned = subtype.replace(/[^a-z0-9]/g, "");
    return cleaned.length > 0 && cleaned.length <= 8 ? cleaned : "bin";
}

/** 反向表：扩展名 → MIME（读取时若 DB 无记录，用于兜底 Content-Type）。 */
export function mimeFromExtension(ext: string): string {
    const normalized = ext.toLowerCase();
    for (const [mime, value] of Object.entries(MIME_EXTENSION)) {
        if (value === normalized) return mime;
    }
    return "application/octet-stream";
}

/** sha256 十六进制串格式（64 位小写十六进制）。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 对象路径推导的输入。 */
export type ObjectPathInput = {
    /** 内容 sha256（64 位小写十六进制）。 */
    sha256: string;
    /** MIME 类型（决定扩展名）。 */
    mime: string;
    /** 资产创建时间，ISO8601 UTC（决定 `{yyyy}/{mm}` 分桶）。 */
    createdAt: string;
};

/**
 * 推导内容寻址的相对路径：`{yyyy}/{mm}/{sha256}.{ext}`。
 *
 * 返回值**相对于 STORAGE_LOCAL_ROOT**（默认 `/data/media`），
 * 因此实际落盘位置是 `/data/media/2026/10/<sha256>.png`，与 ARCH R4.2 描述的
 * `media/{yyyy}/{mm}/...` 一致。
 *
 * 确定性说明：同一 `(sha256, mime, createdAt)` 必然得到同一路径。
 * `assets` 表的 `ux_assets_sha256_driver` 保证同内容只有一行，
 * 所以"重复上传拿到不同月份目录"不会发生。
 *
 * @throws {StorageKeyError} sha256 格式非法（属于程序错误，不是用户输入错误）。
 */
export function deriveObjectRelPath(input: ObjectPathInput): string {
    const sha256 = input.sha256.toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) {
        throw new StorageKeyError("bad_format", "sha256 必须是 64 位小写十六进制");
    }

    const { year, month } = splitIsoYearMonth(input.createdAt);
    return `${year}/${month}/${sha256}.${extensionFromMime(input.mime)}`;
}

/**
 * 从 ISO8601 字符串取年月；非法时回退到当前时间（宁可落到"今天"的桶也不抛错，
 * 避免因为一条脏 created_at 让整个读请求 500）。
 */
function splitIsoYearMonth(iso: string): { year: string; month: string } {
    const matched = /^(\d{4})-(\d{2})/.exec(iso ?? "");
    if (matched) return { year: matched[1]!, month: matched[2]! };

    const now = new Date();
    return {
        year: String(now.getUTCFullYear()).padStart(4, "0"),
        month: String(now.getUTCMonth() + 1).padStart(2, "0"),
    };
}

/**
 * 判断一个相对路径是否安全（供 StorageDriver 内部二次防御）。
 *
 * 允许 `a/b/c.png` 这种多级相对路径，但拒绝绝对路径、`..`、空字节。
 */
export function isSafeRelPath(relPath: string): boolean {
    if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 512) return false;
    if (relPath.startsWith("/") || relPath.startsWith("\\")) return false;
    if (/^[A-Za-z]:/.test(relPath)) return false;
    if (relPath.includes("..")) return false;
    if (relPath.includes("\\")) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(relPath)) return false;
    return relPath.split("/").every((segment) => segment.length > 0 && segment !== ".");
}
