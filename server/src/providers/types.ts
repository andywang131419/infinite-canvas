/**
 * Provider 适配器契约（T03 第 C 条）。
 *
 * 分层原则（与 `web/src/services/api/*` 的移植关系）：
 * - **纯函数层**：`build*Request()` / `parse*()` 只做「入参 → 请求描述」与
 *   「上游 JSON → 结构化结果」，不发网络请求。`scripts/verify-t03.mjs` 就是
 *   靠这一层跑 golden fixture 对比，不需要真的连上游。
 * - **执行层**：`providers/index.ts` 负责发请求、轮询、下载、重试分类。
 * - **业务层**：`jobs/handlers/*` 负责取渠道密钥、落存储、写回任务状态。
 *
 * 本文件**不得** import 任何 DB / env 模块：
 * 适配器必须能在没有 SQLite、没有环境变量的进程里被加载（校验脚本要用）。
 */

/** 上游协议族。 */
export type ProviderFormat = "openai" | "gemini";

/** 一次调用的上下文（密钥只在内存里存活，不落任何持久化结构）。 */
export type ProviderContext = {
    format: ProviderFormat;
    /** 渠道 baseUrl（已规范化，末尾无斜杠）。 */
    baseUrl: string;
    /** 明文密钥；**禁止**进入日志/错误信息/返回值。 */
    apiKey: string;
    model: string;
    /** 单次 HTTP 请求超时（毫秒）。 */
    timeoutMs: number;
};

/** 一段二进制素材（参考图/音频/视频帧）。 */
export type MediaBytes = {
    mime: string;
    bytes: Uint8Array;
};

/** 图像生成/编辑入参。 */
export type ImageParams = {
    prompt: string;
    /** 参考图（编辑必须有；生成通常为空）。 */
    references: MediaBytes[];
    /** 生成张数。 */
    count: number;
    /** 像素尺寸，形如 `1024x1024`；`undefined` 表示交给上游默认值。 */
    size?: string;
    /** `low|medium|high|xhigh|max`。 */
    quality?: string;
    /** 仅 `transparent` 会被下发。 */
    background?: string;
};

/** 视频生成入参。 */
export type VideoParams = {
    prompt: string;
    /** `frames` = 首尾帧；`reference` = 多图参考。 */
    mode: "frames" | "reference";
    seconds: number;
    /** 像素尺寸，形如 `1280x720`。 */
    size?: string;
    /** 分辨率档位，形如 `720p`。 */
    resolution?: string;
    /** 宽高比，形如 `16:9`。 */
    ratio?: string;
    generateAudio: boolean;
    watermark: boolean;
    /** 参考素材（首帧/尾帧/多图参考，按 mode 解释）。 */
    references: MediaBytes[];
};

/** 语音合成入参。 */
export type AudioParams = {
    prompt: string;
    voice?: string;
    /** 输出容器格式，默认 mp3。 */
    format: string;
    speed?: number;
    instructions?: string;
};

/** LLM 消息（已扁平化为纯文本，避免把画布结构带进适配器）。 */
export type LlmMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

/** LLM 入参。 */
export type LlmParams = {
    messages: LlmMessage[];
    /** `low|medium|high|xhigh`；只对 OpenAI `/responses` 生效。 */
    reasoningEffort?: string;
};

/** 一次代生成的结果。 */
export type GenerationResult = {
    /** 结果二进制（图片可能多张）。 */
    media: MediaBytes[];
    /** 上游回报的真实花费（拿不到为 null）。 */
    costActual: number | null;
    /** 上游二级任务 ID（视频轮询用），无则为 null。 */
    upstreamTaskId?: string | null;
};

/**
 * 适配器错误码。
 *
 * 与 `http/errors.ts` 的 ErrorCode 保持同名子集，但**故意**不复用后者：
 * 适配器要能在没有 HTTP 层的校验脚本里独立加载。
 * Worker 会把这里的 code 直接写进 `jobs.error_code`。
 */
export type ProviderErrorCode =
    | "PROVIDER_UPSTREAM_ERROR"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_CONTENT_REJECTED"
    | "QUOTA_EXCEEDED"
    | "PROVIDER_KEY_MISSING"
    | "INTERNAL";

/**
 * 适配器异常。
 *
 * `retryable` 是**业务判断**而不是 HTTP 状态码的机械映射：
 * 429 / 5xx / 网络中断可重试；400 参数错、内容审核拒绝不可重试
 * （重试只会同样的失败并浪费额度）。
 */
export class ProviderError extends Error {
    readonly code: ProviderErrorCode;
    readonly retryable: boolean;
    readonly status: number | null;

    constructor(code: ProviderErrorCode, message: string, options?: { retryable?: boolean; status?: number | null }) {
        super(message);
        this.name = "ProviderError";
        this.code = code;
        this.retryable = options?.retryable ?? false;
        this.status = options?.status ?? null;
    }
}

/** 判断是否是适配器异常（Worker 用）。 */
export function isProviderError(error: unknown): error is ProviderError {
    return error instanceof ProviderError;
}
