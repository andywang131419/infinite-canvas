/**
 * channels 仓储 —— 模型渠道（服务端持有密钥）。
 *
 * 关键约定（ARCH Rev2 §R5 + T03 第 A 条）：
 * - `api_key_cipher` 是 {@link ../crypto/secret-box} 的密文，**只在服务端内部流转**；
 * - `api_key_hint` 是唯一允许回传前端的密钥相关信息（形如 `sk-****abcd`）；
 * - 对外的 DTO 里**不存在** `apiKey` / `apiKeyCipher` 字段 —— 不是"置空"，
 *   而是压根没有这个 key，避免将来有人手滑把它们塞进响应。
 */

import { getDb } from "../client";
import type { UserRole } from "./users";

/** 模型能力（与 `jobs.capability` 的 CHECK 一致）。 */
export type ModelCapability = "image" | "video" | "audio" | "text";

/** 渠道里的单个模型声明。 */
export type ChannelModel = {
    /** 上游模型名，例如 `gpt-image-1` / `gemini-2.5-flash-image`。 */
    name: string;
    /** 该模型擅长的能力。 */
    capability: ModelCapability;
};

/** 渠道行（含密文，**仅服务端内部使用**）。 */
export type ChannelRow = {
    id: string;
    owner_id: string;
    name: string;
    base_url: string;
    api_format: "openai" | "gemini";
    models: string;
    api_key_cipher: string;
    api_key_hint: string;
    extra: string | null;
    is_default: number;
    enabled: number;
    created_at: string;
    updated_at: string;
};

/**
 * 对外 DTO —— 注意这里**没有** apiKey / apiKeyCipher 字段。
 *
 * `hasKey` 用于前端渲染"已配置 / 未配置"，`apiKeyHint` 用于人工核对是哪把 key。
 */
export type ChannelDto = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    models: ChannelModel[];
    /** 是否已配置密钥。 */
    hasKey: boolean;
    /** 形如 `sk-****abcd`；未配置时为空串。 */
    apiKeyHint: string;
    isDefault: boolean;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
};

const SQL_SELECT_BY_ID = `
SELECT id, owner_id, name, base_url, api_format, models, api_key_cipher, api_key_hint,
       extra, is_default, enabled, created_at, updated_at
  FROM channels WHERE id = ? AND owner_id = ?
`;

const SQL_SELECT_BY_ID_ANY_OWNER = `
SELECT id, owner_id, name, base_url, api_format, models, api_key_cipher, api_key_hint,
       extra, is_default, enabled, created_at, updated_at
  FROM channels WHERE id = ?
`;

const SQL_LIST = `
SELECT id, owner_id, name, base_url, api_format, models, api_key_cipher, api_key_hint,
       extra, is_default, enabled, created_at, updated_at
  FROM channels
 WHERE owner_id = ?
 ORDER BY is_default DESC, created_at ASC
`;

const SQL_LIST_ENABLED = `
SELECT id, owner_id, name, base_url, api_format, models, api_key_cipher, api_key_hint,
       extra, is_default, enabled, created_at, updated_at
  FROM channels
 WHERE owner_id = ? AND enabled = 1
 ORDER BY is_default DESC, created_at ASC
`;

const SQL_INSERT = `
INSERT INTO channels (id, owner_id, name, base_url, api_format, models, api_key_cipher,
                      api_key_hint, extra, is_default, enabled, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SQL_UPDATE = `
UPDATE channels
   SET name = ?, base_url = ?, api_format = ?, models = ?, api_key_cipher = ?,
       api_key_hint = ?, extra = ?, is_default = ?, enabled = ?, updated_at = ?
 WHERE id = ? AND owner_id = ?
`;

const SQL_DELETE = `DELETE FROM channels WHERE id = ? AND owner_id = ?`;

const SQL_CLEAR_DEFAULT = `UPDATE channels SET is_default = 0 WHERE owner_id = ? AND is_default = 1`;

const SQL_TOUCH = `UPDATE channels SET updated_at = ? WHERE id = ? AND owner_id = ?`;

/** 解析 `models` 列（坏 JSON 一律降级为空数组，不让一条脏数据把列表接口弄挂）。 */
export function parseModels(raw: string): ChannelModel[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((item) => {
                if (!item || typeof item !== "object") return null;
                const record = item as Record<string, unknown>;
                const name = typeof record.name === "string" ? record.name.trim() : "";
                const capability = record.capability;
                if (name.length === 0) return null;
                if (capability !== "image" && capability !== "video" && capability !== "audio" && capability !== "text") return null;
                return { name, capability } satisfies ChannelModel;
            })
            .filter((item): item is ChannelModel => item !== null);
    } catch {
        return [];
    }
}

/**
 * 行 → DTO。
 *
 * 唯一入口：所有对外返回都必须经过这里，保证密文不可能泄漏到响应里。
 */
export function toChannelDto(row: ChannelRow): ChannelDto {
    return {
        id: row.id,
        name: row.name,
        baseUrl: row.base_url,
        apiFormat: row.api_format,
        models: parseModels(row.models),
        hasKey: row.api_key_cipher.length > 0,
        apiKeyHint: row.api_key_hint,
        isDefault: row.is_default === 1,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** 按 id 取（限定 owner，防横向越权）。 */
export function findChannelById(ownerId: string, id: string): ChannelRow | null {
    return (getDb().query(SQL_SELECT_BY_ID).get(id, ownerId) as ChannelRow | null) ?? null;
}

/**
 * 按 id 取（**不限 owner**，仅供 Worker 内部使用）。
 *
 * Worker 处理任务时手里只有 `jobs.channel_id`（任务创建时已校验过归属），
 * 若这里再要求 owner 就会出现"任务跑不动"的耦合。
 * 该函数**不得**被任何 HTTP 路由直接调用。
 */
export function findChannelByIdInternal(id: string): ChannelRow | null {
    return (getDb().query(SQL_SELECT_BY_ID_ANY_OWNER).get(id) as ChannelRow | null) ?? null;
}

/** 列出全部渠道（含停用）。 */
export function listChannels(ownerId: string): ChannelRow[] {
    return getDb().query(SQL_LIST).all(ownerId) as ChannelRow[];
}

/** 列出启用的渠道（宿主白名单、模型路由都用这个）。 */
export function listEnabledChannels(ownerId: string): ChannelRow[] {
    return getDb().query(SQL_LIST_ENABLED).all(ownerId) as ChannelRow[];
}

/** 建渠道入参（`apiKeyCipher` 已加密，本层不碰明文）。 */
export type CreateChannelInput = {
    ownerId: string;
    name: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    models: ChannelModel[];
    apiKeyCipher: string;
    apiKeyHint: string;
    extra?: string | null;
    isDefault?: boolean;
    enabled?: boolean;
};

/** 建渠道。 */
export function createChannel(input: CreateChannelInput): ChannelRow {
    const db = getDb();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    if (input.isDefault) {
        db.query(SQL_CLEAR_DEFAULT).run(input.ownerId);
    }

    db.query(SQL_INSERT).run(
        id,
        input.ownerId,
        input.name,
        input.baseUrl,
        input.apiFormat,
        JSON.stringify(input.models),
        input.apiKeyCipher,
        input.apiKeyHint,
        input.extra ?? null,
        input.isDefault ? 1 : 0,
        input.enabled === false ? 0 : 1,
        now,
        now,
    );

    const created = findChannelById(input.ownerId, id);
    if (!created) throw new Error("渠道创建后无法读回");
    return created;
}

/** 更新渠道入参。`apiKeyCipher/apiKeyHint` 为 undefined 表示"不修改密钥"。 */
export type UpdateChannelInput = {
    ownerId: string;
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    models: ChannelModel[];
    apiKeyCipher?: string;
    apiKeyHint?: string;
    extra?: string | null;
    isDefault?: boolean;
    enabled?: boolean;
};

/**
 * 更新渠道。
 *
 * 密钥字段为 undefined 时**保留原值**（"只写不读"语义下的必要行为：
 * 前端编辑渠道时拿不到原密钥，只能选择"不改"或"填一把新的"）。
 */
export function updateChannel(input: UpdateChannelInput): ChannelRow | null {
    const db = getDb();
    const existing = findChannelById(input.ownerId, input.id);
    if (!existing) return null;

    if (input.isDefault) db.query(SQL_CLEAR_DEFAULT).run(input.ownerId);

    db.query(SQL_UPDATE).run(
        input.name,
        input.baseUrl,
        input.apiFormat,
        JSON.stringify(input.models),
        input.apiKeyCipher ?? existing.api_key_cipher,
        input.apiKeyHint ?? existing.api_key_hint,
        input.extra === undefined ? existing.extra : input.extra,
        input.isDefault === undefined ? existing.is_default : input.isDefault ? 1 : 0,
        input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        new Date().toISOString(),
        input.id,
        input.ownerId,
    );

    return findChannelById(input.ownerId, input.id);
}

/** 删除渠道。@returns 是否真的删了一行。 */
export function deleteChannel(ownerId: string, id: string): boolean {
    return Number(getDb().query(SQL_DELETE).run(id, ownerId).changes) > 0;
}

/** 轻量 touch（例如"测试连通性成功"时刷新 updated_at）。 */
export function touchChannel(ownerId: string, id: string): void {
    getDb().query(SQL_TOUCH).run(new Date().toISOString(), id, ownerId);
}

/** 角色是否允许管理渠道（当前只有 owner 能改，member 只读）。 */
export function canManageChannels(role: UserRole): boolean {
    return role === "owner";
}
