/**
 * `llm` 处理器（纯文本补全）。
 *
 * 文本结果落成 `file:` 资产（mime `text/markdown`），原因见
 * `handlers/shared.ts: persistText` 的注释 —— 让 `result_storage_keys`
 * 保持"全部是资产键"这个单一语义。
 *
 * 注意：画布助手的**流式**问答不走这里（它是 Tier2 直通代理，
 * 见 `routes/proxy.ts`）。这里服务的是"离线/异步"的文本任务，
 * 例如批量生成文案、给节点补写描述。
 */

import { runLlmJob } from "../../providers";
import { JobFailure, type JobHandler, type JobHandlerResult } from "../types";
import { parseJobParams, persistText, readString, resolveProvider } from "./shared";

/** 一次任务最多接受多少条消息（防有人把整本画布当 prompt 灌进来）。 */
const MAX_MESSAGES = 64;

/** 单条消息最大字符数。 */
const MAX_MESSAGE_CHARS = 32_000;

/** `llm` 任务处理器。 */
export const llmHandler: JobHandler = async (ctx): Promise<JobHandlerResult> => {
    const params = parseJobParams(ctx.job.params);
    const messages = normalizeMessages(params);

    const { ctx: provider } = resolveProvider(ctx.job, "text");
    ctx.reportProgress(0.1, "请求文本生成");

    const result = await runLlmJob(provider, {
        messages,
        reasoningEffort: readString(params, "reasoningEffort"),
    });

    ctx.assertLease();
    ctx.reportProgress(0.9, "保存结果");

    const storageKey = await persistText(ctx.job.user_id, ctx.job.canvas_id, result.text);
    return { storageKeys: [storageKey], costActual: result.costActual };
};

/** 消息归一：支持 `messages: [{role, content}]`，也支持只给 `prompt`。 */
function normalizeMessages(params: Record<string, unknown>): { role: "system" | "user" | "assistant"; content: string }[] {
    const raw = params.messages;
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (!item || typeof item !== "object") continue;
            const record = item as Record<string, unknown>;
            const role = record.role;
            const content = record.content;
            if (typeof content !== "string" || content.length === 0) continue;
            if (role !== "system" && role !== "user" && role !== "assistant") continue;
            messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
            if (messages.length >= MAX_MESSAGES) break;
        }
    }

    if (messages.length === 0) {
        const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
        if (prompt.length === 0) {
            throw new JobFailure("PROVIDER_UPSTREAM_ERROR", "LLM 任务缺少 messages 或 prompt", false);
        }
        messages.push({ role: "user", content: prompt.slice(0, MAX_MESSAGE_CHARS) });
    }

    return messages;
}
