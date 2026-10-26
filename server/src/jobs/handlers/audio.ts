/**
 * `audio` 处理器（TTS）。
 *
 * 结果是一段音频，直接落成 `audio:` 资产；
 * 上游对 `response_format` 的支持面差异很大（mp3/wav/opus/aac/flac/pcm），
 * 这里只做白名单归一，不猜上游能力 —— 传错了由上游报错，错误信息会原样带回。
 */

import { runAudioJob } from "../../providers";
import { JobFailure, type JobHandler, type JobHandlerResult } from "../types";
import { parseJobParams, persistResults, readNumber, readString, requirePrompt, resolveProvider } from "./shared";

/** 允许的输出格式（与 OpenAI `/audio/speech` 的 `response_format` 取值一致）。 */
const AUDIO_FORMATS = ["mp3", "wav", "opus", "aac", "flac", "pcm"];

/** 语速合法区间（OpenAI 文档为 0.25~4.0，这里再夹一次避免上游 400）。 */
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;

/** `audio` 任务处理器。 */
export const audioHandler: JobHandler = async (ctx): Promise<JobHandlerResult> => {
    const params = parseJobParams(ctx.job.params);
    const prompt = requirePrompt(params);

    const { ctx: provider } = resolveProvider(ctx.job, "audio");
    ctx.reportProgress(0.1, "请求语音合成");

    const format = normalizeFormat(readString(params, "format"));
    const speed = clampSpeed(readNumber(params, "speed"));

    const result = await runAudioJob(provider, {
        prompt,
        voice: readString(params, "voice"),
        format,
        speed,
        instructions: readString(params, "instructions"),
    });

    ctx.assertLease();
    ctx.reportProgress(0.9, "保存结果");

    const storageKeys = await persistResults(ctx.job.user_id, ctx.job.canvas_id, result.media);
    if (storageKeys.length === 0) {
        throw new JobFailure("PROVIDER_UPSTREAM_ERROR", "上游没有返回音频数据", true);
    }

    return { storageKeys, costActual: result.costActual };
};

/** 格式归一：非法值回退 mp3（宁可出声，不要让任务因为一个可选参数失败）。 */
function normalizeFormat(value: string | undefined): string {
    const normalized = (value ?? "").trim().toLowerCase();
    return AUDIO_FORMATS.includes(normalized) ? normalized : "mp3";
}

/** 语速夹紧；未提供则返回 undefined（让上游用默认值）。 */
function clampSpeed(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
}
