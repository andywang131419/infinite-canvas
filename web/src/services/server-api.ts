/**
 * server-api —— 面向本仓库自建服务端（`server/`）的 API 客户端（T04-A1）。
 *
 * 与 `lib/api-client.ts` 的关系：
 * - `lib/api-client.ts` 是**信封解包的唯一实现**（`{ok,data}` / `{ok:false,code,...}`）；
 * - 本文件在它之上补三件业务侧必须的事，**不重复实现解包**：
 *     1. 超时（普通请求 30s；上传按体积放宽）—— 没有超时的 `fetch` 会挂到用户放弃；
 *     2. 错误归一为 `ServerApiError`（保留 `status` / `code` / `details`）；
 *     3. 401 / `SETUP_REQUIRED` 广播全局事件，让登录闸门能立刻反应，
 *        而不是等下一次路由跳转才发现会话过期。
 *
 * 为什么 `ServerApiError` 继承 `ApiError` 而不是 `Error`：
 * 仓库里既有的 `instanceof ApiError` 分支（`use-auth-store`、各错误文案函数）必须继续成立，
 * 否则一次"顺手换客户端"就会让登录失败提示退化成"未知错误"。
 */

import { ApiError, apiRequest, type ApiRequestInit } from "@/lib/api-client";

/** 会话过期（401）时广播的事件名。 */
export const AUTH_REQUIRED_EVENT = "app:auth-required";

/** 系统未初始化（403 `SETUP_REQUIRED`）时广播的事件名。 */
export const SETUP_REQUIRED_EVENT = "app:setup-required";

/** 普通请求超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 上传请求的最小超时（毫秒）—— 大文件按体积线性放宽，但不低于这个值。 */
export const UPLOAD_MIN_TIMEOUT_MS = 60_000;

/** 上传吞吐基准：每 50KB 给 1 秒（≈50KB/s，比家用上行还保守）。 */
const UPLOAD_BYTES_PER_SECOND = 50 * 1024;

/** 服务端 API 调用失败。`status === 0` 表示请求根本没到达服务端。 */
export class ServerApiError extends ApiError {
    constructor(code: string, message: string, status: number, details?: unknown) {
        super(code, message, status, details);
        this.name = "ServerApiError";
    }

    /** 是否为超时。 */
    get isTimeout(): boolean {
        return this.code === "TIMEOUT";
    }

    /** 是否为「系统未初始化」。 */
    get isSetupRequired(): boolean {
        return this.code === "SETUP_REQUIRED";
    }
}

/** 按响应体体积估算上传超时。 */
export function uploadTimeoutFor(bytes: number): number {
    const estimated = Math.ceil((Math.max(0, bytes) / UPLOAD_BYTES_PER_SECOND) * 1000);
    return Math.max(UPLOAD_MIN_TIMEOUT_MS, estimated);
}

/** 广播一个全局事件（SSR / 测试环境里没有 `window` 时静默跳过）。 */
function broadcast(name: string, detail: Record<string, unknown>): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * 把一次失败调用翻译成 `ServerApiError`，并在需要时广播全局事件。
 *
 * 事件只在"确实需要用户动作"时发：401 → 去登录页；403 + `SETUP_REQUIRED` → 去初始化页。
 * 其余错误（校验失败、冲突、上游报错）只是普通业务失败，不该打断用户。
 */
function normalizeError(error: unknown): ServerApiError {
    const normalized =
        error instanceof ServerApiError
            ? error
            : error instanceof ApiError
              ? new ServerApiError(error.code, error.message, error.status, error.details)
              : new ServerApiError("NETWORK_ERROR", error instanceof Error ? error.message : "网络请求失败", 0);

    if (normalized.status === 401) {
        broadcast(AUTH_REQUIRED_EVENT, { code: normalized.code, message: normalized.message });
    } else if (normalized.status === 403 && normalized.code === "SETUP_REQUIRED") {
        broadcast(SETUP_REQUIRED_EVENT, { code: normalized.code, message: normalized.message });
    }

    return normalized;
}

/** 带超时的请求选项。 */
export type ServerRequestInit = Omit<ApiRequestInit, "signal"> & {
    /** 覆盖默认超时；传 `0` 表示不额外计时（长任务用）。 */
    timeoutMs?: number;
    signal?: AbortSignal;
};

/**
 * 发起一次带超时的请求并解包信封。
 *
 * 超时与调用方 `signal` 通过同一个 `AbortController` 合并：
 * 谁先触发都算取消，但只有"我方计时器"触发时才报 `TIMEOUT`。
 */
async function request<T>(path: string, init: ServerRequestInit, method: string, body?: unknown): Promise<T> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers, ...rest } = init;

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    }
    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  abort();
              }, timeoutMs)
            : null;

    try {
        return await apiRequest<T>(path, { ...rest, method, body, headers, signal: controller.signal });
    } catch (error) {
        if (timedOut) throw new ServerApiError("TIMEOUT", `请求超时（${Math.round(timeoutMs / 1000)}s）`, 0);
        if (signal?.aborted) throw new ServerApiError("ABORTED", "请求已取消", 0);
        throw normalizeError(error);
    } finally {
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
}

/** GET。 */
export function apiGet<T>(path: string, init: ServerRequestInit = {}): Promise<T> {
    return request<T>(path, init, "GET");
}

/** POST（对象 body → JSON）。 */
export function apiPost<T>(path: string, body?: unknown, init: ServerRequestInit = {}): Promise<T> {
    return request<T>(path, init, "POST", body);
}

/** PUT（对象 body → JSON）。 */
export function apiPut<T>(path: string, body?: unknown, init: ServerRequestInit = {}): Promise<T> {
    return request<T>(path, init, "PUT", body);
}

/** DELETE。 */
export function apiDelete<T>(path: string, init: ServerRequestInit = {}): Promise<T> {
    return request<T>(path, init, "DELETE");
}

/**
 * 上传原始字节（PUT 到 `/api/assets?key=...`）。
 *
 * 刻意**不走 FormData**：
 * - 服务端 `/api/assets` 直接读请求体字节 + `content-type`，多一层 multipart 只会多一层解析；
 * - 前端也不需要构造 `File`，省一次内存拷贝。
 *
 * @param path 已带好 query 的路径，例如 `/api/assets?key=image%3Aabc`
 * @param bytes 二进制内容
 * @param mime 内容类型（服务端会过 MIME 白名单，非法值会被降级成 octet-stream）
 */
export async function apiUpload<T>(path: string, bytes: Blob, mime?: string): Promise<T> {
    const contentType = mime || bytes.type || "application/octet-stream";
    return request<T>(path, { headers: { "content-type": contentType }, timeoutMs: uploadTimeoutFor(bytes.size) }, "PUT", bytes);
}
