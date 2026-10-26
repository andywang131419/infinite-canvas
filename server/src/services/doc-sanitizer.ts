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
 * 关于依赖：本文件只 import 两个**同样零依赖的纯模块**
 * （`./mime-whitelist.ts` 与 `../storage/key.ts`，均带 `.ts` 后缀），
 * 因此仍可用 `node --experimental-strip-types` 直接跑单测。
 * 白名单必须与 `asset-service.ts` 共用同一份 —— 否则"doc 侧放行、资产侧拒绝"
 * 这类不对称会直接变成绕过点（QA P0-2 / P2-4）。
 * ---------------------------------------------------------------------------
 */

import { isAllowedAssetMime, canonicalAssetMime, OCTET_STREAM_MIME } from "./mime-whitelist.ts";
import { looksLikeStorageKey } from "../storage/key.ts";

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
 *
 * ⚠️ `content` 是**双义字段**：图片节点里它是媒体 URL，文本节点里它是正文。
 * 因此命中本集合之前必须先过 {@link isTextFieldName}（QA P2-3）。
 */
const MEDIA_FIELD_NAMES = new Set(["content", "dataUrl", "url", "coverUrl", "previewUrl", "thumbnail", "src"]);

/**
 * **纯文本**字段名：即使内容以 `data:` / `blob:` 开头也一律原样保留。
 *
 * 这些字段在协议里的语义就是"给人看的字符串"，把其中的 `data:` 当成载荷
 * 会导致正文被清空（QA P2-3 的实测：`{type:'text', metadata:{content:'blob:abc 是我的笔记正文'}}`
 * 曾被清成空串）。真实的二进制永远不会出现在这些字段里 ——
 * 图片节点用的是 `content`（且节点 `type !== 'text'`）。
 */
const TEXT_FIELD_NAMES = new Set(["prompt", "composerContent", "errorDetails", "title", "text", "label", "description"]);

/** 该字段是否是"纯文本"字段（`content` 仅在文本节点下算）。 */
function isTextFieldName(key: string, nodeType: string | null): boolean {
    if (TEXT_FIELD_NAMES.has(key)) return true;
    return key === "content" && nodeType === "text";
}

/** 递归最大深度（防御畸形/循环引用数据）。 */
const MAX_DEPTH = 64;

/**
 * 裸字符串被当成内联载荷的最小长度。
 *
 * 未知字段（插件节点的自定义字段）里的字符串无从判断语义，只能用长度兜底：
 * 真正的内联图片 base64 至少几百字符，而 `"data:image/png;base64, 是这么写的"`
 * 这种正文通常很短。短于阈值的字符串一律按文本保留（QA P2-3）。
 *
 * 注意：`content` / `dataUrl` 等**已知媒体字段**不受此阈值限制 ——
 * 那些字段里的 data URL 一定是载荷。
 */
const BARE_DATA_URL_MIN_LENGTH = 128;

/** `data:<mime>;base64,<payload>`；mime 可省略。 */
const DATA_URL_PATTERN = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)?(?:;[^,]*)?;base64,/i;

/**
 * `blob:` 临时 URL 的**严格**形状。
 *
 * 必须带 `scheme://`（如 `blob:http://localhost:3000/2f1c…`）或 `blob:null/…`，
 * 且整体不允许空白。这样 `"blob:abc 是我的笔记正文"` 这种**正文**不会被误判为
 * 死链而清空（QA P2-3）。
 */
const BLOB_URL_PATTERN = /^blob:(?:[a-z][a-z0-9+.-]*:\/\/\S*|null\/\S*)$/i;

/** 是否 data URL。 */
export function isDataUrl(value: unknown): value is string {
    return typeof value === "string" && DATA_URL_PATTERN.test(value);
}

/** 是否 `blob:` 临时 URL。 */
export function isBlobUrl(value: unknown): value is string {
    return typeof value === "string" && BLOB_URL_PATTERN.test(value);
}

/**
 * 取出 data URL 头里声明的 MIME（**不解码**，仅用于白名单预检）。
 *
 * @returns 小写 MIME；不是 data URL 或头里没有 MIME 时返回 `null`。
 */
export function dataUrlMime(value: string): string | null {
    const matched = DATA_URL_PATTERN.exec(value);
    if (!matched) return null;

    const commaAt = value.indexOf(",");
    const header = commaAt < 0 ? value : value.slice(0, commaAt);
    const declared = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)/i.exec(header)?.[1];
    const mime = (declared ?? matched[1] ?? "").toLowerCase();
    return mime.length > 0 ? mime : null;
}

/**
 * 拆解 data URL。
 *
 * **白名单前置**（QA P0-2 / P2-4）：内联 base64 与直接 PUT 走的是同一条落库通道，
 * 若这里不设防，`data:text/html;base64,<script>…` 会绕过 `PUT /api/assets` 的归一逻辑
 * 直接进库，再由 `/api/assets/raw` 同源直出。
 *
 * @returns `{ mime, bytes }`；不是合法 data URL、MIME 不在白名单、
 *          或 base64 解码失败时返回 `null`（调用方计 `dropped`）。
 */
export function decodeDataUrl(value: string, fallbackMime = "image/png"): DataUrlPayload | null {
    const matched = DATA_URL_PATTERN.exec(value);
    if (!matched) return null;

    const commaAt = value.indexOf(",");
    if (commaAt < 0) return null;

    const header = value.slice(0, commaAt);
    const declared = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)/i.exec(header)?.[1];
    const declaredMime = (declared ?? matched[1] ?? fallbackMime).toLowerCase();

    // 与 asset-service 共用同一份白名单；octet-stream 的 data URL 无法判断真实内容，
    // 一律当"不可信"丢弃（真二进制请走 PUT /api/assets，那里会按 storageKey 前缀兜底）。
    const mime = canonicalAssetMime(declaredMime);
    if (!mime || mime === OCTET_STREAM_MIME) return null;

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
        /**
         * 深度超限时**不能原样返回**（QA P1-1 A）。
         *
         * 原先 `return value` 意味着：把 base64 埋到第 65 层就能整棵子树原样入库，
         * `stats.dropped` 仍为 0，连 `x-doc-dropped` 都不会提示。
         * 现在的语义是"这棵子树已知不可控 → 整棵丢弃并计数"，
         * 与文件头声明的「返回的 doc 中任何位置都不再出现 data:*;base64,」保持一致。
         */
        stats.dropped += 1;
        pushWarning(stats, `doc 嵌套层级超过 ${MAX_DEPTH}，该子树已丢弃`);
        return null;
    }

    if (typeof value === "string") {
        // 裸字符串：出现在"未知位置"（例如插件节点的自定义字段）。
        // 成功落盘时替换为 storageKey，保留可恢复性；否则置空。
        // 只有**够长的** data URL 才当载荷 —— 短字符串更可能是正文（QA P2-3）。
        if (isDataUrl(value) && value.length >= BARE_DATA_URL_MIN_LENGTH) {
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
    /**
     * 该对象是否已有 storageKey 字段（决定 data URL 要不要顺手补一个）。
     *
     * 判据必须是 `looksLikeStorageKey` 而不是"是个非空字符串"：
     * 一个 `storageKey: "data:image/png;base64,…"` 的脏节点不该被视为"已有键"，
     * 否则它下面真正提取出来的 storageKey 就不会被补写（QA P1-1 B）。
     */
    const hadStorageKey = looksLikeStorageKey(source.storageKey);
    /** 节点类型（`type === 'text'` 时 `content` 表示正文，不是媒体）。 */
    const nodeType = typeof source.type === "string" ? source.type : null;

    for (const [key, raw] of Object.entries(source)) {
        /**
         * `storageKey` 的合法性由 assets 表读取时再校验，但**不能无条件透传**（QA P1-1 B）：
         * 它不在 `MEDIA_FIELD_NAMES` 里，原先 `data:image/png;base64,…` 会被原样写库，
         * 直接反证了「DB 里绝不出现 data:」这条底线。
         */
        if (key === "storageKey") {
            if (typeof raw === "string" && raw.length > 0 && !looksLikeStorageKey(raw) && /^(?:data|blob):/i.test(raw)) {
                stats.dropped += 1;
                pushWarning(stats, "storageKey 处存在非法的 data:/blob: 值，已置空");
                // 若本轮已经提取出合法 key（字段顺序在 content 之后），不要把它覆盖掉。
                if (!looksLikeStorageKey(output.storageKey)) output.storageKey = "";
                continue;
            }
            output[key] = raw;
            continue;
        }

        // 纯文本字段（prompt / 文本节点正文 / errorDetails…）原样保留，绝不清洗（QA P2-3）。
        if (typeof raw === "string" && isTextFieldName(key, nodeType)) {
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
    // 先做白名单预检：这样 warning 能说清"是 MIME 不允许"而不是笼统的"无法解码"。
    const declared = dataUrlMime(dataUrl);
    if (declared !== null && !isAllowedAssetMime(declared)) {
        stats.dropped += 1;
        pushWarning(stats, `${fieldName} 处 data URL 的 MIME（${declared}）不在白名单，已置空`);
        return null;
    }

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
