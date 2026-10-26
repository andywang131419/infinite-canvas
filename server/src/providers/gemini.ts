/**
 * Gemini 协议适配器（覆盖 image / video / audio / llm）。
 *
 * 移植来源：
 * - `web/src/services/api/image.ts: requestGeminiImagesOnce`（`generateContent` + `responseModalities`）
 * - `web/src/services/api/model-plugin.ts` gemini veo 模板（`predictLongRunning` + 轮询 operation）
 * - `web/src/services/api/model-plugin.ts` gemini TTS 模板（`generateContent` + `AUDIO`）
 *
 * 三条与 OpenAI 侧不同的硬约束：
 * 1. 认证头是 `x-goog-api-key`，不是 `Authorization: Bearer`；
 * 2. 模型名要放在 URL 路径里（`models/{model}:generateContent`），且不能用 `models/models/...`；
 * 3. 视频不是"发一次拿一次"，必须**先拿 operation 名再轮询**，且最终 URI 需要带 `key=` 才能下载
 *    —— 这个 key 拼接发生在适配器内部，Worker 与日志永远看不到它。
 */

import { asString, base64ToBytes, geminiBase, geminiModelName, isRecord, pollUntil, sendBytes, sendJson } from "./http.ts";
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

/** 视频 operation 轮询间隔（web 端 5000ms）。 */
const OPERATION_POLL_INTERVAL_MS = 5000;

/** Gemini 支持的宽高比白名单（来自 web 端 `GEMINI_SUPPORTED_RATIOS`）。 */
const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

/** 像素尺寸 → 宽高比（veo 用）。 */
const VIDEO_RATIO_MAP: Record<string, string> = {
    "1280x720": "16:9",
    "1920x1080": "16:9",
    "720x1280": "9:16",
    "1080x1920": "9:16",
};

/** Gemini 鉴权头。 */
function geminiHeaders(ctx: ProviderContext): Record<string, string> {
    return { "x-goog-api-key": ctx.apiKey, "Content-Type": "application/json" };
}

/** 组装 `models/{model}:{action}` 形式的 URL。 */
function modelUrl(ctx: ProviderContext, action: string): string {
    return `${geminiBase(ctx.baseUrl)}/models/${encodeURIComponent(geminiModelName(ctx.model))}:${action}`;
}

/** 解析 `1024x1024` 形式的尺寸。 */
export function parseDimensionPair(value: string | undefined): { width: number; height: number } | null {
    const match = /^(\d+)x(\d+)$/i.exec((value ?? "").trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

/** 把 `w:h` 形式解析成数值对；非法返回 null。 */
function parseRatio(value: string): { width: number; height: number } | null {
    const parts = value.split(":");
    if (parts.length !== 2) return null;
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

/**
 * 找最接近的 Gemini 宽高比。
 *
 * Gemini 只接受固定枚举值，传 `4:5` 之外的任意比例会 400，
 * 所以这里做"最近邻"映射（与 web 端 `closestGeminiAspectRatio` 一致）。
 */
export function closestGeminiAspectRatio(value: string): string | undefined {
    const ratio = parseRatio(value);
    if (!ratio) return undefined;
    const target = ratio.width / ratio.height;

    let best = GEMINI_SUPPORTED_RATIOS[0]!;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of GEMINI_SUPPORTED_RATIOS) {
        const parsed = parseRatio(candidate);
        if (!parsed) continue;
        const distance = Math.abs(parsed.width / parsed.height - target);
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * 由像素尺寸推导 Gemini 的分辨率档位（`512 | 1K | 2K | 4K`）。
 *
 * 与 web 端 `resolveGeminiImageSize` 一致：按最长边分档。
 */
export function geminiImageSize(size: string | undefined): string | undefined {
    const dimensions = parseDimensionPair(size);
    if (!dimensions) return undefined;
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

/** 组装 `generationConfig.imageConfig`（无内容时返回空对象，避免下发 `{}`）。 */
export function buildGeminiImageConfig(size: string | undefined): Record<string, unknown> {
    const dimensions = parseDimensionPair(size);
    const ratioValue = dimensions ? `${dimensions.width}:${dimensions.height}` : (size ?? "").trim();
    const aspectRatio = ratioValue && ratioValue.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratioValue) : undefined;
    const imageSize = geminiImageSize(size);

    const image: Record<string, unknown> = {};
    if (aspectRatio) image.aspectRatio = aspectRatio;
    if (imageSize) image.imageSize = imageSize;
    return Object.keys(image).length > 0 ? { imageConfig: image } : {};
}

/** 参考素材 → Gemini `inlineData` part。 */
function inlinePart(reference: MediaBytes): Record<string, unknown> {
    return {
        inlineData: {
            mimeType: reference.mime || "image/png",
            data: Buffer.from(reference.bytes).toString("base64"),
        },
    };
}

/** 图像生成/编辑请求（`generateContent`，TEXT + IMAGE 双模态）。 */
export function buildGeminiImageRequest(ctx: ProviderContext, params: ImageParams): ProviderRequest {
    const parts: Record<string, unknown>[] = [{ text: params.prompt }];
    for (const reference of params.references) parts.push(inlinePart(reference));

    const generationConfig: Record<string, unknown> = {
        responseModalities: ["TEXT", "IMAGE"],
        ...buildGeminiImageConfig(params.size),
    };

    return {
        url: modelUrl(ctx, "generateContent"),
        method: "POST",
        headers: geminiHeaders(ctx),
        body: JSON.stringify({ generationConfig, contents: [{ role: "user", parts }] }),
    };
}

/** 视频请求（`predictLongRunning`）。 */
export function buildGeminiVideoRequest(ctx: ProviderContext, params: VideoParams): ProviderRequest {
    const instance: Record<string, unknown> = { prompt: params.prompt };

    if (params.mode === "frames") {
        if (params.references[0]) instance.image = inlinePart(params.references[0]);
        if (params.references[1]) instance.lastFrame = inlinePart(params.references[1]);
    } else {
        instance.referenceImages = params.references.map((reference) => ({ image: inlinePart(reference), referenceType: "asset" }));
    }

    let aspectRatio = params.ratio || params.size || "16:9";
    if (aspectRatio === "auto") aspectRatio = "16:9";
    aspectRatio = VIDEO_RATIO_MAP[aspectRatio] ?? aspectRatio;

    return {
        url: modelUrl(ctx, "predictLongRunning"),
        method: "POST",
        headers: geminiHeaders(ctx),
        body: JSON.stringify({
            instances: [instance],
            parameters: {
                aspectRatio,
                durationSeconds: Number(params.seconds) || 8,
                resolution: params.resolution || "720p",
                generateAudio: params.generateAudio !== false,
                addWatermark: params.watermark === true,
            },
        }),
    };
}

/**
 * operation 轮询请求。
 *
 * `operationName` 形如 `models/veo-3/operations/abc`，
 * 直接拼在 `{base}/{operationName}` 上（web 端做法，不要额外加 `/models/`）。
 */
export function buildGeminiOperationRequest(ctx: ProviderContext, operationName: string): ProviderRequest {
    const base = geminiBase(ctx.baseUrl);
    const path = operationName.replace(/^\/+/, "");
    return { url: `${base}/${path}`, method: "GET", headers: geminiHeaders(ctx) };
}

/** operation 解析结果。 */
export type OperationStatus = { state: "pending" } | { state: "succeeded"; videoUri: string } | { state: "failed"; message: string };

/** 解析 `predictLongRunning` 的 operation 状态。 */
export function parseGeminiOperation(payload: unknown): OperationStatus {
    if (!isRecord(payload)) throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "operation 响应不是对象", { retryable: true });

    if (isRecord(payload.error)) {
        return { state: "failed", message: asString(payload.error.message) || "Gemini 视频生成失败" };
    }
    if (payload.done !== true) return { state: "pending" };

    const response = isRecord(payload.response) ? payload.response : {};
    const videoResponse = isRecord(response.generateVideoResponse) ? response.generateVideoResponse : {};
    const samples = Array.isArray(videoResponse.generatedSamples) ? videoResponse.generatedSamples : [];
    const first = samples[0];
    const video = isRecord(first) && isRecord(first.video) ? first.video : {};
    const uri = asString(video.uri);

    if (!uri) return { state: "failed", message: "Gemini 未返回视频地址" };
    return { state: "succeeded", videoUri: uri };
}

/**
 * 给下载地址补上 `key=`。
 *
 * Gemini 的视频 URI 是带签名的对象地址，但**必须**带 key 才能下载；
 * 这段拼装只在适配器内部存在，返回给上层的只有字节。
 */
export function withGeminiKey(uri: string, apiKey: string): string {
    if (uri.includes("key=")) return uri;
    const separator = uri.includes("?") ? "&" : "?";
    return `${uri}${separator}key=${encodeURIComponent(apiKey)}`;
}

/** 文本请求（`generateContent` 纯文本）。 */
export function buildGeminiTextRequest(ctx: ProviderContext, params: LlmParams): ProviderRequest {
    const system = params.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const contents = params.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }));

    const body: Record<string, unknown> = { contents };
    if (system.trim().length > 0) body.systemInstruction = { parts: [{ text: system }] };

    return {
        url: modelUrl(ctx, "generateContent"),
        method: "POST",
        headers: geminiHeaders(ctx),
        body: JSON.stringify(body),
    };
}

/**
 * 语音合成请求（TTS：`generateContent` + `AUDIO` 模态）。
 *
 * Gemini 没有独立的 `/audio/speech`，语音从 `inlineData` 里返回（PCM/WAV）。
 */
export function buildGeminiAudioRequest(ctx: ProviderContext, params: AudioParams): ProviderRequest {
    const speechConfig: Record<string, unknown> = {};
    if (params.voice) {
        speechConfig.voiceConfig = { prebuiltVoiceConfig: { voiceName: params.voice } };
    }

    return {
        url: modelUrl(ctx, "generateContent"),
        method: "POST",
        headers: geminiHeaders(ctx),
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: params.prompt }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                ...(Object.keys(speechConfig).length > 0 ? { speechConfig } : {}),
            },
        }),
    };
}

/** Gemini 载荷的通用校验（`error` / `promptFeedback.blockReason`）。 */
export function assertGeminiPayload(payload: unknown): void {
    if (!isRecord(payload)) throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Gemini 响应不是对象", { retryable: true });

    if (isRecord(payload.error) && asString(payload.error.message)) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", asString(payload.error.message), { retryable: false });
    }
    if (isRecord(payload.promptFeedback)) {
        const blockReason = asString(payload.promptFeedback.blockReason);
        if (blockReason) {
            throw new ProviderError("PROVIDER_CONTENT_REJECTED", `Gemini 拒绝了该内容（${blockReason}）`, { retryable: false });
        }
    }
}

/** 从候选里取出所有 part。 */
function candidateParts(payload: Record<string, unknown>): Record<string, unknown>[] {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const parts: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
        if (!isRecord(candidate)) continue;
        const content = isRecord(candidate.content) ? candidate.content : {};
        const list = Array.isArray(content.parts) ? content.parts : [];
        for (const part of list) {
            if (isRecord(part)) parts.push(part);
        }
    }
    return parts;
}

/** 从 part 里取 inlineData（同时兼容 snake_case 与 camelCase）。 */
function readInlineData(part: Record<string, unknown>): { mime: string; data: string } | null {
    const camel = part.inlineData;
    if (isRecord(camel) && asString(camel.data)) {
        return { mime: asString(camel.mimeType) || "application/octet-stream", data: asString(camel.data) };
    }
    const snake = part.inline_data;
    if (isRecord(snake) && asString(snake.data)) {
        return { mime: asString(snake.mime_type) || asString(snake.mimeType) || "application/octet-stream", data: asString(snake.data) };
    }
    return null;
}

/** 图像结果来源：内联字节或远程 URI（远程要由执行层带密钥下载）。 */
export type GeminiImageSource = { kind: "bytes"; mime: string; bytes: Uint8Array } | { kind: "uri"; uri: string };

/**
 * 解析图像响应：`inlineData` 优先，其次 `fileData.fileUri`。
 *
 * 移植自 `web/src/services/api/image.ts: parseGeminiImagePayload`。
 * 这里**只做解析**，下载交给 `runImage` —— 解析函数保持纯函数，
 * golden fixture 才能在不联网的情况下断言。
 */
export function parseGeminiImageSources(payload: unknown): GeminiImageSource[] {
    assertGeminiPayload(payload);
    const record = payload as Record<string, unknown>;

    const sources: GeminiImageSource[] = [];
    for (const part of candidateParts(record)) {
        const inline = readInlineData(part);
        if (inline) {
            sources.push({ kind: "bytes", mime: inline.mime, bytes: base64ToBytes(inline.data) });
            continue;
        }
        const fileData = isRecord(part.fileData) ? part.fileData : isRecord(part.file_data) ? part.file_data : null;
        const uri = fileData ? asString(fileData.fileUri) || asString(fileData.file_uri) : "";
        if (uri) sources.push({ kind: "uri", uri });
    }

    if (sources.length === 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Gemini 没有返回图片", { retryable: true });
    }
    return sources;
}

/** 解析文本响应（拼接所有 text part）。 */
export function parseGeminiText(payload: unknown): string {
    assertGeminiPayload(payload);
    const record = payload as Record<string, unknown>;

    const parts: string[] = [];
    for (const part of candidateParts(record)) {
        const text = asString(part.text);
        if (text) parts.push(text);
    }

    const joined = parts.join("");
    if (joined.trim().length === 0) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Gemini 返回了空文本", { retryable: true });
    }
    return joined;
}

/** 解析音频响应（`inlineData` 里的音频字节）。 */
export function parseGeminiAudio(payload: unknown): { mime: string; bytes: Uint8Array } {
    assertGeminiPayload(payload);
    const record = payload as Record<string, unknown>;

    for (const part of candidateParts(record)) {
        const inline = readInlineData(part);
        if (inline) {
            return { mime: inline.mime.startsWith("audio/") ? inline.mime : "audio/wav", bytes: base64ToBytes(inline.data) };
        }
    }
    throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Gemini 没有返回音频", { retryable: true });
}

/** 执行图像生成/编辑。 */
export async function runImage(ctx: ProviderContext, params: ImageParams): Promise<GenerationResult> {
    const target = Math.max(1, Math.min(15, Math.floor(params.count) || 1));

    const media: MediaBytes[] = [];
    // Gemini 一次请求只出一张图；需要多张时串行补发（并发容易触发限流）。
    for (let index = 0; index < target; index += 1) {
        const payload = await sendJson(ctx, buildGeminiImageRequest(ctx, params));
        for (const source of parseGeminiImageSources(payload)) {
            if (source.kind === "bytes") {
                media.push({ mime: source.mime, bytes: source.bytes });
                continue;
            }
            const downloaded = await sendBytes(ctx, { url: withGeminiKey(source.uri, ctx.apiKey), method: "GET", headers: {} });
            media.push({ mime: downloaded.mime, bytes: downloaded.bytes });
        }
    }

    return { media, costActual: null };
}

/** 执行视频生成（创建 operation → 轮询 → 带 key 下载）。 */
export async function runVideo(
    ctx: ProviderContext,
    params: VideoParams,
    hooks: { onProgress?: (progress: number) => void; onUpstreamTask?: (taskId: string) => void } = {},
): Promise<GenerationResult> {
    const created = await sendJson(ctx, buildGeminiVideoRequest(ctx, params));
    const operationName = isRecord(created) ? asString(created.name) : "";
    if (!operationName) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Gemini 未返回 operation 名称", { retryable: true });
    }
    hooks.onUpstreamTask?.(operationName);
    hooks.onProgress?.(0.15);

    const uri = await pollUntil<string>({
        intervalMs: OPERATION_POLL_INTERVAL_MS,
        timeoutMs: ctx.timeoutMs,
        probe: async () => {
            const status = parseGeminiOperation(await sendJson(ctx, buildGeminiOperationRequest(ctx, operationName)));
            if (status.state === "failed") {
                throw new ProviderError("PROVIDER_UPSTREAM_ERROR", status.message, { retryable: false });
            }
            return status.state === "succeeded" ? status.videoUri : null;
        },
        onTick: (elapsed) => {
            const ratio = Math.min(1, elapsed / Math.max(1, ctx.timeoutMs));
            hooks.onProgress?.(0.15 + ratio * 0.75);
        },
    });

    // 关键：URI 需要 key 才能下载；key 只在这里出现一次。
    const downloaded = await sendBytes(ctx, { url: withGeminiKey(uri, ctx.apiKey), method: "GET", headers: {} });
    hooks.onProgress?.(0.95);

    return {
        media: [{ mime: downloaded.mime.startsWith("video/") ? downloaded.mime : "video/mp4", bytes: downloaded.bytes }],
        costActual: null,
        upstreamTaskId: operationName,
    };
}

/** 执行语音合成。 */
export async function runAudio(ctx: ProviderContext, params: AudioParams): Promise<GenerationResult> {
    const audio = parseGeminiAudio(await sendJson(ctx, buildGeminiAudioRequest(ctx, params)));
    return { media: [audio], costActual: null };
}

/** 执行 LLM 调用。 */
export async function runLlm(ctx: ProviderContext, params: LlmParams): Promise<{ text: string; costActual: number | null }> {
    const payload = await sendJson(ctx, buildGeminiTextRequest(ctx, params));
    return { text: parseGeminiText(payload), costActual: null };
}
