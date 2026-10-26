/**
 * `video` 处理器。
 *
 * 与图像最大的不同：上游是"二级任务"模型。适配器在内部完成轮询
 * （对 Worker 而言仍是一次慢调用），但**必须**把上游 taskId 落库：
 * 进程在等视频时被 kill，重启后新 Worker 会重新提交一个新任务 ——
 * 有了 `upstream_task_id`，排障时至少能去上游后台把上次的成品捞回来。
 */

import { runVideoJob } from "../../providers";
import { JobFailure, type JobHandler, type JobHandlerContext, type JobHandlerResult } from "../types";
import {
    loadReferences,
    parseJobParams,
    persistResults,
    readBoolean,
    readNumber,
    readString,
    readStringArray,
    requirePrompt,
    resolveProvider,
} from "./shared";

/** 参考素材上限（首尾帧 2 张；多图参考给到 4 张）。 */
const MAX_REFERENCES = 4;

/** `video` 任务处理器。 */
export const videoHandler: JobHandler = async (ctx: JobHandlerContext): Promise<JobHandlerResult> => {
    const params = parseJobParams(ctx.job.params);
    const prompt = requirePrompt(params);

    const { ctx: provider, channelId } = resolveProvider(ctx.job, "video");
    ctx.reportProgress(0.02, `调用渠道 ${channelId.slice(0, 8)}`);

    const referenceKeys = readStringArray(params, "references");
    const mode = readString(params, "mode") === "reference" || referenceKeys.length > 2 ? "reference" : "frames";
    const references = await loadReferences(ctx.job.user_id, referenceKeys, MAX_REFERENCES);

    const result = await runVideoJob(
        provider,
        {
            prompt,
            mode,
            seconds: readNumber(params, "seconds") ?? 8,
            size: readString(params, "size"),
            resolution: readString(params, "resolution"),
            ratio: readString(params, "ratio"),
            generateAudio: readBoolean(params, "generateAudio", true),
            watermark: readBoolean(params, "watermark", false),
            references,
        },
        {
            onProgress: (progress) => ctx.reportProgress(progress, "上游生成中"),
            onUpstreamTask: (taskId) => ctx.setUpstreamTask(taskId),
        },
    );

    ctx.assertLease();
    ctx.reportProgress(0.96, "保存结果");

    const storageKeys = await persistResults(ctx.job.user_id, ctx.job.canvas_id, result.media);
    if (storageKeys.length === 0) {
        throw new JobFailure("PROVIDER_UPSTREAM_ERROR", "上游没有返回视频文件", true);
    }

    return { storageKeys, costActual: result.costActual };
};
