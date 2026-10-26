/**
 * 适配器执行入口 —— 按协议族分派。
 *
 * 上层（`jobs/handlers/*`）只认这一层，不直接碰 openai/gemini 模块，
 * 因此将来接入第三种协议（例如 Anthropic Messages）只需在这里加一个分支，
 * 业务代码零改动。
 */

import * as gemini from "./gemini.ts";
import * as openai from "./openai.ts";
import type { AudioParams, GenerationResult, ImageParams, LlmParams, ProviderContext, VideoParams } from "./types.ts";
import { ProviderError } from "./types.ts";

export type { AudioParams, GenerationResult, ImageParams, LlmParams, ProviderContext, VideoParams } from "./types.ts";
export { ProviderError, isProviderError } from "./types.ts";

/** 进度回调集合（视频用）。 */
export type ProgressHooks = {
    onProgress?: (progress: number) => void;
    onUpstreamTask?: (taskId: string) => void;
};

/** 图像生成/编辑。 */
export async function runImageJob(ctx: ProviderContext, params: ImageParams): Promise<GenerationResult> {
    assertFormat(ctx);
    return ctx.format === "gemini" ? gemini.runImage(ctx, params) : openai.runImage(ctx, params);
}

/** 视频生成。 */
export async function runVideoJob(ctx: ProviderContext, params: VideoParams, hooks: ProgressHooks = {}): Promise<GenerationResult> {
    assertFormat(ctx);
    return ctx.format === "gemini" ? gemini.runVideo(ctx, params, hooks) : openai.runVideo(ctx, params, hooks);
}

/** 语音合成。 */
export async function runAudioJob(ctx: ProviderContext, params: AudioParams): Promise<GenerationResult> {
    assertFormat(ctx);
    return ctx.format === "gemini" ? gemini.runAudio(ctx, params) : openai.runAudio(ctx, params);
}

/** 文本生成。 */
export async function runLlmJob(ctx: ProviderContext, params: LlmParams): Promise<{ text: string; costActual: number | null }> {
    assertFormat(ctx);
    return ctx.format === "gemini" ? gemini.runLlm(ctx, params) : openai.runLlm(ctx, params);
}

/** 协议族穷尽性校验（防止渠道表里出现脏值）。 */
function assertFormat(ctx: ProviderContext): void {
    if (ctx.format !== "openai" && ctx.format !== "gemini") {
        throw new ProviderError("INTERNAL", `未知的上游协议：${String(ctx.format)}`, { retryable: false });
    }
}

/** 暴露纯函数层，供校验脚本与未来 CLI 复用（不是内部 API 的替代品）。 */
export const builders = { gemini, openai };
