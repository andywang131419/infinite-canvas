/**
 * `image` / `image_edit` 处理器。
 *
 * 一个任务 = 一次上游调用 + 若干次落盘。两者用同一个 `prompt` 串起来，
 * 中间不做任何"部分成功也算成功"的妥协：只要任何一张图没取到就整体失败，
 * 由 `max_attempts` 决定是否重试（重试会重新生成，前端表现为节点仍在 loading）。
 */

import { runImageJob } from "../../providers";
import { JobFailure, type JobHandler, type JobHandlerContext, type JobHandlerResult } from "../types";
import { readNumber, readString, readStringArray, requirePrompt, resolveProvider, loadReferences, persistResults, parseJobParams } from "./shared";

/** 参考图数量上限（上游普遍限制 4~16 张，取常见值 8）。 */
const MAX_REFERENCES = 8;

/** 一次任务最多生成多少张图（与前端"多张"上限一致）。 */
const MAX_COUNT = 4;

/** 图像生成。 */
export const imageHandler: JobHandler = async (ctx) => runImage(ctx, false);

/** 图像编辑（必须有参考图）。 */
export const imageEditHandler: JobHandler = async (ctx) => runImage(ctx, true);

/** 生成与编辑的唯一差异就是"要不要参考图"，其余完全一致。 */
async function runImage(ctx: JobHandlerContext, needsReferences: boolean): Promise<JobHandlerResult> {
    const params = parseJobParams(ctx.job.params);
    const prompt = requirePrompt(params);
    const referenceKeys = readStringArray(params, "references");

    if (needsReferences && referenceKeys.length === 0) {
        throw new JobFailure("PROVIDER_UPSTREAM_ERROR", "图像编辑任务缺少参考图（params.references 为空）", false);
    }

    const { ctx: provider, channelId } = resolveProvider(ctx.job, "image");
    ctx.reportProgress(0.05, `调用渠道 ${channelId.slice(0, 8)}`);

    const references = needsReferences ? await loadReferences(ctx.job.user_id, referenceKeys, MAX_REFERENCES) : [];
    const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(readNumber(params, "count") ?? 1)));

    const result = await runImageJob(provider, {
        prompt,
        references,
        count,
        size: readString(params, "size"),
        quality: readString(params, "quality"),
        background: readString(params, "background"),
    });

    // 落盘前最后一道检查：租约还在才可以把成果写成"这个任务的结果"。
    ctx.assertLease();
    ctx.reportProgress(0.9, "保存结果");

    const storageKeys = await persistResults(ctx.job.user_id, ctx.job.canvas_id, result.media);
    if (storageKeys.length === 0) {
        throw new JobFailure("PROVIDER_UPSTREAM_ERROR", "上游没有返回任何有效图片", true);
    }

    return { storageKeys, costActual: result.costActual };
}
