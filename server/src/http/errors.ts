/**
 * 统一错误码表（ARCH §9.3 / Rev2 保留）。
 *
 * 前后端共用：服务端返回 `{ ok:false, code, message, details? }`，
 * 前端按 `code` 分支而非匹配字符串（§4.0）。
 */

/** 全部业务错误码。 */
export const ERROR_CODES = {
    UNAUTHORIZED: 401,
    INVALID_CREDENTIALS: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    VALIDATION_FAILED: 400,
    /** T02：画布 doc 超过 `MAX_DOC_JSON_MB`（默认 8MB）。 */
    DOC_TOO_LARGE: 413,
    /** T02：`Range` 请求头不可满足（RFC 7233）。 */
    RANGE_NOT_SATISFIABLE: 416,
    REVISION_CONFLICT: 409,
    IDEMPOTENCY_DUPLICATE: 409,
    /** T02：`/api/setup` 在 users 表非空时被调用。 */
    ALREADY_INITIALIZED: 409,
    /** T02：系统尚未初始化（users 表为空），需先走 `/api/setup`。 */
    SETUP_REQUIRED: 403,
    PROVIDER_KEY_MISSING: 400,
    PROVIDER_UPSTREAM_ERROR: 502,
    PROVIDER_CONTENT_REJECTED: 422,
    PROVIDER_TIMEOUT: 504,
    QUOTA_EXCEEDED: 429,
    STORAGE_WRITE_FAILED: 500,
    BACKUP_FAILED: 500,
    RATE_LIMITED: 429,
    INTERNAL: 500,
} as const;

/** 业务错误码字面量联合类型。 */
export type ErrorCode = keyof typeof ERROR_CODES;

/** 错误码对应的 HTTP 状态。 */
export function httpStatusFor(code: ErrorCode): number {
    return ERROR_CODES[code];
}

/** 各错误码的默认人话文案（前端可覆盖）。 */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
    UNAUTHORIZED: "请先登录",
    INVALID_CREDENTIALS: "账号或密码不正确",
    FORBIDDEN: "无权限操作该资源",
    NOT_FOUND: "资源不存在",
    VALIDATION_FAILED: "参数不合法",
    DOC_TOO_LARGE: "画布内容过大",
    RANGE_NOT_SATISFIABLE: "请求的字节范围不可满足",
    REVISION_CONFLICT: "另一端已更新画布",
    IDEMPOTENCY_DUPLICATE: "重复提交",
    ALREADY_INITIALIZED: "系统已完成初始化",
    SETUP_REQUIRED: "系统尚未初始化，请先创建管理员账号",
    PROVIDER_KEY_MISSING: "该渠道尚未配置密钥",
    PROVIDER_UPSTREAM_ERROR: "上游服务返回错误",
    PROVIDER_CONTENT_REJECTED: "内容被上游审核拒绝",
    PROVIDER_TIMEOUT: "上游服务超时",
    QUOTA_EXCEEDED: "额度或并发超限",
    STORAGE_WRITE_FAILED: "文件写入失败",
    BACKUP_FAILED: "备份失败",
    RATE_LIMITED: "请求过于频繁",
    INTERNAL: "服务器内部错误",
};

/**
 * 业务异常。service 层抛它，http 层统一转成响应包。
 *
 * `details` 会原样回传前端（例如 `VALIDATION_FAILED` 的字段级信息），
 * 但**绝不**包含堆栈（§9.3 INTERNAL 约定）。
 */
export class ApiError extends Error {
    readonly code: ErrorCode;
    readonly status: number;
    readonly details?: unknown;

    constructor(code: ErrorCode, message?: string, details?: unknown) {
        super(message ?? DEFAULT_MESSAGES[code]);
        this.name = "ApiError";
        this.code = code;
        this.status = httpStatusFor(code);
        this.details = details;
    }

    /** 便捷构造：参数校验失败。 */
    static validation(message?: string, details?: unknown): ApiError {
        return new ApiError("VALIDATION_FAILED", message, details);
    }

    /** 便捷构造：未找到。 */
    static notFound(message?: string): ApiError {
        return new ApiError("NOT_FOUND", message);
    }
}
