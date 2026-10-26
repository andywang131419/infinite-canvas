/**
 * Handler 公共能力：渠道选路、密钥解密、参数解析、结果落存储。
 *
 * 这一层是"三个世界的交汇点"：
 * - 上游世界：`providers/*`（只认 ProviderContext）
 * - 存储世界：`services/asset-service.ts`（只认字节 + mime）
 * - 数据库世界：`db/repos/*`（认 storageKey）
 *
 * 所有跨世界的数据都必须**降级成最小信息**再传递：
 * 密钥只在 `ProviderContext` 里存在一次，绝不进入 params/日志/返回值。
 */

import { findAssetByStorageKey } from "../../db/repos/assets";
import { parseModels } from "../../db/repos/channels";
import type { ModelCapability } from "../../db/repos/channels";
import { getEnv } from "../../env";
import { ApiError } from "../../http/errors";
import { ProviderError, type ProviderContext } from "../../providers";
import { openAsset, relPathFor, ingestAssetBytes } from "../../services/asset-service";
import { pickChannelForCapability, resolveChannelSecret } from "../../services/channel-service";
import { getStorageDriver } from "../../storage";
import type { MediaBytes } from "../../providers/types";
import type { JobRow } from "../queue";

/** 解析后的任务参数（JSON 里的字段全部可选，缺省即用默认值）。 */
export type JobParams = Record<string, unknown>;

/**
 * 解析 `jobs.params` 文本。
 *
 * 脏数据不抛错而是返回 `{}`：一个坏 JSON 不应该让任务永远卡在 running，
 * 后续会因为"缺少 prompt"报一个更可读的业务错误。
 */
export function parseJobParams(raw: string): JobParams {
    try {
        const parsed: unknown = JSON.parse(raw || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as JobParams;
    } catch {
        return {};
    }
}

/** 读字符串字段（去掉首尾空白）。 */
export function readString(params: JobParams, key: string): string | undefined {
    const value = params[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/** 读数字字段。 */
export function readNumber(params: JobParams, key: string): number | undefined {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

/** 读布尔字段（默认 true，只有显式 false 才算关闭）。 */
export function readBoolean(params: JobParams, key: string, fallback: boolean): boolean {
    const value = params[key];
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

/** 读字符串数组字段。 */
export function readStringArray(params: JobParams, key: string): string[] {
    const value = params[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** 必填 prompt。 */
export function requirePrompt(params: JobParams): string {
    const prompt = readString(params, "prompt");
    if (!prompt) {
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "任务参数缺少 prompt", { retryable: false });
    }
    return prompt;
}

/** 就绪的调用上下文。 */
export type ResolvedProvider = {
    ctx: ProviderContext;
    /** 实际使用的渠道 id（可能与任务里写的不一致：任务没指定时会自动选路）。 */
    channelId: string;
    /** 本次调用应使用的模型名（渠道没配模型时回退到任务里的 model）。 */
    model: string;
};

/**
 * 解析出可用的上游调用上下文。
 *
 * 选路顺序见 `pickChannelForCapability`：显式 channelId → 默认渠道 → 首个支持该能力的渠道。
 *
 * @throws {ApiError} 无可用渠道 / 未配置密钥（不可重试，直接判任务失败）
 */
export function resolveProvider(job: JobRow, capability: ModelCapability): ResolvedProvider {
    const channel = job.channel_id
        ? pickChannelForCapability(job.user_id, capability, job.channel_id)
        : pickChannelForCapability(job.user_id, capability);

    const { apiKey } = resolveChannelSecret(channel.id);

    const declared = parseModels(channel.models).filter((model) => model.capability === capability);
    const model = job.model && job.model.trim().length > 0 ? job.model.trim() : (declared[0]?.name ?? "");
    if (!model) {
        throw new ApiError("PROVIDER_KEY_MISSING", `渠道「${channel.name}」没有配置 ${capability} 模型`, { channelId: channel.id });
    }

    return {
        channelId: channel.id,
        model,
        ctx: {
            format: channel.api_format,
            baseUrl: channel.base_url,
            apiKey,
            model,
            timeoutMs: timeoutFor(capability),
        },
    };
}

/** 按能力取超时（图片/音频/文本用 IMAGE 档，视频单独一档）。 */
function timeoutFor(capability: ModelCapability): number {
    const env = getEnv();
    const seconds = capability === "video" ? env.JOB_VIDEO_TIMEOUT_S : env.JOB_IMAGE_TIMEOUT_S;
    return Math.max(1, seconds) * 1000;
}

/**
 * 按 storageKey 读取参考素材字节。
 *
 * 参考图在 doc/params 里是 `storageKey`（`image:xxx`），绝不内联 base64
 * —— 这也是 `jobs.params` 允许写进数据库的前提。
 *
 * @throws {ApiError} 资产不存在或不属于该用户（不可重试）
 */
export async function loadReferences(ownerId: string, storageKeys: string[], limit: number): Promise<MediaBytes[]> {
    const keys = storageKeys.slice(0, limit);
    const media: MediaBytes[] = [];

    for (const key of keys) {
        const opened = await openAsset(ownerId, key, undefined);
        const bytes = new Uint8Array(await new Response(opened.stream).arrayBuffer());
        media.push({ mime: opened.row.mime, bytes });
    }

    return media;
}

/**
 * 把生成结果落存储并返回逻辑键。
 *
 * 传入的 `canvasId` 让资产能按画布列举（`/api/assets?canvasId=`）；
 * 失败会抛 `STORAGE_WRITE_FAILED`（不可重试：磁盘满了重试也没用）。
 */
export async function persistResults(
    ownerId: string,
    canvasId: string,
    media: MediaBytes[],
): Promise<string[]> {
    const keys: string[] = [];
    for (const item of media) {
        if (item.bytes.byteLength === 0) continue;
        const ingested = await ingestAssetBytes(ownerId, { mime: item.mime, bytes: item.bytes }, canvasId);
        keys.push(ingested.storageKey);
    }
    return keys;
}

/**
 * 把纯文本结果也当成资产存起来。
 *
 * 为什么不用 `jobs.result_storage_keys` 直接存文本：
 * 该列语义是"结果资产键"，混入文本会让读取方必须做类型判断。
 * 统一成 `file:` 资产的代价只是一次磁盘写入 + 一行元数据。
 */
export async function persistText(ownerId: string, canvasId: string, text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const ingested = await ingestAssetBytes(ownerId, { mime: "text/markdown", bytes }, canvasId);
    return ingested.storageKey;
}

/** 断言某个 storageKey 确实存在且属于该用户（用于把"结果键"写回任务前的自检）。 */
export function assertAssetOwned(ownerId: string, storageKey: string): void {
    const row = findAssetByStorageKey(storageKey);
    if (!row || row.owner_id !== ownerId) {
        throw new ApiError("STORAGE_WRITE_FAILED", `结果资产校验失败：${storageKey}`, { storageKey });
    }
}

/** 读取一个对象的完整字节（备份/迁移工具用）。 */
export async function readObjectBytes(relPath: string): Promise<Uint8Array> {
    const body = await getStorageDriver().get(relPath);
    return new Uint8Array(await new Response(body.stream).arrayBuffer());
}

/** 资产行 → 物理相对路径（导出给排障脚本用，避免它们重新实现推导规则）。 */
export { relPathFor };
