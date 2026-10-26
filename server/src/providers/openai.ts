/**
 * OpenAI 兼容协议适配器（覆盖 image / image_edit / video / audio / llm）。
 *
 * 移植来源（逐段对齐，不自由发挥）：
 * - `web/src/services/api/image.ts: requestGeneration`（`/images/generations`）
 * - `web/src/services/api/image.ts: requestEdit`（`/images/edits`，multipart）
 * - `web/src/services/api/model-plugin.ts` openai video 模板（`/v1/videos` + 轮询 + `/content`）
 * - `web/src/services/api/audio.ts: requestAudioGeneration`（`/audio/speech`）
 * - `web/src/services/api/model-plugin.ts` openai text 模板（`/v1/responses`）
 *
 * 两处**刻意**的差异（都有理由，见各自注释）：
 * 1. 参考图不再走 data URL 传参，而是直接以字节参与 multipart（服务端没有浏览器 File）；
 * 2. `gpt-image` 系列不接受 `response_format`，这里按模型名判断后省略
 *    —— 与 web 端一致，属于上游 API 的怪癖，不是可选优化。
 */

import { asString, base64ToBytes, downloadBytes, isRecord, openaiBase, pollUntil, sendBytes, sendJson } from "./http.ts";
import type { ProviderRequest } from "./http.ts";
import type {
    AudioParams,
    GenerationResult,
    ImageParams,
    LlmParams,
    MediaBytes,
    ProviderContext,
    VideoParams,
} from "./types.ts";
import { ProviderError } from "./types.ts";

/** 图像输出格式（与 web 端一致：统一 png，前端不必再猜扩展名）。 */
const IMAGE_OUTPUT_FORMAT = "png";

/** 结果图片数量上限（与 web 端 `Math.min(15, ...)` 对齐）。 */
const MAX_IMAGE_COUNT = 15;

/** 视频轮询间隔（web 端 2500ms）。 */
const VIDEO_POLL_INTERVAL_MS = 2500;

/** `gpt-image` 系列不接受 `response_format` 参数。 */
function rejectsResponseFormat(model: string): boolean {
    return /gpt-image/i.test(model);
}

/** 只允许把 `transparent` 透传给上游。 */
export function normalizeBackground(value: string | undefined): string | undefined {
    return value?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** 质量档位白名单（与 `web/src/services/api/image.ts: IMAGE_QUALITY_VALUES` 一致）。 */
const IMAGE_QUALITY_VALUES = ["low", "medium", "high", "xhigh", "max"];

/** 质量档位归一。 */
export function normalizeQuality(value: string | undefined): string | undefined {
    const normalized = (value ?? "").trim().toLowerCase();
    return IMAGE_QUALITY_VALUES.includes(normalized) ? normalized : undefined;
}

/** 生成张数夹紧到 [1, 15]。 */
export function clampImageCount(count: number): number {
    const value = Math.floor(Math.abs(Number(count)) || 1);
    return Math.max(1, Math.min(MAX_IMAGE_COUNT, value));
}

/** OpenAI 鉴权头。 */
function bearer(ctx: ProviderContext): Record<string, string> {
    return { Authorization: `Bearer ${ctx.apiKey}` };
}

/** 图像生成请求（`POST /images/generations`）。 */
export function buildImageGenerationRequest(ctx: ProviderContext, params: ImageParams): ProviderRequest {
    const count = clampImageCount(params.count);
    const quality = normalizeQuality(params.quality);
    const background = normalizeBackground(params.background);

    const body: Record<string, unknown> = {
        model: ctx.model,
        prompt: params.prompt,
        n: count,
        ...(quality ? { quality } : {}),
        ...(params.size ? { size: params.size } : {}),
        ...(background ? { background } : {}),
        // gpt-image 系列会 400；其余模型要求 b64_json 才能免二次下载。
        ...(rejectsResponseFormat(ctx.model) ? {} : { response_format: "b64_json" }),
        output_format: IMAGE_OUTPUT_FORMAT,
    };

    return {
        url: `${openaiBase(ctx.baseUrl)}/images/generations`,
        method: "POST",
        headers: { ...bearer(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
}

/**
 * 图像编辑请求（`POST /images/edits`，multipart）。
 *
 * 注意：**不要**手动设置 `Content-Type` —— boundary 由 FormData 自带，
 * 手写会让上游解析失败（web 端注释里已经踩过这个坑）。
 */
export function buildImageEditRequest(ctx: ProviderContext, params: ImageParams): ProviderRequest {
    if (params.references.length === 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "图像编辑缺少参考图", { retryable: false });
    }

    const count = clampImageCount(params.count);
    const quality = normalizeQuality(params.quality);
    const background = normalizeBackground(params.background);

    const form = new FormData();
    form.set("model", ctx.model);
    form.set("prompt", params.prompt);
    form.set("n", String(count));
    if (!rejectsResponseFormat(ctx.model)) form.set("response_format", "b64_json");
    form.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) form.set("quality", quality);
    if (params.size) form.set("size", params.size);
    if (background) form.set("background", background);

    // 单图用 `image`，多图用 `image[]`（与 web 端 `imageField` 判断一致）。
    const field = params.references.length > 1 ? "image[]" : "image";
    params.references.forEach((reference, index) => {
        form.append(field, toBlob(reference), `reference-${index}.${extensionFor(reference.mime)}`);
    });

    return {
        url: `${openaiBase(ctx.baseUrl)}/images/edits`,
        method: "POST",
        headers: bearer(ctx),
        body: form,
    };
}

/** 视频创建请求（`POST /videos`，multipart）。 */
export function buildVideoCreateRequest(ctx: ProviderContext, params: VideoParams): ProviderRequest {
    const form = new FormData();
    form.set("model", ctx.model);
    form.set("prompt", params.prompt);
    form.set("seconds", String(params.seconds || 8));
    form.set("size", String(params.size || "1280x720"));
    form.set("resolution_name", String(params.resolution || "720p"));
    form.set("generate_audio", String(params.generateAudio !== false));
    form.set("watermark", String(params.watermark === true));
    form.set("mode", params.mode);

    if (params.mode === "frames") {
        if (params.references[0]) form.append("first_frame", toBlob(params.references[0]), "first.png");
        if (params.references[1]) form.append("last_frame", toBlob(params.references[1]), "last.png");
    } else {
        params.references.forEach((reference, index) => {
            form.append("image[]", toBlob(reference), `reference-${index}.png`);
        });
    }

    return {
        url: `${openaiBase(ctx.baseUrl)}/videos`,
        method: "POST",
        headers: bearer(ctx),
        body: form,
    };
}

/** 视频状态查询请求（`GET /videos/{id}`）。 */
export function buildVideoStatusRequest(ctx: ProviderContext, taskId: string): ProviderRequest {
    return {
        url: `${openaiBase(ctx.baseUrl)}/videos/${encodeURIComponent(taskId)}`,
        method: "GET",
        headers: bearer(ctx),
    };
}

/** 视频内容下载请求（`GET /videos/{id}/content`）。 */
export function buildVideoContentRequest(ctx: ProviderContext, taskId: string): ProviderRequest {
    return {
        url: `${openaiBase(ctx.baseUrl)}/videos/${encodeURIComponent(taskId)}/content`,
        method: "GET",
        headers: bearer(ctx),
    };
}

/** 视频状态解析结果。 */
export type VideoStatus =
    | { state: "pending" }
    | { state: "succeeded"; url: string | null; needsContent: boolean }
    | { state: "failed"; message: string };

/**
 * 解析视频状态载荷。
 *
 * 上游有三种完成形态，都要支持：
 * - `status === "completed"` 且带 `video_url` / `url` → 直接下载该地址；
 * - `status === "completed"` 但不带地址 → 需要再打 `/content` 拿字节；
 * - `status === "failed" | "cancelled"` → 报错。
 */
export function parseVideoStatus(payload: unknown): VideoStatus {
    if (!isRecord(payload)) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "视频状态响应不是对象", { retryable: true });
    }

    const status = asString(payload.status).toLowerCase();
    if (status === "failed" || status === "cancelled") {
        const message = isRecord(payload.error) ? asString(payload.error.message) : asString(payload.error);
        return { state: "failed", message: message || "视频生成失败" };
    }

    const url = asString(payload.video_url) || asString(payload.url);
    if (url) return { state: "succeeded", url, needsContent: false };

    if (status === "completed" || status === "succeeded" || status === "success") {
        return { state: "succeeded", url: null, needsContent: true };
    }

    return { state: "pending" };
}

/** 语音合成请求（`POST /audio/speech`）。 */
export function buildAudioSpeechRequest(ctx: ProviderContext, params: AudioParams): ProviderRequest {
    const body: Record<string, unknown> = {
        model: ctx.model,
        input: params.prompt,
        response_format: params.format,
        ...(params.voice ? { voice: params.voice } : {}),
        ...(params.speed !== undefined && Number.isFinite(params.speed) ? { speed: params.speed } : {}),
        ...(params.instructions ? { instructions: params.instructions } : {}),
    };

    return {
        url: `${openaiBase(ctx.baseUrl)}/audio/speech`,
        method: "POST",
        headers: { ...bearer(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
}

/** LLM 请求（`POST /responses`，OpenAI Responses API）。 */
export function buildResponsesRequest(ctx: ProviderContext, params: LlmParams): ProviderRequest {
    const body: Record<string, unknown> = {
        model: ctx.model,
        input: params.messages,
    };
    const effort = (params.reasoningEffort ?? "").trim().toLowerCase();
    if (effort && effort !== "auto") {
        body.reasoning = { effort };
    }

    return {
        url: `${openaiBase(ctx.baseUrl)}/responses`,
        method: "POST",
        headers: { ...bearer(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
}

/** 图像结果来源。 */
export type ImageSource = { kind: "base64"; data: string } | { kind: "url"; url: string };

/**
 * 解析图像响应。
 *
 * 兼容三种字段名（不同中转站各不相同）：`data` / `images` / `results`，
 * 元素里可能是 `b64_json` 也可能是 `url`。
 */
export function parseImageSources(payload: unknown): ImageSource[] {
    if (!isRecord(payload)) throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "图像响应不是对象", { retryable: true });

    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", asString(payload.msg) || "上游返回错误码", { retryable: false });
    }
    if (isRecord(payload.error) && asString(payload.error.message)) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", asString(payload.error.message), { retryable: false });
    }

    const list = (payload.data ?? payload.images ?? payload.results) as unknown;
    if (!Array.isArray(list) || list.length === 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "上游没有返回任何图片", { retryable: true });
    }

    const sources: ImageSource[] = [];
    for (const item of list) {
        if (!isRecord(item)) continue;
        const base64 = asString(item.b64_json);
        if (base64) {
            sources.push({ kind: "base64", data: base64 });
            continue;
        }
        const url = asString(item.url);
        if (url) sources.push({ kind: "url", url });
    }

    if (sources.length === 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "上游返回的图片字段无法识别（既无 b64_json 也无 url）", { retryable: false });
    }
    return sources;
}

/**
 * 解析 LLM 响应文本。
 *
 * 与 web 端一致：优先 `output_text`，否则把 `output[].content[].text` 拼起来。
 */
export function parseResponsesText(payload: unknown): string {
    if (!isRecord(payload)) throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "LLM 响应不是对象", { retryable: true });

    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", asString(payload.msg) || "上游返回错误码", { retryable: false });
    }
    if (isRecord(payload.error) && asString(payload.error.message)) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", asString(payload.error.message), { retryable: false });
    }

    const direct = asString(payload.output_text);
    if (direct.trim().length > 0) return direct;

    const output = Array.isArray(payload.output) ? payload.output : [];
    const parts: string[] = [];
    for (const item of output) {
        if (!isRecord(item)) continue;
        const content = Array.isArray(item.content) ? item.content : [];
        for (const chunk of content) {
            if (!isRecord(chunk)) continue;
            const text = asString(chunk.text);
            if (text) parts.push(text);
        }
    }

    const joined = parts.join("");
    if (joined.trim().length === 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "上游返回了空文本", { retryable: true });
    }
    return joined;
}

/** 执行图像生成/编辑，返回二进制结果。 */
export async function runImage(ctx: ProviderContext, params: ImageParams): Promise<GenerationResult> {
    const request = params.references.length > 0 ? buildImageEditRequest(ctx, params) : buildImageGenerationRequest(ctx, params);
    const payload = await sendJson(ctx, request);
    const sources = parseImageSources(payload);

    const media: MediaBytes[] = [];
    for (const source of sources) {
        if (source.kind === "base64") {
            media.push({ mime: `image/${IMAGE_OUTPUT_FORMAT}`, bytes: base64ToBytes(source.data) });
        } else {
            media.push(await downloadBytes(ctx, source.url));
        }
    }

    return { media, costActual: readCost(payload) };
}

/**
 * 执行视频生成（含二级轮询）。
 *
 * 轮询完全发生在**适配器内部**：对 Worker 来说这是一次"较慢的同步调用"，
 * 不需要让 job 在两次 tick 之间保存"半成品"状态。
 * 唯一的副作用是把上游 taskId 通过 `onUpstreamTask` 回调抛给上层落库
 * （排障时能凭 taskId 去上游后台对账）。
 */
export async function runVideo(
    ctx: ProviderContext,
    params: VideoParams,
    hooks: { onProgress?: (progress: number) => void; onUpstreamTask?: (taskId: string) => void } = {},
): Promise<GenerationResult> {
    const created = await sendJson(ctx, buildVideoCreateRequest(ctx, params));
    const taskId = isRecord(created) ? asString(created.id) : "";
    if (!taskId) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "上游未返回视频任务 id", { retryable: true });
    }
    hooks.onUpstreamTask?.(taskId);
    hooks.onProgress?.(0.15);

    const done = await pollUntil<{ bytes: Uint8Array; mime: string }>({
        intervalMs: VIDEO_POLL_INTERVAL_MS,
        timeoutMs: ctx.timeoutMs,
        probe: async () => {
            const state = parseVideoStatus(await sendJson(ctx, buildVideoStatusRequest(ctx, taskId)));
            if (state.state === "failed") {
                throw new ProviderError("PROVIDER_UPSTREAM_ERROR", state.message, { retryable: false });
            }
            if (state.state === "pending") return null;
            if (state.url) return downloadBytes(ctx, state.url);
            return sendBytes(ctx, buildVideoContentRequest(ctx, taskId));
        },
        onTick: (elapsed) => {
            // 0.15 → 0.9 之间线性推进，纯给前端进度条用，不代表真实比例。
            const ratio = Math.min(1, elapsed / Math.max(1, ctx.timeoutMs));
            hooks.onProgress?.(0.15 + ratio * 0.75);
        },
    });

    hooks.onProgress?.(0.95);
    return { media: [{ mime: done.mime.startsWith("video/") ? done.mime : "video/mp4", bytes: done.bytes }], costActual: null, upstreamTaskId: taskId };
}

/** 执行语音合成。 */
export async function runAudio(ctx: ProviderContext, params: AudioParams): Promise<GenerationResult> {
    const result = await sendBytes(ctx, buildAudioSpeechRequest(ctx, params));
    const mime = result.mime.startsWith("audio/") ? result.mime : mimeForAudioFormat(params.format);
    return { media: [{ mime, bytes: result.bytes }], costActual: null };
}

/** 执行 LLM 调用，返回纯文本（由上层决定怎么存）。 */
export async function runLlm(ctx: ProviderContext, params: LlmParams): Promise<{ text: string; costActual: number | null }> {
    const payload = await sendJson(ctx, buildResponsesRequest(ctx, params));
    return { text: parseResponsesText(payload), costActual: readCost(payload) };
}

/** 读取上游 `usage.cost` / `cost`（拿不到就是 null，绝不猜）。 */
function readCost(payload: unknown): number | null {
    if (!isRecord(payload)) return null;
    const direct = payload.cost;
    if (typeof direct === "number" && Number.isFinite(direct)) return direct;
    if (isRecord(payload.usage)) {
        const usageCost = payload.usage.cost;
        if (typeof usageCost === "number" && Number.isFinite(usageCost)) return usageCost;
    }
    return null;
}

/** 音频格式 → mime。 */
export function mimeForAudioFormat(format: string): string {
    const value = (format || "mp3").trim().toLowerCase();
    if (value === "wav") return "audio/wav";
    if (value === "opus") return "audio/ogg";
    if (value === "aac") return "audio/aac";
    if (value === "flac") return "audio/flac";
    if (value === "pcm") return "audio/L16";
    return "audio/mpeg";
}

/** 字节 → Blob（multipart 用）。 */
function toBlob(reference: MediaBytes): Blob {
    return new Blob([reference.bytes], { type: reference.mime || "application/octet-stream" });
}

/** mime → 文件扩展名（multipart 文件名只用于上游识别，不参与本地存储）。 */
function extensionFor(mime: string): string {
    const value = (mime || "").toLowerCase();
    if (value.includes("jpeg") || value.includes("jpg")) return "jpg";
    if (value.includes("webp")) return "webp";
    if (value.includes("gif")) return "gif";
    if (value.includes("mp4")) return "mp4";
    if (value.includes("mpeg")) return "mp3";
    return "png";
}
