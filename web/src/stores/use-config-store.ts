import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { fetchChannelHints, pushChannelSecret } from "@/services/channel-secrets";

export type ApiCallFormat = "openai" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    /** 明文密钥。**T04-A6 起只写**：填进来就推服务端加密存储，然后立刻清成 `""`。 */
    apiKey: string;
    /** 服务端返回的掩码提示（`sk-****abcd`），用于展示"已配置"与让用户确认是哪把 key。 */
    apiKeyHint?: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    /** 同 `ModelChannel.apiKey`：只写、不持久化。 */
    apiKey: string;
    /** 服务端掩码提示（老版本顶层单渠道场景用）。 */
    apiKeyHint?: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    proxyEnabled: boolean;
    proxyUrl: string;
    nodeRegenerateBehavior: "new-node" | "overwrite";
    autoFocusOnSelect: boolean;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "local-proxy" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export type ChannelCredentialsImportResult = {
    status: "created" | "updated" | "missing-base-url" | "invalid-base-url";
    channelName?: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const LOCAL_PROXY_PACKAGE = "@basketikun/canvas-proxy";
export const DEFAULT_LOCAL_PROXY_URL = "http://127.0.0.1:23210";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
    proxyEnabled: false,
    proxyUrl: DEFAULT_LOCAL_PROXY_URL,
    nodeRegenerateBehavior: "new-node",
    autoFocusOnSelect: false,
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    /**
     * 保存渠道列表（T04-A6）。
     *
     * 与直接 `updateConfig("channels", ...)` 的区别：这里会**先把明文密钥推给服务端**，
     * 拿到掩码后把本地 `apiKey` 清空再落库。所有改渠道的入口都必须走它。
     */
    persistChannels: (channels: ModelChannel[]) => Promise<void>;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo"];

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        // Keep unavailable selections visible so the readiness check blocks the
        // request. Only a known capability switch may choose another model.
        if (!configuredCapability || configuredCapability === capability) return model;
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

/**
 * 这个渠道是否"已配置密钥"。
 *
 * T04-A6 起明文密钥不再落 localStorage，因此判断依据有两个：
 * - `apiKey` 非空（用户刚在输入框里填了、还没来得及推服务端）；
 * - `apiKeyHint` 非空（服务端确认有密钥，这里只有掩码）。
 *
 * 所有"能不能发请求"的前置检查都必须走这个函数，否则改造后处处误报"未配置密钥"。
 */
export function channelHasKey(channel: Pick<ModelChannel, "apiKey" | "apiKeyHint">): boolean {
    return Boolean(channel.apiKey.trim() || channel.apiKeyHint);
}

// ---------------------------------------------------------------------------
// T04-A6：密钥只写 —— 持久化剥离、老数据迁移、掩码回填
// ---------------------------------------------------------------------------

/** 一条待迁移的历史明文密钥。 */
type LegacySecret = { name: string; baseUrl: string; apiFormat: ApiCallFormat; models: ChannelModel[]; apiKey: string };

/** 从 localStorage 残值里抠出来、还没成功推到服务端的密钥（进程内队列，重启会再生成）。 */
const pendingLegacySecrets: LegacySecret[] = [];

/** 剔除所有明文密钥（`partialize` 专用）。 */
function stripSecrets(config: AiConfig): AiConfig {
    return {
        ...config,
        apiKey: "",
        channels: config.channels.map((channel) => ({ ...channel, apiKey: "" })),
    };
}

/** 把渠道列表写回 config（同步刷新 models / 顶层 baseUrl / 各能力默认模型）。 */
function applyChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const next: AiConfig = {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
    };
    return {
        ...next,
        imageModel: pickDefaultModel(next, "image", config.imageModel),
        videoModel: pickDefaultModel(next, "video", config.videoModel),
        textModel: pickDefaultModel(next, "text", config.textModel),
        audioModel: pickDefaultModel(next, "audio", config.audioModel),
    };
}

/** 当前选中的模型不在新渠道里时，退回到该能力的第一个可用模型。 */
function pickDefaultModel(config: AiConfig, capability: ModelCapability, current: string): string {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}

/** 从持久化残值里收集明文密钥（`merge` 期间调用一次）。 */
function queueLegacySecrets(persisted: Partial<AiConfig>): void {
    const channels = Array.isArray(persisted.channels) ? persisted.channels : [];
    for (const channel of channels) {
        const apiKey = (channel?.apiKey ?? "").trim();
        const baseUrl = (channel?.baseUrl ?? "").trim();
        if (!apiKey || !baseUrl) continue;
        pendingLegacySecrets.push({
            name: channel.name || i18n.t("config.channels.defaultName"),
            baseUrl,
            apiFormat: normalizeApiFormat(channel.apiFormat),
            models: normalizeChannelModels(channel.models),
            apiKey,
        });
    }

    // 老版本没有 channels 数组，只有顶层 baseUrl + apiKey。
    const topLevelKey = (persisted.apiKey ?? "").trim();
    const topLevelBaseUrl = (persisted.baseUrl ?? "").trim();
    if (topLevelKey && topLevelBaseUrl) {
        pendingLegacySecrets.push({
            name: i18n.t("config.channels.defaultName"),
            baseUrl: topLevelBaseUrl,
            apiFormat: normalizeApiFormat(persisted.apiFormat),
            models: [],
            apiKey: topLevelKey,
        });
    }
}

/** 拉一次服务端掩码并回填到本地渠道（按 baseUrl 匹配；回填不会覆盖用户刚输入的明文）。 */
export async function refreshChannelHints(): Promise<void> {
    try {
        const hints = await fetchChannelHints();
        useConfigStore.setState((state) => ({
            config: {
                ...state.config,
                channels: state.config.channels.map((channel) => {
                    const hint = hints[channel.baseUrl.trim()];
                    return hint ? { ...channel, apiKeyHint: hint } : channel;
                }),
                ...(hints[state.config.baseUrl.trim()] ? { apiKeyHint: hints[state.config.baseUrl.trim()] } : {}),
            },
        }));
    } catch {
        // 后端不可达：掩码只是展示用，缺了不影响生成。
    }
}

/**
 * 迁移历史明文密钥到服务端（幂等）。
 *
 * 成功推上去的那些不会丢；失败的原样留在内存队列里，下次启动 `merge` 会重新生成队列再试。
 * **无论如何明文都不会被写回 localStorage** —— `partialize` 已经把它剔掉了。
 */
export async function flushLegacySecrets(): Promise<void> {
    if (pendingLegacySecrets.length === 0) return;
    const batch = pendingLegacySecrets.splice(0, pendingLegacySecrets.length);
    const leftovers: LegacySecret[] = [];
    let migrated = 0;
    for (const entry of batch) {
        try {
            await pushChannelSecret(entry);
            migrated += 1;
        } catch {
            leftovers.push(entry);
        }
    }
    pendingLegacySecrets.push(...leftovers);
    if (migrated > 0) await refreshChannelHints();
}

function isAiConfigReady(config: AiConfig, model: string) {
    const match = findChannelModel(config, model);
    return Boolean(match && match.channel.baseUrl.trim() && channelHasKey(match.channel));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            importChannelCredentials: (input) => {
                const currentConfig = get().config;
                const result = upsertChannelCredentials(currentConfig, input);
                if (result.config !== currentConfig) {
                    set({ config: result.config });
                    // 导入的通常是明文 key（`?apiKey=` 链接）：立刻推服务端并擦掉本地明文，
                    // 否则 `partialize` 会把它从磁盘剔除，刷新后就永久丢了。
                    const hasPlaintext = result.config.channels.some((channel) => channel.apiKey.trim());
                    if (hasPlaintext) void get().persistChannels(result.config.channels);
                }
                return { status: result.status, channelName: result.channelName };
            },
            /**
             * 保存渠道列表（T04-A6）。
             *
             * 顺序很重要：**先推送明文密钥 → 拿到掩码 → 再清空本地明文**。
             * 反过来（先清空再推）一旦推送失败，用户的 key 就永久丢了。
             * 推送失败时明文仍保留在内存里（`apiKey` 不为空），界面能提示"未保存成功"，
             * 用户重试一次即可；而 `partialize` 保证它永远不会被写进 localStorage。
             */
            persistChannels: async (channels) => {
                const resolved: ModelChannel[] = [];
                for (const channel of channels) {
                    const apiKey = channel.apiKey.trim();
                    if (!apiKey || !channel.baseUrl.trim()) {
                        resolved.push(channel);
                        continue;
                    }
                    try {
                        const saved = await pushChannelSecret({
                            name: channel.name,
                            baseUrl: channel.baseUrl,
                            apiFormat: channel.apiFormat,
                            models: channel.models,
                            apiKey,
                        });
                        // 推送成功：明文立刻清空，只留服务端给的掩码。
                        resolved.push({ ...channel, apiKey: "", apiKeyHint: saved.apiKeyHint || channel.apiKeyHint });
                    } catch {
                        // 推送失败：保留明文，让用户能重试（不写入磁盘，见 `stripSecrets`）。
                        resolved.push(channel);
                    }
                }
                set((state) => ({ config: applyChannels(state.config, resolved) }));
            },
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            /**
             * 只持久化"不含密钥"的部分（T04-A6）。
             *
             * 密钥由服务端加密保管，前端只需要掩码 `apiKeyHint`；
             * 把 `apiKey` 从结构里剔掉（而不是只在写入时置空）才能真正保证
             * "老版本残留的明文再也不会被写回 localStorage"。
             */
            partialize: (state) => ({ config: stripSecrets(state.config), webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                // 迁移用的历史明文密钥：`persisted` 是**磁盘上的原始值**，
                // 这里把残值抠出来排队，交给 `flushLegacySecrets()` 推到服务端后擦除。
                queueLegacySecrets(persistedConfig);
                const config = { ...defaultConfig, ...persistedConfig };
                if (!Array.isArray(persistedConfig.channels)) config.channels = [];
                const channels = normalizeChannels(config);
                const models = modelOptionsFromChannels(channels);
                return {
                    ...current,
                    webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                    config: {
                        ...config,
                        channelMode: "local",
                        apiFormat: normalizeApiFormat(config.apiFormat),
                        channels,
                        models,
                        imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
                        videoModel: normalizeModelOptionValue(config.videoModel, channels),
                        textModel: normalizeModelOptionValue(config.textModel || config.model, channels),
                        audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        audioInstructions: config.audioInstructions || "",
                        reasoningEffort: config.reasoningEffort || "auto",
                        videoSeconds: config.videoSeconds || "6",
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        videoMode: config.videoMode === "reference" ? "reference" : "frames",
                        canvasImageCount: config.canvasImageCount || "3",
                        proxyEnabled: Boolean(config.proxyEnabled),
                        proxyUrl: config.proxyUrl || DEFAULT_LOCAL_PROXY_URL,
                        nodeRegenerateBehavior: config.nodeRegenerateBehavior === "overwrite" ? "overwrite" : "new-node",
                        autoFocusOnSelect: Boolean(config.autoFocusOnSelect),
                    },
                };
            },
            /**
             * 水合完成后做两件事（都失败静默）：
             * 1. 把 `merge` 期间收集到的历史明文密钥推到服务端（幂等迁移）；
             * 2. 拉一次服务端掩码，让"已配置密钥"的提示能显示出来。
             */
            onRehydrateStorage: () => () => {
                void flushLegacySecrets();
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        result.push({ name, capability, script });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        // 掩码是"服务端已有密钥"的唯一线索，任何渠道对象的派生都必须把它带上。
        ...(channel?.apiKeyHint ? { apiKeyHint: channel.apiKeyHint } : {}),
        apiFormat,
        models: normalizeChannelModels(channel?.models),
    };
}

export function upsertChannelCredentials(
    config: AiConfig,
    input: { baseUrl?: string | null; apiKey?: string | null },
): ChannelCredentialsImportResult & { config: AiConfig } {
    const rawBaseUrl = input.baseUrl?.trim() || "";
    if (!rawBaseUrl) return { status: "missing-base-url", config };
    if (!isHttpBaseUrl(rawBaseUrl)) return { status: "invalid-base-url", config };

    const baseUrl = normalizeImportedBaseUrl(rawBaseUrl);
    const apiKey = input.apiKey?.trim() || "";
    const matchingIndex = config.channels.findIndex((channel) => normalizedBaseUrlKey(channel.baseUrl) === normalizedBaseUrlKey(baseUrl));

    if (matchingIndex >= 0) {
        const existing = config.channels[matchingIndex];
        if (existing.baseUrl === baseUrl && (!apiKey || existing.apiKey === apiKey)) {
            return { status: "updated", channelName: existing.name, config };
        }
        const updated = { ...existing, baseUrl, ...(apiKey ? { apiKey } : {}) };
        const channels = config.channels.map((channel, index) => (index === matchingIndex ? updated : channel));
        return { status: "updated", channelName: existing.name, config: { ...config, channels } };
    }

    const channel = createModelChannel({
        name: importedChannelName(baseUrl),
        baseUrl,
        apiKey,
        apiFormat: "openai",
        models: [],
    });
    return { status: "created", channelName: channel.name, config: { ...config, channels: [...config.channels, channel] } };
}

function isHttpBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}

function normalizedBaseUrlKey(baseUrl: string) {
    try {
        return stripTrailingApiVersion(normalizeImportedBaseUrl(baseUrl));
    } catch {
        return stripTrailingApiVersion(baseUrl.trim().replace(/\/+$/, ""));
    }
}

function normalizeImportedBaseUrl(baseUrl: string) {
    const url = new URL(baseUrl.trim());
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
}

function stripTrailingApiVersion(baseUrl: string) {
    return baseUrl.replace(/\/v1$/i, "");
}

function importedChannelName(baseUrl: string) {
    const hostname = new URL(baseUrl).hostname;
    return hostname.replace(/^(?:www|api)\./i, "") || i18n.t("config.channels.newName");
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiKeyHint: config.apiKeyHint, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        // 掩码要一起带上：调用方用 `channelHasKey` 判断"已配置"，没有它会误报未配置。
        apiKeyHint: channel.apiKeyHint,
        apiFormat: channel.apiFormat,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? apiFormat : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return withLocalProxy(`${apiBaseUrl}${path}`);
}

export function normalizeLocalProxyUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * Prefix an outgoing request with the local forwarding proxy so the browser is not blocked by CORS.
 *
 * **T04-A2 起已退化为恒等函数**：上游请求统一由服务端 `/api/proxy` 代发
 * （见 `services/server-fetch.ts`），本地 canvas-proxy 不再是必需链路。
 *
 * 保留导出而不是删掉调用点的理由：
 * 1. 调用点都在"拼 URL"的纯函数里，恒等实现让它们继续成立，不必一次性改十几个文件；
 * 2. 老配置里的 `proxyEnabled` / `proxyUrl` 仍要被设置页读出来、提示"已由服务端代理取代"，
 *    直接删字段会让老用户看到一堆失效配置而无从解释。
 */
export function withLocalProxy(url: string) {
    return url;
}
