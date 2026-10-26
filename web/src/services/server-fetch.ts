/**
 * server-fetch —— 把所有"发给第三方 AI 上游"的请求收口到服务端 `/api/proxy`（T04-A2）。
 *
 * 为什么要收口（而不是继续用 canvas-proxy 本地代理）：
 * 1. 浏览器直连第三方 API 会被 CORS 拦掉，本地代理要求用户装 Node 包；
 *    服务端代理把这两件事一起解决，且是**唯一**知道渠道密钥的地方；
 * 2. 密钥不再出现在前端网络面板里（`authorization` 由服务端注入，客户端传了也会被丢弃）；
 * 3. 白名单 + 内网拦截（见 `server/src/proxy/guard.ts`）只有服务端能做。
 *
 * 三条分流规则（`serverFetch`）：
 *
 * | 目标 URL                        | 走向                                        |
 * |---------------------------------|---------------------------------------------|
 * | `/api/...` 等站内相对路径        | 直接 `fetch`（同源，不走代理）                |
 * | `data:` / `blob:` 等非 http(s)   | 直接 `fetch`（本地资源，没什么可代理的）      |
 * | `http(s)://` 绝对地址            | `POST /api/proxy`，由服务端代发              |
 *
 * 代理的两种请求体形态（与 `server/src/routes/proxy.ts` 一一对应）：
 * - **JSON 分支**：`POST /api/proxy`，body = `{ url, method, headers, body }`；
 *   用于普通 JSON / SSE 流式请求。
 * - **字节分支**：`POST /api/proxy?url=<encoded>`，body 是原始字节（multipart / octet-stream）；
 *   用于图生图 `/images/edits`、视频 `/videos` 这类 multipart 上传 ——
 *   这类请求体不能被 JSON 序列化，只能原样搬运。
 *
 * 额外提供一层"axios 形状"的 `upstreamRequest/upstreamGet/upstreamPost`：
 * 老代码里 axios 的 `{ response.data }` / `responseType: "blob"` / `params` 用法非常多，
 * 逐处改写成裸 `fetch` 只会引入回归；这里保持同样的调用形状，
 * 底层换成 `serverFetch`，从而**一次收口、调用点近乎零改动**。
 */

/** 代理端点（同源相对路径）。 */
const PROXY_PATH = "/api/proxy";

/**
 * 允许透传给上游的请求头。
 *
 * 与 `server/src/routes/proxy.ts` 的 `FORWARDABLE_HEADERS` 保持一致：
 * `authorization` / `cookie` / `host` 永远不在这里 —— 密钥由服务端注入。
 */
const FORWARDABLE_HEADERS = new Set(["content-type", "accept", "accept-language"]);

/** `serverFetch` 的初始化参数（body 收窄成浏览器原生 `BodyInit`）。 */
export type ServerFetchInit = Omit<RequestInit, "body" | "headers"> & {
    headers?: HeadersInit;
    body?: BodyInit | null;
};

/** 是否为「站内相对路径」（`/api/x`；`//host/x` 是协议相对地址，不算）。 */
function isSiteRelative(url: string): boolean {
    return url.startsWith("/") && !url.startsWith("//");
}

/** 是否是可以让浏览器直接取的本地资源（`data:` / `blob:` / 相对路径）。 */
function isLocallyFetchable(url: string): boolean {
    return isSiteRelative(url) || !/^https?:\/\//i.test(url);
}

/** 只挑出允许透传的请求头，键统一小写。 */
function forwardableHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (FORWARDABLE_HEADERS.has(lower)) result[lower] = value;
    });
    return result;
}

/** 是否为二进制请求体（不能塞进 JSON 信封）。 */
function isBinaryBody(body: unknown): body is Blob | ArrayBuffer | ArrayBufferView {
    return body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

/** 是否为 `FormData`（multipart，交给浏览器自动生成 boundary）。 */
function isFormDataBody(body: unknown): body is FormData {
    return typeof FormData !== "undefined" && body instanceof FormData;
}

/** 把请求体序列化成代理信封里的 `body` 字段（字符串原样，其余 JSON）。 */
function serializeEnvelopeBody(body: BodyInit | null | undefined): string | undefined {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    return JSON.stringify(body);
}

/**
 * 发一次上游请求。
 *
 * 返回值是**真的 `Response`**（含 status / headers / 可读流），
 * 因此 SSE 流式解析、`response.blob()` 这些既有逻辑一行都不用改。
 */
export async function serverFetch(input: string, init: ServerFetchInit = {}): Promise<Response> {
    const url = String(input);
    const { headers: rawHeaders, body, ...rest } = init;
    const headers = new Headers(rawHeaders);

    // ---- 分流 1/2：站内相对路径、data:/blob: 等等，浏览器自己能取 ----
    if (isLocallyFetchable(url)) {
        return fetch(url, { ...rest, headers, body } as RequestInit);
    }

    // ---- 分流 3a：二进制 / multipart → 字节分支 ----
    if (isFormDataBody(body) || isBinaryBody(body)) {
        const uploadHeaders = new Headers();
        // FormData 的 content-type 必须留给浏览器自己写（里面带 boundary）。
        if (!isFormDataBody(body)) {
            const declared = headers.get("content-type") ?? (body instanceof Blob ? body.type : "");
            uploadHeaders.set("content-type", declared && declared.startsWith("multipart/") ? declared : "application/octet-stream");
        }
        const accept = headers.get("accept");
        if (accept) uploadHeaders.set("accept", accept);
        const acceptLanguage = headers.get("accept-language");
        if (acceptLanguage) uploadHeaders.set("accept-language", acceptLanguage);

        return fetch(`${PROXY_PATH}?url=${encodeURIComponent(url)}`, {
            method: "POST",
            headers: uploadHeaders,
            body: body as BodyInit,
            signal: rest.signal,
            credentials: "same-origin",
        });
    }

    // ---- 分流 3b：其余（JSON / 文本）→ JSON 信封分支 ----
    const method = (rest.method ?? (body === undefined || body === null ? "GET" : "POST")).toUpperCase();
    const upstreamHeaders = forwardableHeaders(headers);
    if (body !== undefined && body !== null && upstreamHeaders["content-type"] === undefined) {
        upstreamHeaders["content-type"] = "application/json";
    }

    const envelope = JSON.stringify({
        url,
        method,
        headers: upstreamHeaders,
        body: serializeEnvelopeBody(body),
    });

    return fetch(PROXY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: headers.get("accept") ?? "application/json" },
        body: envelope,
        signal: rest.signal,
        credentials: "same-origin",
    });
}

/** 上游响应的响应体解析方式（对齐 axios 的 `responseType`）。 */
export type UpstreamResponseType = "json" | "blob" | "text" | "arraybuffer";

/** 一次上游请求的配置（axios 形状的子集，够本仓库所有调用点用）。 */
export type UpstreamRequestConfig = {
    method?: string;
    headers?: Record<string, string>;
    /** 请求体：对象 → JSON；字符串/FormData/Blob 原样。 */
    data?: unknown;
    /** 查询参数（值为 `undefined` 的键会被跳过）。 */
    params?: Record<string, unknown>;
    responseType?: UpstreamResponseType;
    signal?: AbortSignal;
    /** 超时（毫秒）。缺省不额外计时 —— 服务端代理自身有 15 分钟总超时。 */
    timeout?: number;
};

/** 一次上游请求的结果。 */
export type UpstreamResponse<T> = { data: T; status: number; headers: Headers };

/**
 * 上游调用失败。
 *
 * 形状刻意对齐 axios 错误：`response.status` / `response.data` / `code === "ERR_NETWORK"`，
 * 这样 `image.ts` / `video.ts` / `audio.ts` 里既有的错误文案提取逻辑可以原样复用。
 */
export class UpstreamError extends Error {
    /** 上游响应（拿到 4xx/5xx 时才有）。 */
    readonly response?: { status: number; data: unknown };
    /** `ERR_NETWORK`（连不上）/ `ECONNABORTED`（超时）/ `HTTP_ERROR`。 */
    readonly code?: string;
    /** 是否为用户主动取消。 */
    readonly canceled: boolean;

    constructor(message: string, options: { response?: { status: number; data: unknown }; code?: string; canceled?: boolean } = {}) {
        super(message);
        this.name = "UpstreamError";
        this.response = options.response;
        this.code = options.code;
        this.canceled = options.canceled === true;
    }
}

/** 是否为上游调用失败。 */
export function isUpstreamError(error: unknown): error is UpstreamError {
    return error instanceof UpstreamError;
}

/** 是否为「用户取消 / 组件卸载」导致的失败。 */
export function isUpstreamCancel(error: unknown): boolean {
    if (error instanceof UpstreamError) return error.canceled;
    return error instanceof DOMException && error.name === "AbortError";
}

/** 取 `signal.reason` 作为取消原因（没有就用标准 AbortError）。 */
function abortReason(signal: AbortSignal): unknown {
    if (signal.reason instanceof Error) return signal.reason;
    return new DOMException("Aborted", "AbortError");
}

/** 把 `params` 拼进 URL 的查询串。 */
function withParams(url: string, params?: Record<string, unknown>): string {
    if (!params) return url;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item !== undefined && item !== null) search.append(key, String(item));
            }
            continue;
        }
        search.set(key, String(value));
    }
    const query = search.toString();
    if (!query) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/** 按 `responseType` 解析响应体；空响应体返回 `null`。 */
async function readResponseBody<T>(response: Response, responseType: UpstreamResponseType): Promise<T> {
    if (responseType === "blob") return (await response.blob()) as unknown as T;
    if (responseType === "arraybuffer") return (await response.arrayBuffer()) as unknown as T;
    if (responseType === "text") return (await response.text()) as unknown as T;
    const text = await response.text();
    if (!text) return null as unknown as T;
    try {
        return JSON.parse(text) as T;
    } catch {
        // 上游偶尔返回 HTML 错误页（网关挂了），原样交给上层做文案提取。
        return text as unknown as T;
    }
}

/** 把失败响应的 body 读出来（JSON 优先，失败退回文本），供文案提取使用。 */
async function readErrorBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => "");
    if (!text) return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

/** 把 `data` 归一成可以交给 `serverFetch` 的请求体。 */
function toRequestBody(data: unknown, headers: Headers): BodyInit | undefined {
    if (data === undefined || data === null) return undefined;
    if (isFormDataBody(data) || isBinaryBody(data)) return data as BodyInit;
    if (typeof data === "string") return data;
    if (data instanceof URLSearchParams) return data;
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return JSON.stringify(data);
}

/**
 * 发起一次上游请求（axios 形状）。
 *
 * - 2xx：`{ data, status, headers }`
 * - 非 2xx：抛 `UpstreamError`，`response.data` 是解析后的错误体
 * - 连不上：抛 `UpstreamError{ code: "ERR_NETWORK" }`
 * - 超时：抛 `UpstreamError{ code: "ECONNABORTED" }`
 * - 主动取消：抛原 `AbortError`（保持既有 `isUpstreamCancel` / `DOMException` 分支）
 */
export async function upstreamRequest<T = unknown>(config: UpstreamRequestConfig & { url: string }): Promise<UpstreamResponse<T>> {
    const method = (config.method ?? (config.data === undefined ? "GET" : "POST")).toUpperCase();
    const responseType = config.responseType ?? "json";
    const url = withParams(config.url, config.params);

    const headers = new Headers();
    for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, value);
    if (responseType === "json" && !headers.has("accept")) headers.set("accept", "application/json");

    const body = toRequestBody(config.data, headers);

    // 超时用独立 controller：外部 signal 取消也要能打断。
    const controller = new AbortController();
    const external = config.signal;
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer =
        config.timeout && config.timeout > 0
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort();
              }, config.timeout)
            : null;

    let response: Response;
    try {
        response = await serverFetch(url, { method, headers, body, signal: controller.signal });
    } catch (error) {
        if (timedOut) throw new UpstreamError("请求超时", { code: "ECONNABORTED" });
        if (external?.aborted) throw abortReason(external);
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new UpstreamError(error instanceof Error ? error.message : "网络请求失败", { code: "ERR_NETWORK" });
    } finally {
        if (timer !== null) clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
    }

    if (!response.ok) {
        const data = await readErrorBody(response);
        throw new UpstreamError(`上游返回 HTTP ${response.status}`, { response: { status: response.status, data }, code: "HTTP_ERROR" });
    }

    const data = await readResponseBody<T>(response, responseType);
    return { data, status: response.status, headers: response.headers };
}

/** GET 简写（对齐 `axios.get`）。 */
export function upstreamGet<T = unknown>(url: string, config: Omit<UpstreamRequestConfig, "url" | "method" | "data"> = {}): Promise<UpstreamResponse<T>> {
    return upstreamRequest<T>({ ...config, url, method: "GET" });
}

/** POST 简写（对齐 `axios.post`）。 */
export function upstreamPost<T = unknown>(url: string, data?: unknown, config: Omit<UpstreamRequestConfig, "url" | "method" | "data"> = {}): Promise<UpstreamResponse<T>> {
    return upstreamRequest<T>({ ...config, url, method: "POST", data });
}
