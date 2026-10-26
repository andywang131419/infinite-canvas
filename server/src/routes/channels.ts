/**
 * `/api/channels` —— 模型渠道管理。
 *
 * 安全契约（T03 第 A 条，逐条可 grep 验证）：
 * - 响应体里**不存在** `apiKey` / `apiKeyCipher` / `encrypted` 任何形式；
 * - 只返回 `hasKey`（布尔）与 `apiKeyHint`（`sk-****abcd`）；
 * - `POST` / `PUT` 接收明文只用于**加密入库**，不回显、不记日志；
 * - 只有 `owner` 能写，`member` 只读。
 */

import { Hono } from "hono";
import { z } from "zod";

import { currentUser, requireAuth, type AuthVariables } from "../auth/middleware";
import { ApiError } from "../http/errors";
import { readJsonBody } from "../http/request";
import { ok } from "../http/respond";
import {
    createChannelForUser,
    deleteChannelForUser,
    getChannelDto,
    listChannelDtos,
    updateChannelForUser,
} from "../services/channel-service";

export const channelRoutes = new Hono<{ Variables: AuthVariables }>();

channelRoutes.use("*", requireAuth);

/** 渠道 body 上限（密钥 + 模型列表，64KB 足够）。 */
const CHANNEL_BODY_LIMIT = 64 * 1024;

/** 新建渠道的 body。 */
const createSchema = z.object({
    name: z.string().min(1).max(64),
    baseUrl: z.string().min(1).max(512),
    apiFormat: z.enum(["openai", "gemini"]),
    /**
     * `[{ name, capability }]`，由 service 层再做细校验。
     *
     * 这里用 `z.array(z.unknown())` 而不是 `z.unknown()`：后者的 TypeScript 输出类型
     * 是 `unknown`（含 `undefined`），会让整个字段变成"可选"，从而在类型层面
     * 允许"不传 models"的请求 —— 而它本该被明确拒绝。
     */
    models: z.array(z.unknown()),
    /** 明文密钥；只在请求方向出现，永不出现在响应里。 */
    apiKey: z.string().min(1).max(4096),
    isDefault: z.boolean().optional(),
    enabled: z.boolean().optional(),
});

/** 更新渠道的 body（apiKey 可省略 = 不改密钥）。 */
const updateSchema = createSchema.partial({ apiKey: true }).extend({
    name: z.string().min(1).max(64),
    baseUrl: z.string().min(1).max(512),
    apiFormat: z.enum(["openai", "gemini"]),
    models: z.array(z.unknown()),
});

/** 列表（含停用）。 */
channelRoutes.get("/channels", (c) => {
    const user = currentUser(c);
    return ok(c, { items: listChannelDtos(user.id) });
});

/** 单个渠道。 */
channelRoutes.get("/channels/:id", (c) => {
    const user = currentUser(c);
    return ok(c, { channel: getChannelDto(user.id, c.req.param("id")) });
});

/**
 * 新建渠道。
 *
 * 请求里的 `apiKey` 走 `encryptSecret()` 入库；
 * 响应里只有 `hasKey: true` 与 `apiKeyHint`。
 */
channelRoutes.post("/channels", async (c) => {
    const user = currentUser(c);
    const body = await readJsonBody<unknown>(c, CHANNEL_BODY_LIMIT);

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
        throw ApiError.validation(
            "请求体校验失败",
            parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        );
    }

    const channel = createChannelForUser(user, parsed.data);
    return ok(c, { channel }, 201);
});

/** 更新渠道（`apiKey` 省略即保留原密钥）。 */
channelRoutes.put("/channels/:id", async (c) => {
    const user = currentUser(c);
    const body = await readJsonBody<unknown>(c, CHANNEL_BODY_LIMIT);

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
        throw ApiError.validation(
            "请求体校验失败",
            parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        );
    }

    const channel = updateChannelForUser(user, c.req.param("id"), parsed.data);
    return ok(c, { channel });
});

/** 删除渠道（`jobs.channel_id` 会因 ON DELETE SET NULL 变成 null）。 */
channelRoutes.delete("/channels/:id", (c) => {
    const user = currentUser(c);
    deleteChannelForUser(user, c.req.param("id"));
    return c.body(null, 204);
});
