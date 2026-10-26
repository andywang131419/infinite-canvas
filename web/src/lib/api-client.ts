/**
 * 前端 API 客户端（ARCH Rev2 §R6.8 / T01 第 7 条配套）。
 *
 * 唯一职责：把「同域相对路径 + 统一响应包」这套约定封装成三个函数，
 * 让业务代码不关心 baseURL、Cookie、错误码解析。
 *
 * 约定（ARCH §4.0）：
 *   成功 → `{ ok: true,  data: T }`
 *   失败 → `{ ok: false, code: "XXX", message: string, details?: unknown }`
 *
 * 关键点：默认 `API_BASE_URL` 为空 = 同域请求。
 * 因此开发期走 vite proxy、生产期走 Caddy 分流，**两端行为完全一致**，
 * 不需要 CORS、不需要 `credentials: "include"` 的跨域特例。
 */

import { API_BASE_URL } from "@/constant/runtime-config";

/** 服务端统一响应包。 */
export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; code: string; message: string; details?: unknown };

/** 业务错误码（与 server/src/http/errors.ts 保持一致，见 ARCH §9.3）。 */
export type ApiErrorCode =
    | "UNAUTHORIZED"
    | "INVALID_CREDENTIALS"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "VALIDATION_FAILED"
    | "REVISION_CONFLICT"
    | "IDEMPOTENCY_DUPLICATE"
    | "PROVIDER_KEY_MISSING"
    | "PROVIDER_UPSTREAM_ERROR"
    | "PROVIDER_CONTENT_REJECTED"
    | "PROVIDER_TIMEOUT"
    | "QUOTA_EXCEEDED"
    | "STORAGE_WRITE_FAILED"
    | "BACKUP_FAILED"
    | "RATE_LIMITED"
    | "INTERNAL"
    // 客户端侧补充码：请求根本没到达服务端（断网 / 后端未启动）
    | "NETWORK_ERROR";

/** API 调用失败。前端应基于 `code` 分支，而不是匹配 `message` 文本。 */
export class ApiError extends Error {
    readonly code: ApiErrorCode | string;
    readonly status: number;
    readonly details?: unknown;

    constructor(code: ApiErrorCode | string, message: string, status: number, details?: unknown) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
        this.details = details;
    }

    /** 是否为「需要重新登录」类错误。 */
    get isAuthError(): boolean {
        return this.status === 401;
    }

    /** 是否为「另一台设备已更新」冲突。 */
    get isConflict(): boolean {
        return this.code === "REVISION_CONFLICT";
    }
}

/**
 * 拼接完整请求地址。
 *
 * @param path 以 `/` 开头的 API 路径，例如 `"/api/health"`。
 *             传绝对 URL（`http://...`）时原样返回，便于对接 WebDAV 等外部端点。
 */
export function apiUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${API_BASE_URL}${normalized}`;
}

/** 请求选项：`body` 允许直接传对象，内部自动 JSON 序列化。 */
export type ApiRequestInit = Omit<RequestInit, "body"> & {
    /** 传对象 → 自动 `JSON.stringify` + `Content-Type: application/json`；传字符串/Blob 等则原样透传。 */
    body?: unknown;
};

/** 判断是否「可原样作为 body 透传」的二进制/文本类型。 */
function isRawBody(value: unknown): value is BodyInit {
    return (
        typeof value === "string" ||
        value instanceof Blob ||
        value instanceof FormData ||
        value instanceof URLSearchParams ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value) ||
        (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
    );
}

/**
 * 发起一次 API 请求并解包响应。
 *
 * - 自动带 `Accept: application/json`
 * - 对象 body 自动 JSON 序列化
 * - 统一把失败响应转成 `ApiError`（含 code / status / details）
 * - 网络层失败（fetch 抛错）也转成 `ApiError("NETWORK_ERROR")`，调用方只处理一种错误类型
 */
export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
    const { body, headers, ...rest } = init;

    const finalHeaders = new Headers(headers);
    if (!finalHeaders.has("Accept")) finalHeaders.set("Accept", "application/json");

    let finalBody: BodyInit | undefined;
    if (body !== undefined && body !== null) {
        if (isRawBody(body)) {
            finalBody = body;
        } else {
            finalBody = JSON.stringify(body);
            if (!finalHeaders.has("Content-Type")) finalHeaders.set("Content-Type", "application/json");
        }
    }

    let response: Response;
    try {
        response = await fetch(apiUrl(path), {
            ...rest,
            headers: finalHeaders,
            body: finalBody,
            // 同域请求默认就会带 Cookie；显式声明让「拆子域」时行为可预期。
            credentials: rest.credentials ?? "same-origin",
        });
    } catch (error) {
        throw new ApiError("NETWORK_ERROR", error instanceof Error ? error.message : "网络请求失败", 0);
    }

    // 204 / 空响应体
    if (response.status === 204) return undefined as unknown as T;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
        const text = await response.text().catch(() => "");
        if (!response.ok) {
            throw new ApiError("INTERNAL", `服务端返回非 JSON 响应（HTTP ${response.status}）`, response.status, text.slice(0, 500));
        }
        return text as unknown as T;
    }

    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

    if (!payload || typeof payload !== "object" || !("ok" in payload)) {
        throw new ApiError("INTERNAL", `响应格式不符合约定（HTTP ${response.status}）`, response.status, payload);
    }

    if (!payload.ok) {
        throw new ApiError(payload.code, payload.message, response.status, payload.details);
    }

    return payload.data;
}

/** GET 简写。 */
export function apiGet<T>(path: string, init: Omit<ApiRequestInit, "body" | "method"> = {}): Promise<T> {
    return apiRequest<T>(path, { ...init, method: "GET" });
}

/** POST 简写。 */
export function apiPost<T>(path: string, body?: unknown, init: Omit<ApiRequestInit, "body" | "method"> = {}): Promise<T> {
    return apiRequest<T>(path, { ...init, method: "POST", body });
}

/** PUT 简写。 */
export function apiPut<T>(path: string, body?: unknown, init: Omit<ApiRequestInit, "body" | "method"> = {}): Promise<T> {
    return apiRequest<T>(path, { ...init, method: "PUT", body });
}

/** DELETE 简写。 */
export function apiDelete<T>(path: string, init: Omit<ApiRequestInit, "body" | "method"> = {}): Promise<T> {
    return apiRequest<T>(path, { ...init, method: "DELETE" });
}

/** `/api/health` 的响应形状（T01 已可用，其余在 T02+ 补齐）。 */
export type HealthPayload = {
    version: string;
    db: "ok";
    worker: string;
    backup: string;
    env: string;
    uptimeMs: number;
    time: string;
    database: {
        schemaVersion: number;
        journalMode: string;
        foreignKeys: boolean;
        migrationsTotal: number;
        migrationsAppliedOnBoot: string[];
    };
    workerDetail: {
        concurrency: number;
        pollMs: number;
        inFlight: number;
        ticks: number;
        registeredTypes: number;
    };
};

/** 探测后端是否可用（供启动自检 / 设置页展示）。 */
export function fetchHealth(): Promise<HealthPayload> {
    return apiGet<HealthPayload>("/api/health");
}
