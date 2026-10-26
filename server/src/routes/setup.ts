/**
 * `/api/setup` —— 首次初始化（**仅当 users 表为空时可访问**）。
 *
 * 为什么需要它而不是只靠脚本：
 * 用户拿到一台空主机 + `docker compose up` 之后，如果没有 UI 建号，
 * 就只能 SSH 进容器跑 `bun run scripts/create-user.ts`。这不该是必需步骤。
 *
 * 安全模型（两条同时成立才安全）：
 * 1. **只有 `users` 表为空时**才允许建号 —— 建完第一个账号，这个接口永久 409；
 * 2. `BEGIN IMMEDIATE` 串行化"查空 + 插入"，防止两个人同时打开初始化页
 *    各自建出一个 owner（那样就变成公开注册漏洞了）。
 *
 * 公开注册（`ALLOW_REGISTRATION`）本版固定关闭，只在这里暴露初始化入口。
 */

import { Hono } from "hono";
import { z } from "zod";

import { checkPasswordStrength, hashPassword } from "../auth/password";
import { issueSession } from "../auth/session";
import { countUsers, createUser, isPlausibleEmail, isInitialized, normalizeEmail, toPublicUser, type UserRow } from "../db/repos/users";
import { getDb } from "../db/client";
import { getEnv } from "../env";
import { ApiError } from "../http/errors";
import { clientIp, readJsonBody } from "../http/request";
import { ok } from "../http/respond";

export const setupRoutes = new Hono();

/** 初始化请求体上限。 */
const SETUP_BODY_LIMIT = 64 * 1024;

/** 初始化请求体。 */
const setupSchema = z.object({
    email: z.string().min(1, "请输入邮箱").max(254),
    password: z.string().min(1, "请输入密码").max(256),
    /** 可选显示名；不填则用邮箱前缀。 */
    displayName: z.string().trim().max(64).optional(),
});

/**
 * 初始化状态探针（前端决定显示"登录页"还是"初始化页"）。
 *
 * 不鉴权：它只暴露"是否已初始化"这一个布尔，没有信息泄露面。
 */
setupRoutes.get("/setup/status", (c) =>
    ok(c, {
        initialized: isInitialized(),
        /** 本版固定 false（关闭公开注册），保留字段供后续设置页展示。 */
        registrationEnabled: getEnv().ALLOW_REGISTRATION,
    }),
);

/**
 * 创建首个管理员账号并直接登录。
 *
 * @throws {ApiError} 409 `ALREADY_INITIALIZED` 已有用户；400 参数不合法
 */
setupRoutes.post("/setup", async (c) => {
    const body = await readJsonBody<unknown>(c, SETUP_BODY_LIMIT);
    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) {
        throw ApiError.validation(
            "请求体校验失败",
            parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        );
    }

    const email = normalizeEmail(parsed.data.email);
    if (!isPlausibleEmail(email)) {
        throw ApiError.validation("邮箱格式不正确", { field: "email" });
    }

    const strength = checkPasswordStrength(parsed.data.password);
    if (!strength.ok) {
        throw ApiError.validation(strength.message, { field: "password" });
    }

    // 快速失败：已经初始化过就直接拒绝，不必跑一遍 argon2。
    if (isInitialized()) {
        throw new ApiError("ALREADY_INITIALIZED", "系统已初始化，请直接登录");
    }

    // 哈希放在事务外：argon2 需要 ~30ms 且是异步的，不能夹在同步事务里。
    const passwordHash = await hashPassword(parsed.data.password);

    const db = getDb();
    let createdUser: UserRow;

    // BEGIN IMMEDIATE：立刻拿写锁，让"查空 + 插入"成为一个不可分割的临界区。
    // 两个并发 setup 里，后到的那个会在 countUsers() 看到 1，从而抛 409。
    db.exec("BEGIN IMMEDIATE");
    try {
        if (countUsers() > 0) {
            throw new ApiError("ALREADY_INITIALIZED", "系统已初始化，请直接登录");
        }

        createdUser = createUser({
            email,
            passwordHash,
            displayName: parsed.data.displayName?.trim() || email.split("@")[0] || null,
            role: "owner",
        });

        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }

    // 建号成功即登录，省掉一次手动登录。
    issueSession(c, createdUser.id, true);

    console.info(`[setup] 初始化完成 owner=${createdUser.id} ip=${clientIp(c)}`);

    return ok(c, { user: toPublicUser(createdUser) }, 201);
});
