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
 * - `ApiError` → 按其 code/status 输出
 * - 其他异常 → 统一 `INTERNAL`，**绝不把堆栈返回给前端**（§9.3）
 */
export function handleError(error: Error, c: Context) {
    const traceId = crypto.randomUUID();

    if (error instanceof ApiError) {
        return fail(c, error, { traceId });
    }

    // 未预期异常：服务端留全量日志，响应只给 traceId。
    console.error(`[${traceId}] 未处理异常 ${c.req.method} ${c.req.path}`, error);

    const internal = new ApiError("INTERNAL", "服务器内部错误", { traceId });
    return fail(c, internal, { traceId });
}

/** 404 兜底处理器（Hono 的 notFound）。 */
export function handleNotFound(c: Context) {
    return fail(c, new ApiError("NOT_FOUND", `接口不存在：${c.req.method} ${c.req.path}`));
}
