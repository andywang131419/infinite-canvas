/**
 * 画布 doc 清洗 —— 写入数据库**之前**的必经关卡。
 *
 * 依据 ARCH Rev2 §R5（R5 反转）：画布 JSON **不存** base64，只存 storageKey。
 * 但上游存在三类脏数据必须在上行时洗掉，否则数据库会被几百 MB 的 base64 撑爆：
 *
 * 1. `data:image/png;base64,...` 内联图片
 *    - 旧数据分支：`web/src/lib/canvas/canvas-generation-helpers.ts:63`、`:72`
 *    - 素材库分支：`web/src/stores/use-asset-store.ts:64-66`
 *    - 助手引用：`web/src/types/canvas.ts:106-113` `CanvasAssistantReference.dataUrl`
 *    → **提取为 asset，字段置空，写入兄弟字段 `storageKey`**
 *      （与前端读取约定一致：`resolveImageUrl(storageKey, dataUrl)`，见
 *       `canvas-generation-helpers.ts:71`、`pages/image/index.tsx:823`）
 *
 * 2. `blob:` 临时 URL
 *    - `web/src/services/image-storage.ts:54` `URL.createObjectURL(blob)` —— 页面关闭即失效
 *    → **置空字符串**（无法恢复，但绝不能把死链接写进库）
 *
 * 3. 整个 doc 体积超限 → 由 http 层返回 413（本模块只负责清洗）
 *
 * ---------------------------------------------------------------------------
 * 本文件同样是**零依赖纯模块**（不 import 任何东西），可用
 * `node --experimental-strip-types` 直接跑单测。
 * ---------------------------------------------------------------------------
 */

/** 单个 data URL 的载荷。 */
export type DataUrlPayload = {
    /** 从 `data:<mime>;base64,` 头解析出的 MIME。 */
    mime: string;
    /** 解码后的原始字节。 */
    bytes: Uint8Array;
};

/** 落库结果（由调用方（asset-service）提供）。 */
export type IngestedAsset = {
    /** 生成的逻辑键，形如 `image:xxxx`。 */
    storageKey: string;
    /** 内容 sha256。 */
    sha256: string;
    /** 字节数。 */
    bytes: number;
    /** 实际 MIME。 */
    mime: string;
};

/**
 * 提取回调：把一段二进制收进对象存储并返回 storageKey。
 *
 * 传 `null` 表示"当前环境无法落盘"（例如单元测试或存储未配置）——
 * 此时 data URL 仍会被**丢弃**（置空 + 记 warning），
 * 因为验收底线是"数据库里不能出现 `data:image`"，宁可丢图也不能污染 DB。
 */
export type IngestFn = (payload: DataUrlPayload) => Promise<IngestedAsset>;

/** 清洗统计，写入日志与响应，便于观察真实数据有多脏。 */
export type SanitizeStats = {
    /** 成功提取并落盘的 data URL 数量。 */
    extracted: number;
    /** 被置空的 `blob:` 数量。 */
    blobCleared: number;
    /** 因无法落盘而被丢弃的 data URL 数量。 */
    dropped: number;
    /** 人话提示（最多保留 20 条，避免日志爆炸）。 */
    warnings: string[];
};

/** 清洗结果。 */
export type SanitizeResult = {
    doc: unknown;
    stats: SanitizeStats;
};

/**
 * 视为"图片/媒体载体"的字段名。
 *
 * 只有这些字段里的字符串才可能被当成媒体处理；其余字符串（标题、提示词、
 * 正文文本）一律原样保留，绝不误伤。
 *
 * - `content`：`CanvasNodeMetadata.content` / `CanvasNodeImage.content`（图片节点存 URL）
 * - `dataUrl`：`CanvasAssistantReference.dataUrl` / `CanvasAssistantImage.dataUrl`
 * - `url` / `coverUrl` / `previewUrl` / `thumbnail` / `src`：素材库与导出路径
 */
const MEDIA_FIELD_NAMES = new Set(["content", "dataUrl", "url", "coverUrl", "previewUrl", "thumbnail", "src"]);

/** 递归最大深度（防御畸形/循环引用数据）。 */
const MAX_DEPTH = 64;

/** `data:<mime>;base64,<payload>`；mime 可省略。 */
const DATA_URL_PATTERN = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)?(?:;[^,]*)?;base64,/i;

/** 是否 data URL。 */
export function isDataUrl(value: unknown): value is string {
    return typeof value === "string" && DATA_URL_PATTERN.test(value);
}

/** 是否 `blob:` 临时 URL。 */
export function isBlobUrl(value: unknown): value is string {
    return typeof value === "string" && /^blob:/i.test(value);
}

/**
 * 拆解 data URL。
 *
 * @returns `{ mime, bytes }`；不是合法 data URL 或 base64 解码失败时返回 `null`。
 */
export function decodeDataUrl(value: string, fallbackMime = "image/png"): DataUrlPayload | null {
    const matched = DATA_URL_PATTERN.exec(value);
    if (!matched) return null;

    const commaAt = value.indexOf(",");
    if (commaAt < 0) return null;

    const header = value.slice(0, commaAt);
    const declared = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)/i.exec(header)?.[1];
    const mime = (declared ?? matched[1] ?? fallbackMime).toLowerCase();

    const base64 = value.slice(commaAt + 1);
    const bytes = decodeBase64(base64);
    if (!bytes || bytes.length === 0) return null;

    return { mime, bytes };
}

/**
 * base64 → Uint8Array。
 *
 * 不依赖 Buffer（保持纯模块可在浏览器/Node 通用），并容忍 base64url 与换行。
 * 解码失败返回 `null` 而不是抛错 —— 一条坏数据不该让整次保存失败。
 */
function decodeBase64(input: string): Uint8Array | null {
    const normalized = input.replace(/[\r\n\t\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (normalized.length === 0) return null;

    const padded = normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4));

    try {
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    } catch {
        return null;
    }
}

/**
 * 清洗整份画布 doc。
 *
 * 语义保证（可被断言）：
 * - 返回的 doc 中**任何位置**都不再出现 `data:*;base64,` 开头的字符串；
 * - 返回的 doc 中**任何位置**都不再出现 `blob:` 开头的字符串；
 * - 其余字段（标题、提示词、文本节点正文、坐标、连线……）逐字节保持原样；
 * - 输入对象**不被修改**（纯函数式，返回新对象）。
 *
 * @param doc 客户端提交的 `CanvasProject`（任意 JSON 值）。
 * @param ingest 落盘回调；`null` 表示无法落盘（data URL 将被丢弃）。
 * @param now 时间基准（仅用于 warning 文本，便于测试固定输出）。
 */
export async function sanitizeCanvasDoc(doc: unknown, ingest: IngestFn | null): Promise<SanitizeResult> {
    const stats: SanitizeStats = { extracted: 0, blobCleared: 0, dropped: 0, warnings: [] };

    const cleaned = await walk(doc, stats, ingest, 0);
    return { doc: cleaned, stats };
}

/** 递归主体。 */
async function walk(value: unknown, stats: SanitizeStats, ingest: IngestFn | null, depth: number): Promise<unknown> {
    if (depth > MAX_DEPTH) {
        pushWarning(stats, `doc 嵌套层级超过 ${MAX_DEPTH}，已截断`);
        return value;
    }

    if (typeof value === "string") {
        // 裸字符串：出现在"未知位置"（例如插件节点的自定义字段）。
        // 成功落盘时替换为 storageKey，保留可恢复性；否则置空。
        if (isDataUrl(value)) {
            const storageKey = await tryIngest(value, stats, ingest, "未知字段");
            return storageKey ?? "";
        }
        if (isBlobUrl(value)) {
            stats.blobCleared += 1;
            return "";
        }
        return value;
    }

    if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (const item of value) {
            items.push(await walk(item, stats, ingest, depth + 1));
        }
        return items;
    }

    if (value === null || typeof value !== "object") return value;

    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    /** 该对象是否已有 storageKey 字段（决定 data URL 要不要顺手补一个）。 */
    const hadStorageKey = typeof source.storageKey === "string" && source.storageKey.length > 0;

    for (const [key, raw] of Object.entries(source)) {
        // storageKey 本身永远原样保留（它的合法性由 assets 表读取时再校验）。
        if (key === "storageKey") {
            output[key] = raw;
            continue;
        }

        if (typeof raw === "string" && MEDIA_FIELD_NAMES.has(key)) {
            if (isDataUrl(raw)) {
                const storageKey = await tryIngest(raw, stats, ingest, key);
                // 字段置空（前端约定：有 storageKey 时 dataUrl 为空）。
                output[key] = "";
                if (storageKey && !hadStorageKey) output.storageKey = storageKey;
                continue;
            }
            if (isBlobUrl(raw)) {
                stats.blobCleared += 1;
                output[key] = "";
                continue;
            }
            output[key] = raw;
            continue;
        }

        /**
         * `references` 有两种形态，必须都覆盖：
         * - `string[]`：`CanvasNodeMetadata.references`，元素是 `image:xxx`
         *   （见 `canvas-generation-helpers.ts:38`、`use-plugin-host.tsx:44`）
         * - `CanvasAssistantReference[]`：`CanvasAssistantMessage.references`
         *   （见 `web/src/types/canvas.ts:122-130`，元素含 `dataUrl` / `storageKey`）
         */
        if (key === "references" && Array.isArray(raw)) {
            output[key] = await walkReferences(raw, stats, ingest, depth);
            continue;
        }

        output[key] = await walk(raw, stats, ingest, depth + 1);
    }

    return output;
}

/** `references` 数组归一化处理。 */
async function walkReferences(items: unknown[], stats: SanitizeStats, ingest: IngestFn | null, depth: number): Promise<unknown[]> {
    const output: unknown[] = [];

    for (const item of items) {
        if (typeof item === "string") {
            if (isDataUrl(item)) {
                const storageKey = await tryIngest(item, stats, ingest, "references[]");
                // 数组元素直接换成 storageKey 字符串（该字段的既定语义就是 storageKey）。
                output.push(storageKey ?? "");
                continue;
            }
            if (isBlobUrl(item)) {
                stats.blobCleared += 1;
                output.push("");
                continue;
            }
            output.push(item);
            continue;
        }

        output.push(await walk(item, stats, ingest, depth + 1));
    }

    return output;
}

/**
 * 尝试落盘一段 data URL。
 *
 * @returns 成功时返回新 storageKey；失败/无法落盘时返回 `null`（调用方负责置空）。
 */
async function tryIngest(
    dataUrl: string,
    stats: SanitizeStats,
    ingest: IngestFn | null,
    fieldName: string,
): Promise<string | null> {
    const payload = decodeDataUrl(dataUrl);
    if (!payload) {
        stats.dropped += 1;
        pushWarning(stats, `${fieldName} 处存在无法解码的 data URL，已置空`);
        return null;
    }

    if (!ingest) {
        stats.dropped += 1;
        pushWarning(stats, `${fieldName} 处存在 data URL（${payload.mime}, ${payload.bytes.length} 字节），但存储不可用，已置空`);
        return null;
    }

    try {
        const ingested = await ingest(payload);
        stats.extracted += 1;
        return ingested.storageKey;
    } catch (error) {
        stats.dropped += 1;
        pushWarning(stats, `${fieldName} 处 data URL 落盘失败（${error instanceof Error ? error.message : String(error)}），已置空`);
        return null;
    }
}

/** 警告收集（上限 20 条，防日志爆炸）。 */
function pushWarning(stats: SanitizeStats, message: string): void {
    if (stats.warnings.length >= 20) return;
    stats.warnings.push(message);
}

/**
 * 递归收集 doc 中出现的全部 storageKey。
 *
 * 用途：
 * 1. 保存后校验"doc 引用的 key 是否真的存在于 assets 表"（缺失只告警不阻塞，
 *    因为上游历史数据本就可能有悬空 key）；
 * 2. 供后续 T05 做孤儿资产清理。
 *
 * 与上游 `web/src/services/app-sync.ts:339-347` 的 `collectStorageKeys` 语义一致。
 */
export function collectStorageKeys(value: unknown, into: Set<string> = new Set<string>()): Set<string> {
    if (typeof value === "string") {
        if (/^(image|video|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]{1,64}$/.test(value)) {
            into.add(value);
        }
        return into;
    }

    if (Array.isArray(value)) {
        for (const item of value) collectStorageKeys(item, into);
        return into;
    }

    if (!value || typeof value !== "object") return into;

    const record = value as Record<string, unknown>;
    if (typeof record.storageKey === "string" && record.storageKey.length > 0) {
        collectStorageKeys(record.storageKey, into);
    }

    for (const item of Object.values(record)) {
        collectStorageKeys(item, into);
    }

    return into;
}
