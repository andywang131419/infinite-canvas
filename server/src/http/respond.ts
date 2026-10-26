/**
 * 统一响应包（ARCH §4.0）。
 *
 * 成功：`{ ok: true,  data: {...} }`
 * 失败：`{ ok: false, code: "XXX", message: "人话", details?: {...} }`
 *
 * HTTP 状态码同时正确设置（400/401/403/404/409/429/500），
 * 前端按 `code` 分支，不匹配 message 字符串。
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { ApiError, type ErrorCode } from "./errors";

/** 成功响应体形状。 */
export type ApiSuccess<T> = { ok: true; data: T };

/** 失败响应体形状。 */
export type ApiFailure = { ok: false; code: ErrorCode; message: string; details?: unknown };

/** 返回成功响应。 */
export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
    const body: ApiSuccess<T> = { ok: true, data };
    return c.json(body, status);
}

/** 返回失败响应（已由 ApiError 承载 code/message）。 */
export function fail(c: Context, error: ApiError, extra?: { traceId?: string }) {
    const body: ApiFailure = {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
    };
    if (extra?.traceId) c.header("x-trace-id", extra.traceId);
    return c.json(body, error.status as ContentfulStatusCode);
}

/** 无内容响应（DELETE / logout 等）。 */
export function noContent(c: Context) {
    return c.body(null, 204);
}

/**
 * Hono 全局错误处理器。
 *
 * 处理顺序（顺序本身是有意义的）：
 * 1. `ApiError` → 按其 code/status 输出（业务错误，`details` 原样回传）；
 * 2. `HTTPException` → Hono 自身在"请求还没进到 handler"时就抛的错
 *    （请求体超限 413、URI 过长 414、畸形请求 400 等）。**必须先于兜底分支**，
 *    否则这些本来语义明确的 4xx 会被降级成 500 INTERNAL，
 *    前端拿到"服务器内部错误"，日志里也被打成"未处理异常"（QA P2-12）；
 * 3. 其他异常 → 统一 `INTERNAL`，**绝不把堆栈返回给前端**（§9.3）。
 */
export function handleError(error: Error, c: Context) {
    const traceId = crypto.randomUUID();

    if (error instanceof ApiError) {
        return fail(c, error, { traceId });
    }

    if (error instanceof HTTPException) {
        const mapped = new ApiError(errorCodeForStatus(error.status), httpExceptionMessage(error));
        // `ApiError` 的 status 由 code 派生，可能与 HTTPException 的 status 有细微出入；
        // 以 HTTPException 的 status 为准 —— 它才是客户端真正需要看到的那个。
        const body: ApiFailure = { ok: false, code: mapped.code, message: mapped.message };
        c.header("x-trace-id", traceId);
        return c.json(body, error.status as ContentfulStatusCode);
    }

    // 未预期异常：服务端留全量日志，响应只给 traceId。
    console.error(`[${traceId}] 未处理异常 ${c.req.method} ${c.req.path}`, error);

    const internal = new ApiError("INTERNAL", "服务器内部错误", { traceId });
    return fail(c, internal, { traceId });
}

/**
 * HTTP 状态码 → 最接近的业务错误码。
 *
 * 只映射"能出现"的几个：Hono 在进 handler 之前抛错的场景集中在 400/413/414/431。
 * 未命中一律 `INTERNAL`（保持原有兜底语义，不把未知状态码猜成 4xx）。
 */
function errorCodeForStatus(status: number): ErrorCode {
    switch (status) {
        case 400:
            return "VALIDATION_FAILED";
        case 401:
            return "UNAUTHORIZED";
        case 403:
            return "FORBIDDEN";
        case 404:
            return "NOT_FOUND";
        case 409:
            return "REVISION_CONFLICT";
        case 413:
            return "DOC_TOO_LARGE";
        case 429:
            return "RATE_LIMITED";
        default:
            return "INTERNAL";
    }
}

/**
 * HTTPException 的对外文案。
 *
 * 只对"框架层拦截"的两类给出准确人话（413 请求体超限 / 414 URI 过长），
 * 其余沿用 Hono 自带的 message —— 这些文案都是框架常量，不含内部细节。
 */
function httpExceptionMessage(error: HTTPException): string | undefined {
    if (error.status === 413) return "请求体超过上限（可在 MAX_UPLOAD_MB 调整）";
    if (error.status === 414) return "请求 URI 过长";
    return error.message.length > 0 ? error.message : undefined;
}

/** 404 兜底处理器（Hono 的 notFound）。 */
export function handleNotFound(c: Context) {
    return fail(c, new ApiError("NOT_FOUND", `接口不存在：${c.req.method} ${c.req.path}`));
}
