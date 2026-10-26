/**
 * Handler 注册表 —— 把 `jobs.type` 的 5 个取值逐一绑定到实现。
 *
 * T01 时这里刻意是空的（`registeredTypes === 0`，Worker 不消费任何任务）；
 * T03 起全部 5 个类型都有真实实现，`/api/health` 的 `worker.registeredTypes`
 * 会变成 5，这是"任务系统真的接上了"的最直接观测点。
 *
 * 类型集合必须与 `migrations/0001_init.sql` 里 `jobs.type` 的 CHECK 约束一致：
 * 少一个类型 → 该类型的任务永远不会被认领（会一直 queued，静默积压）；
 * 多一个类型 → 插入时就违反 CHECK。
 */

import type { JobType } from "../queue";
import { registerJobHandler } from "../worker";
import { audioHandler } from "./audio";
import { imageEditHandler, imageHandler } from "./image";
import { llmHandler } from "./llm";
import { videoHandler } from "./video";
import type { JobHandler } from "../types";

/** job type → handler 的完整映射（也是"已实现到哪里"的唯一事实来源）。 */
export const JOB_HANDLERS: Record<JobType, JobHandler> = {
    image: imageHandler,
    image_edit: imageEditHandler,
    video: videoHandler,
    audio: audioHandler,
    llm: llmHandler,
};

/** 全部受支持的 job type（顺序稳定，便于测试与日志）。 */
export const JOB_TYPES: JobType[] = ["image", "image_edit", "video", "audio", "llm"];

/**
 * 注册全部 handler。
 *
 * 由 `index.ts` 在 `startWorker()` **之前**调用一次。
 * 重复调用会抛错（`registerJobHandler` 的语义是"重复注册即 bug"），
 * 所以这里不做静默容错 —— 启动期就炸掉比运行期处理错任务要好。
 */
export function registerAllHandlers(): void {
    for (const type of JOB_TYPES) {
        registerJobHandler(type, JOB_HANDLERS[type]);
    }
}
