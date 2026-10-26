/**
 * channel-secrets —— 渠道密钥的"只写"通道（T04-A6）。
 *
 * 目标：密钥**只存在服务端**（AES-GCM 加密入库），前端只保留一个掩码提示
 * （`sk-****abcd`）。这样：
 * - localStorage 里再也搜不到明文 key（XSS / 共享电脑都安全）；
 * - 前端代码里也没有"拿 key 去拼 Authorization"的动机 —— 密钥由服务端在
 *   `/api/proxy` 注入（见 `server/src/services/channel-service.ts`）。
 *
 * 老数据迁移：`use-config-store` 的 `merge` 会把历史明文 key 从持久化状态里
 * 抠出来放进 `queueLegacySecret`，再由 `flushLegacySecrets()` 推到服务端并**擦除**。
 * 迁移是幂等的：服务端已有同 baseUrl 的渠道就覆盖密钥，没有就新建。
 */

import { apiGet, apiPost, apiPut } from "@/services/server-api";
import type { ApiCallFormat, ChannelModel, ModelChannel } from "@/stores/use-config-store";

/** 服务端渠道 DTO（**没有** apiKey 字段，只有 hasKey + 掩码）。 */
export type ServerChannelDto = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: ApiCallFormat;
    models: Array<{ name: string; capability: string }>;
    hasKey: boolean;
    apiKeyHint: string;
    enabled?: boolean;
    isDefault?: boolean;
};

/** 把前端渠道模型转成服务端要的形状。 */
function toServerModels(models: ChannelModel[]): Array<{ name: string; capability: string }> {
    return models.map((model) => ({ name: model.name, capability: model.capability }));
}

/** 列出服务端渠道。 */
export async function listServerChannels(): Promise<ServerChannelDto[]> {
    const payload = await apiGet<{ items: ServerChannelDto[] }>("/api/channels");
    return payload.items;
}

/**
 * 上传一个渠道的密钥。
 *
 * 匹配规则：**先按 baseUrl 找同一个上游**，找到就 PUT（只更新密钥，不动模型列表），
 * 找不到就 POST 新建。这样同一家上游不会因为前端换了个渠道 id 就多出一条记录。
 */
export async function pushChannelSecret(input: { name: string; baseUrl: string; apiFormat: ApiCallFormat; models: ChannelModel[]; apiKey: string }): Promise<ServerChannelDto> {
    const apiKey = input.apiKey.trim();
    const baseUrl = input.baseUrl.trim();
    const existing = await listServerChannels().catch(() => [] as ServerChannelDto[]);
    const matched = existing.find((channel) => channel.baseUrl.trim() === baseUrl);

    if (matched) {
        const payload = await apiPut<{ channel: ServerChannelDto }>(`/api/channels/${encodeURIComponent(matched.id)}`, {
            name: input.name,
            baseUrl,
            apiFormat: input.apiFormat,
            models: toServerModels(input.models),
            // 只有真的填了新密钥才带 apiKey；空字符串意味着"保留原密钥"。
            ...(apiKey ? { apiKey } : {}),
        });
        return payload.channel;
    }

    const payload = await apiPost<{ channel: ServerChannelDto }>("/api/channels", {
        name: input.name,
        baseUrl,
        apiFormat: input.apiFormat,
        models: toServerModels(input.models),
        apiKey,
    });
    return payload.channel;
}

/** 把一个本地渠道的明文密钥推到服务端，返回掩码提示。 */
export async function pushLocalChannelSecret(channel: ModelChannel): Promise<string | null> {
    const apiKey = channel.apiKey.trim();
    if (!apiKey || !channel.baseUrl.trim()) return null;
    const saved = await pushChannelSecret({ name: channel.name, baseUrl: channel.baseUrl, apiFormat: channel.apiFormat, models: channel.models, apiKey });
    return saved.apiKeyHint || null;
}

/** 迁移结果。 */
export type LegacyMigrationResult = { migrated: number; failed: number };

/**
 * 迁移一批历史明文密钥。
 *
 * @param entries 形如 `[{ channelId, apiKey }]`，来自持久化状态的残值
 * @param fallback 兜底渠道信息（老版本顶层只有 `baseUrl/apiKey` 两个字段时用）
 */
export async function migrateLegacySecrets(
    entries: Array<{ name: string; baseUrl: string; apiFormat: ApiCallFormat; models: ChannelModel[]; apiKey: string }>,
): Promise<LegacyMigrationResult> {
    let migrated = 0;
    let failed = 0;
    for (const entry of entries) {
        try {
            await pushChannelSecret(entry);
            migrated += 1;
        } catch {
            // 服务端不可达 / 未登录：本地明文先留着，下次启动再试（不丢用户密钥）。
            failed += 1;
        }
    }
    return { migrated, failed };
}

/**
 * 拉取服务端渠道的掩码，用于刷新本地展示。
 *
 * 返回 `baseUrl → apiKeyHint`，前端按 baseUrl 匹配回自己的渠道列表。
 */
export async function fetchChannelHints(): Promise<Record<string, string>> {
    const channels = await listServerChannels();
    const hints: Record<string, string> = {};
    for (const channel of channels) {
        if (channel.hasKey && channel.apiKeyHint) hints[channel.baseUrl.trim()] = channel.apiKeyHint;
    }
    return hints;
}
