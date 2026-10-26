/**
 * 上游 HTTP 薄封装。
 *
 * 三件事，都只做一次，避免每个适配器各写一遍：
 * 1. **超时**：统一 `AbortSignal.timeout()`，超时翻译成 `PROVIDER_TIMEOUT`（可重试）；
 * 2. **错误归一**：上游返回什么形状都有（`{error:{message}}` / `{msg}` / 纯文本 / HTML），
 *    这里统一抽成一句人话，并按状态码给出 `retryable`；
 * 3. **脱敏**：错误信息里出现密钥时**无条件替换**成 `***`。
 *    上游偶尔会把收到的 Authorization 回显在报错里，这条是最后一道闸。
 *
 * 本文件同样不 import env / DB，保证能被校验脚本以 node 直接加载。
 */

import { ProviderError } from "./types.ts";
import type { ProviderContext } from "./types.ts";

import { checkTarget, resolveAndCheckHost } from "../proxy/guard.ts";

/** 一条待发请求的描述（纯数据，便于 fixture 对比）。 */
export type ProviderRequest = {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    /** JSON 字符串或 multipart FormData。 */
    body?: string | FormData;
};

/** 原始响应。 */
export type RawResponse = {
    status: number;
    contentType: string;
    bytes: Uint8Array;
    text: string;
};

/** 错误信息截断长度（避免上游返回整页 HTML 撑爆任务表）。 */
const MESSAGE_LIMIT = 300;

/** 上游响应体最大读取量（防「上游返回 2GB」把进程读死）。 */
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;

/**
 * 把 baseUrl 归一成 OpenAI 风格 API 前缀。
 *
 * 与 `web/src/stores/use-config-store.ts: buildApiUrl` 完全一致：
 * 已经以 `/v1` 结尾就不再追加，否则补 `/v1`。
 */
export function openaiBase(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const lower = trimmed.toLowerCase();
    return lower.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * 把 baseUrl 归一成 Gemini 风格 API 前缀（`/v1beta`）。
 *
 * 移植自 `web/src/services/api/image.ts: geminiBaseUrl`。
 */
export function geminiBase(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const lower = trimmed.toLowerCase();
    return lower.endsWith("/v1") || lower.endsWith("/v1beta") ? trimmed : `${trimmed}/v1beta`;
}

/** Gemini 模型名去掉 `models/` 前缀。 */
export function geminiModelName(model: string): string {
    return model.trim().replace(/^models\//, "");
}

/** 把任意值安全地转成字符串（上游字段类型不稳定）。 */
export function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** 判断是否是普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 从上游错误响应里抽一句人话。
 *
 * 覆盖的常见形状：
 * - `{ error: { message } }`（OpenAI）
 * - `{ msg }`（各类中转站）
 * - `{ response: { error: { message } } }`（Gemini 包装层）
 * - 纯文本 / HTML（网关报错页）
 */
export function extractErrorMessage(raw: string): string {
    const text = (raw ?? "").trim();
    if (text.length === 0) return "";

    if (text.startsWith("{") || text.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(text);
            const fromJson = readMessageFromPayload(parsed);
            if (fromJson) return truncate(fromJson);
        } catch {
            // 不是合法 JSON，落到纯文本分支。
        }
    }

    // HTML 错误页：只留一个可辨识的开头，别把整页塞进数据库。
    if (/<[a-z][\s\S]*>/i.test(text)) return `${stripTags(text).slice(0, 120)}…`;

    return truncate(text);
}

/** 从已解析的 JSON 载荷里递归抽 message（最多 4 层，防环）。 */
function readMessageFromPayload(payload: unknown, depth = 0): string {
    if (depth > 4 || payload === null || payload === undefined) return "";
    if (typeof payload === "string") return payload;

    if (!isRecord(payload)) return "";

    const direct = asString(payload.message) || asString(payload.msg) || asString(payload.detail);
    if (direct) return direct;

    if (typeof payload.error === "string") return payload.error;
    if (isRecord(payload.error)) {
        const nested = asString(payload.error.message) || asString(payload.error.code);
        if (nested) return nested;
    }
    if (isRecord(payload.response)) {
        const nested = readMessageFromPayload(payload.response, depth + 1);
        if (nested) return nested;
    }
    return "";
}

/** 去掉 HTML 标签与多余空白。 */
function stripTags(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** 截断到 `MESSAGE_LIMIT`。 */
function truncate(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= MESSAGE_LIMIT ? normalized : `${normalized.slice(0, MESSAGE_LIMIT)}…`;
}

/**
 * 脱敏：把密钥从任何字符串里抹掉。
 *
 * 用一个长度阈值兜底 —— 太短的"密钥"（< 8 字符）不参与替换，
 * 否则会把正常单词也一起抹掉。
 */
export function scrubSecret(text: string, secret: string): string {
    const value = text ?? "";
    if (!secret || secret.length < 8) return value;
    return value.split(secret).join("***");
}

/** 把 HTTP 状态翻译成适配器错误（含 retryable 判断）。 */
export function mapStatus(status: number, message: string): ProviderError {
    const detail = message || `上游返回 HTTP ${status}`;

    if (status === 401 || status === 403) {
        return new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游鉴权失败（请检查渠道密钥）：${detail}`, { retryable: false, status });
    }
    if (status === 404) {
        return new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游接口不存在（请检查渠道 baseUrl 与模型名）：${detail}`, { retryable: false, status });
    }
    if (status === 429) {
        return new ProviderError("QUOTA_EXCEEDED", `上游限流或额度不足：${detail}`, { retryable: true, status });
    }
    if (status === 408 || status === 409 || status === 425) {
        return new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游暂时不可用：${detail}`, { retryable: true, status });
    }
    if (status >= 500) {
        return new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游服务错误：${detail}`, { retryable: true, status });
    }
    if (status === 400 || status === 422) {
        // 内容审核拒绝与普通参数错误都是 4xx，但语义完全不同：
        // 前者重试无意义且会触发风控，后者改参数才有意义 —— 都不能重试。
        const rejected = /content[_\s-]?policy|safety|moderation|violat|blocked|blocklist|敏感|违规/i.test(detail);
        return new ProviderError(
            rejected ? "PROVIDER_CONTENT_REJECTED" : "PROVIDER_UPSTREAM_ERROR",
            rejected ? `内容被上游审核拒绝：${detail}` : `上游参数错误：${detail}`,
            { retryable: false, status },
        );
    }

    return new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游请求失败（HTTP ${status}）：${detail}`, { retryable: status >= 500, status });
}

/**
 * 发一条请求并读完响应体。
 *
 * @throws {ProviderError} 超时 / 网络错误 / 响应过大
 */
export async function sendRequest(ctx: ProviderContext, request: ProviderRequest): Promise<RawResponse> {
    let response: Response;
    try {
        response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: AbortSignal.timeout(Math.max(1, ctx.timeoutMs)),
        });
    } catch (error) {
        throw normalizeNetworkError(error, request.url);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        throw normalizeNetworkError(error, request.url);
    }

    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游响应体过大（>${Math.floor(MAX_RESPONSE_BYTES / 1024 / 1024)}MB）`, {
            retryable: false,
            status: response.status,
        });
    }

    return { status: response.status, contentType, bytes, text: new TextDecoder().decode(bytes) };
}

/** 发请求并解析 JSON；非 2xx 抛错。 */
export async function sendJson(ctx: ProviderContext, request: ProviderRequest): Promise<unknown> {
    const response = await sendRequest(ctx, request);
    if (response.status < 200 || response.status >= 300) {
        throw mapStatus(response.status, scrubSecret(extractErrorMessage(response.text), ctx.apiKey));
    }
    try {
        return JSON.parse(response.text) as unknown;
    } catch {
        const preview = scrubSecret(response.text.slice(0, 120), ctx.apiKey);
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游返回的不是合法 JSON：${preview}`, {
            retryable: true,
            status: response.status,
        });
    }
}

/** 发请求并返回原始字节（音频/视频/图片下载用）；非 2xx 抛错。 */
export async function sendBytes(ctx: ProviderContext, request: ProviderRequest): Promise<{ bytes: Uint8Array; mime: string }> {
    const response = await sendRequest(ctx, request);
    if (response.status < 200 || response.status >= 300) {
        throw mapStatus(response.status, scrubSecret(extractErrorMessage(response.text), ctx.apiKey));
    }
    if (response.bytes.byteLength === 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "上游返回了空响应体", { retryable: true, status: response.status });
    }
    return { bytes: response.bytes, mime: normalizeMime(response.contentType) };
}

/**
 * 下载一个 URL 的字节（图片/视频结果通常以 URL 形式返回）。
 *
 * ⚠️ QA R2 `P1-R2-2`：**这里曾经是一条完整 SSRF，且能带外回传数据。**
 *
 * 原实现只正则查了「是不是 http/https」就直接 `sendBytes`。但本函数拿到的 URL
 * 来自**上游响应体**，不属于 `routes/proxy.ts` 那三道闸的保护范围（它们只管
 * 客户端传进来的 URL）。于是恶意/被攻破的中转站只要返回
 * `{"data":[{"url":"http://169.254.169.254/latest/meta-data/iam/security-credentials/"}]}`，
 * 服务端就去抓 → `persistResults` 落成 `image:` 资产 → 用户在画布里把云账号凭据下载回来。
 * 这不是盲 SSRF，而是「读得到响应 + 响应会被持久化 + 用户可取回」的完整链路。
 *
 * 现在复用与代理同一套闸门，白名单取 `RESULT_DOWNLOAD_ALLOWLIST`
 * （结果 CDN 域名通常与 API 域名不同，不能套用渠道 baseUrl 白名单）。
 */
export async function downloadBytes(ctx: ProviderContext, url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    await assertResultUrlAllowed(url);
    return sendBytes(ctx, { url, method: "GET", headers: {} });
}

/**
 * 校验「上游返回的结果下载地址」是否允许访问。
 *
 * 与 `routes/proxy.ts` 的顺序严格一致：`checkTarget`（协议 + 字面量内网 + 白名单）
 * → `resolveAndCheckHost`（DNS 复检）→ 才允许发请求。
 * `RESULT_DOWNLOAD_ALLOWLIST` 留空时**拒绝一切**结果下载（fail-closed）。
 */
async function assertResultUrlAllowed(rawUrl: string): Promise<void> {
    // 动态 import：本文件在模块加载期不许依赖 env（见文件头约束）。
    const { getEnv } = await import("../env.ts");
    const allowlist = new Set(getEnv().RESULT_DOWNLOAD_ALLOWLIST);

    const target = checkTarget(rawUrl, allowlist);
    if (!target.ok) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游返回了不允许的结果下载地址：${target.reason}`, {
            retryable: false,
        });
    }

    const hostCheck = await resolveAndCheckHost(target.url.hostname);
    if (!hostCheck.ok) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", `上游返回了不允许的结果下载地址：${hostCheck.reason}`, {
            retryable: false,
        });
    }
}

/** 把网络层异常翻译成适配器错误。 */
function normalizeNetworkError(error: unknown, url: string): ProviderError {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    const host = safeHost(url);

    if (name === "TimeoutError" || name === "AbortError" || /timeout|timed out/i.test(message)) {
        return new ProviderError("PROVIDER_TIMEOUT", `上游请求超时（${host}）`, { retryable: true });
    }
    return new ProviderError("PROVIDER_UPSTREAM_ERROR", `无法连接上游（${host}）：${truncate(message)}`, { retryable: true });
}

/** 从 URL 里取 host，失败时返回占位符（错误信息里不能出现完整 URL，可能带 query 密钥）。 */
function safeHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "未知主机";
    }
}

/** content-type → mime（去掉 charset 等参数）。 */
function normalizeMime(contentType: string): string {
    const base = (contentType || "").split(";")[0]!.trim().toLowerCase();
    return base.length > 0 ? base : "application/octet-stream";
}

/** 轮询参数。 */
export type PollOptions<T> = {
    /** 轮询间隔（毫秒）。 */
    intervalMs: number;
    /** 总超时（毫秒）。 */
    timeoutMs: number;
    /** 单次探测；返回 null 表示"还没好"。 */
    probe: () => Promise<T | null>;
    /** 每次探测后的回调（写 progress 用）。 */
    onTick?: (elapsedMs: number) => void;
};

/**
 * 轮询直到 `probe` 返回非 null。
 *
 * 移植自 web 端 `poll()`，但加了两点：
 * - 超时后抛 `PROVIDER_TIMEOUT`（可重试），而不是静默返回 null；
 * - `onTick` 让 Worker 能把进度写回 `jobs.progress`（前端进度条不再是假的）。
 */
export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
    const startedAt = Date.now();
    for (;;) {
        const value = await options.probe();
        if (value !== null) return value;

        const elapsed = Date.now() - startedAt;
        options.onTick?.(elapsed);
        if (elapsed + options.intervalMs > options.timeoutMs) {
            throw new ProviderError("PROVIDER_TIMEOUT", `上游任务在 ${Math.round(options.timeoutMs / 1000)}s 内未完成`, { retryable: true });
        }
        await sleep(options.intervalMs);
    }
}

/** Promise 化 sleep。 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
    });
}

/** base64 → 字节（Bun 与 Node 都提供 Buffer）。 */
export function base64ToBytes(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64"));
}

/** 字节 → base64。 */
export function bytesToBase64(value: Uint8Array): string {
    return Buffer.from(value).toString("base64");
}

/** 从 data URL 拆出 mime 与字节；不是 data URL 时返回 null。 */
export function parseDataUrl(value: string): { mime: string; bytes: Uint8Array } | null {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(value);
    if (!match) return null;
    const mime = match[1] || "application/octet-stream";
    const payload = match[3] ?? "";
    return match[2] ? { mime, bytes: base64ToBytes(payload) } : { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}
