/**
 * 渠道服务 —— 密钥加解密、DTO 组装、按能力选路、宿主机白名单。
 *
 * 「只写不读」的完整闭环（T03 第 A 条）：
 *   POST/PUT 收到明文 apiKey → encryptSecret() → 存 api_key_cipher
 *                            → maskApiKey() → 存 api_key_hint
 *   GET      只读 api_key_hint / hasKey，**永不**解密
 *   Worker   需要真正调用上游时才 decryptSecret()，用完即弃，不进日志
 *
 * 这条边界靠三件事保证：
 * ① `ChannelDto` 类型里没有密钥字段（不是赋空值，是没有）；
 * ② 只有本文件的 `resolveChannelSecret()` 会解密，而它只被 provider 层调用；
 * ③ 路由层只能拿到 DTO。
 */

import { decryptSecret, encryptSecret, maskApiKey, SecretBoxError } from "../crypto/secret-box";
import {
    canManageChannels,
    createChannel,
    deleteChannel,
    findChannelById,
    findChannelByIdInternal,
    listChannels,
    listEnabledChannels,
    parseModels,
    toChannelDto,
    updateChannel,
    type ChannelDto,
    type ChannelModel,
    type ChannelRow,
    type ModelCapability,
} from "../db/repos/channels";
import type { SessionUser } from "../auth/session";
import { ApiError } from "../http/errors";

/** 允许的上游 baseUrl 协议（http 仅用于内网自建网关）。 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** baseUrl 最大长度（防有人塞一个超长串进 DB）。 */
const MAX_BASE_URL_LENGTH = 512;

/** 渠道名称最大长度。 */
const MAX_NAME_LENGTH = 64;

/**
 * 规范化并校验 baseUrl。
 *
 * 规则：
 * - 必须是 http/https，且带 host；
 * - **禁止**在 URL 里带账号密码（`https://user:pass@host`）——这类 URL 会被
 *   原样带进上游请求，等于把凭据写进日志；
 * - 去掉末尾斜杠，保证后续拼 `/v1/...` 不会出现 `//`。
 *
 * @throws {ApiError} 400
 */
export function normalizeBaseUrl(raw: string): string {
    const trimmed = (raw ?? "").trim();
    if (trimmed.length === 0) throw ApiError.validation("baseUrl 不能为空", { field: "baseUrl" });
    if (trimmed.length > MAX_BASE_URL_LENGTH) throw ApiError.validation(`baseUrl 不得超过 ${MAX_BASE_URL_LENGTH} 字符`, { field: "baseUrl" });

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw ApiError.validation("baseUrl 不是合法 URL", { field: "baseUrl" });
    }

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw ApiError.validation(`baseUrl 协议必须是 http 或 https（当前：${parsed.protocol}）`, { field: "baseUrl" });
    }
    if (!parsed.hostname) {
        throw ApiError.validation("baseUrl 缺少主机名", { field: "baseUrl" });
    }
    if (parsed.username || parsed.password) {
        throw ApiError.validation("baseUrl 不得包含账号密码", { field: "baseUrl" });
    }

    // 保留 path（很多自建网关形如 https://gw.local/openai），只裁掉末尾斜杠。
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
}

/** 取 baseUrl 的 hostname（小写，无端口）—— 白名单与 SSRF 判定都用它。 */
export function hostnameOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).hostname.toLowerCase();
    } catch {
        return "";
    }
}

/** 校验模型列表。 */
export function validateModels(raw: unknown): ChannelModel[] {
    if (!Array.isArray(raw)) throw ApiError.validation("models 必须是数组", { field: "models" });

    const models: ChannelModel[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") {
            throw ApiError.validation("models 元素必须是 { name, capability }", { field: "models" });
        }
        const record = item as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        const capability = record.capability;

        if (name.length === 0) throw ApiError.validation("models 元素的 name 不能为空", { field: "models" });
        if (capability !== "image" && capability !== "video" && capability !== "audio" && capability !== "text") {
            throw ApiError.validation("models 元素的 capability 必须是 image|video|audio|text", { field: "models" });
        }
        models.push({ name, capability });
    }

    return models;
}

/** 列出渠道（DTO，无密钥）。 */
export function listChannelDtos(ownerId: string): ChannelDto[] {
    return listChannels(ownerId).map(toChannelDto);
}

/** 建渠道入参（来自路由 body，已过 zod）。 */
export type CreateChannelBody = {
    name: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    models: unknown;
    apiKey: string;
    isDefault?: boolean;
    enabled?: boolean;
};

/**
 * 建渠道：加密密钥、生成 hint、落库，返回**不含密钥**的 DTO。
 */
export function createChannelForUser(user: SessionUser, body: CreateChannelBody): ChannelDto {
    assertCanManage(user);

    const name = body.name.trim();
    if (name.length === 0) throw ApiError.validation("渠道名称不能为空", { field: "name" });
    if (name.length > MAX_NAME_LENGTH) throw ApiError.validation(`渠道名称不得超过 ${MAX_NAME_LENGTH} 字符`, { field: "name" });
    if (body.apiKey.trim().length === 0) throw ApiError.validation("apiKey 不能为空", { field: "apiKey" });

    const models = validateModels(body.models);
    if (models.length === 0) throw ApiError.validation("至少配置一个模型", { field: "models" });

    const row = createChannel({
        ownerId: user.id,
        name,
        baseUrl: normalizeBaseUrl(body.baseUrl),
        apiFormat: body.apiFormat,
        models,
        apiKeyCipher: encryptSecret(body.apiKey.trim()),
        apiKeyHint: maskApiKey(body.apiKey.trim()),
        isDefault: body.isDefault === true,
        enabled: body.enabled !== false,
    });

    return toChannelDto(row);
}

/** 更新渠道入参。`apiKey` 省略 = 不改密钥。 */
export type UpdateChannelBody = {
    name: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    models: unknown;
    apiKey?: string;
    isDefault?: boolean;
    enabled?: boolean;
};

/**
 * 更新渠道。
 *
 * 密钥语义：`apiKey` 为 undefined 或空串 → **保留原密钥**。
 * （前端编辑时看不到原密钥，只能"不改"或"填新的"，不允许把密钥清空成空串。）
 */
export function updateChannelForUser(user: SessionUser, id: string, body: UpdateChannelBody): ChannelDto {
    assertCanManage(user);

    const name = body.name.trim();
    if (name.length === 0) throw ApiError.validation("渠道名称不能为空", { field: "name" });

    const models = validateModels(body.models);
    if (models.length === 0) throw ApiError.validation("至少配置一个模型", { field: "models" });

    const nextKey = body.apiKey?.trim();

    const row = updateChannel({
        ownerId: user.id,
        id,
        name,
        baseUrl: normalizeBaseUrl(body.baseUrl),
        apiFormat: body.apiFormat,
        models,
        ...(nextKey && nextKey.length > 0 ? { apiKeyCipher: encryptSecret(nextKey), apiKeyHint: maskApiKey(nextKey) } : {}),
        isDefault: body.isDefault,
        enabled: body.enabled,
    });

    if (!row) throw ApiError.notFound("渠道不存在");

    return toChannelDto(row);
}

/** 删除渠道。 */
export function deleteChannelForUser(user: SessionUser, id: string): void {
    assertCanManage(user);
    if (!deleteChannel(user.id, id)) throw ApiError.notFound("渠道不存在");
}

/** 更新后取一次 DTO（用于返回）。 */
export function getChannelDto(ownerId: string, id: string): ChannelDto {
    const row = findChannelById(ownerId, id);
    if (!row) throw ApiError.notFound("渠道不存在");
    return toChannelDto(row);
}

/**
 * **唯一**解密入口。
 *
 * 只允许 provider 层 / Worker 调用。返回的 apiKey 必须立即用掉，
 * 不得存入 module 级变量、不得进入任何日志或错误信息。
 *
 * @throws {ApiError} 404 渠道不存在；400 未配置密钥；500 解密失败
 */
export function resolveChannelSecret(channelId: string): { channel: ChannelRow; apiKey: string } {
    // 用 `findChannelByIdInternal`（不限定 owner）：Worker 处理任务时手里只有
    // channel_id，没有会话用户。渠道归属在入队时已经校验过一次。
    const channel = findChannelByIdInternal(channelId);
    if (!channel) throw ApiError.notFound("渠道不存在或已被删除");

    if (!channel.api_key_cipher) {
        throw new ApiError("PROVIDER_KEY_MISSING", "该渠道尚未配置密钥", { channelId });
    }

    try {
        return { channel, apiKey: decryptSecret(channel.api_key_cipher) };
    } catch (error) {
        // 注意：这里**不能**把 error.message 里的任何密钥片段透出；
        // SecretBoxError 的 message 本身不含密钥，可以安全带上 reason。
        const reason = error instanceof SecretBoxError ? error.reason : "unknown";
        throw new ApiError("PROVIDER_KEY_MISSING", "渠道密钥无法解密（AUTH_SECRET 可能已更换，请重新填写密钥）", { channelId, reason });
    }
}

/**
 * 按能力选渠道。
 *
 * 顺序：显式 channelId → 默认渠道 → 第一个启用且声明了该能力的渠道。
 *
 * @throws {ApiError} 404 找不到可用渠道
 */
export function pickChannelForCapability(ownerId: string, capability: ModelCapability, channelId?: string | null): ChannelRow {
    if (channelId) {
        const explicit = findChannelById(ownerId, channelId);
        if (!explicit) throw ApiError.notFound("指定的渠道不存在");
        if (explicit.enabled !== 1) throw new ApiError("PROVIDER_KEY_MISSING", "指定的渠道已停用", { channelId });
        return explicit;
    }

    const enabled = listEnabledChannels(ownerId);
    if (enabled.length === 0) throw new ApiError("PROVIDER_KEY_MISSING", "尚未配置任何启用的渠道");

    const supports = (row: ChannelRow) => parseModels(row.models).some((model) => model.capability === capability);

    const preferred = enabled.find((row) => row.is_default === 1 && supports(row)) ?? enabled.find(supports);
    if (!preferred) {
        throw new ApiError("PROVIDER_KEY_MISSING", `没有渠道声明 ${capability} 能力，请先在渠道里给模型指定能力`);
    }
    return preferred;
}

/**
 * 宿主机白名单（Tier2 直通代理与 SSRF 防护共用）。
 *
 * 来源：**启用的** channels 的 base_url host 集合。
 * 只算启用的：停用渠道等于"关掉了这条出站路径"。
 */
export function upstreamHostAllowlist(ownerId: string): Set<string> {
    const hosts = new Set<string>();
    for (const channel of listEnabledChannels(ownerId)) {
        const host = hostnameOf(channel.base_url);
        if (host) hosts.add(host);
    }
    return hosts;
}

/** 权限断言：只有 owner 能改渠道。 */
function assertCanManage(user: SessionUser): void {
    if (!canManageChannels(user.role)) {
        throw new ApiError("FORBIDDEN", "只有管理员可以修改渠道配置");
    }
}

/**
 * 按主机名找渠道（Tier2 直通代理注入密钥用）。
 *
 * 匹配规则与 `guard.ts: isAllowedHost` 保持一致：完全相等，或以 `.渠道主机` 结尾。
 * 只考虑**启用**的渠道：停用渠道不该再出现在出站路径上。
 *
 * @param channelId 显式指定的渠道；给了就必须存在且启用，否则返回 null（不注入）
 */
export function findChannelForHost(ownerId: string, hostname: string, channelId?: string): ChannelRow | null {
    const host = (hostname || "").trim().toLowerCase();
    if (host.length === 0) return null;

    if (channelId) {
        const explicit = findChannelById(ownerId, channelId);
        return explicit && explicit.enabled === 1 ? explicit : null;
    }

    for (const channel of listEnabledChannels(ownerId)) {
        const channelHost = hostnameOf(channel.base_url);
        if (!channelHost) continue;
        if (host === channelHost || host.endsWith(`.${channelHost}`)) return channel;
    }
    return null;
}
