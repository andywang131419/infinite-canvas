/**
 * `/api/auth/*` —— 登录 / 注销 / 当前用户。
 *
 * 安全细节（逐条对应 T02 第 1 条验收）：
 * - 密码用 argon2id 校验（`Bun.password`），库里只有哈希；
 * - 会话是不透明 token，DB 存 sha256，Cookie 是 HttpOnly；
 * - `POST /auth/logout` 走 `UPDATE sessions SET revoked_at=?`，**即时**失效；
 * - 登录限流按 `IP + 账号` 5 次/分，超限返回 429 + `Retry-After`；
 * - 「用户不存在」与「密码错误」返回**同一个**错误码与文案，防账号枚举。
 */

import { Hono } from "hono";
import { z } from "zod";

import { isInitialized, findUserByEmail, normalizeEmail, toPublicUser } from "../db/repos/users";
import { verifyPassword } from "../auth/password";
import { consumeLoginAttempt, resetLoginAttempts } from "../auth/rate-limit";
import { issueSession, readSession, revokeCurrentSession, type SessionUser } from "../auth/session";
import { getEnv } from "../env";
import { ApiError } from "../http/errors";
import { clientIp, clientUserAgent, readJsonBody } from "../http/request";
import { ok } from "../http/respond";

export const authRoutes = new Hono();

/** 登录请求体上限（邮箱 + 密码，64KB 绰绰有余）。 */
const LOGIN_BODY_LIMIT = 64 * 1024;

/**
 * 用于"用户不存在"时也跑一次 KDF 的哑哈希。
 *
 * 目的：让"账号不存在"与"密码错误"的响应耗时接近，避免通过**响应时间**
 * 枚举出哪些邮箱注册过。这不是密码，只是一段格式合法的 argon2id 串。
 */
const DUMMY_ARGON2_HASH = "$argon2id$v=19$m=19456,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY";

/** 登录请求体。 */
const loginSchema = z.object({
    email: z.string().min(1, "请输入邮箱").max(254),
    password: z.string().min(1, "请输入密码").max(256),
    /** 记住我：true 时 Cookie 带 Max-Age（30 天），false 则是会话 Cookie。 */
    remember: z.boolean().optional(),
});

/**
 * 登录。
 *
 * @returns `{ user }` 并写入 `Set-Cookie: ic_session=...`
 */
authRoutes.post("/auth/login", async (c) => {
    const ip = clientIp(c);
    const body = await readJsonBody<unknown>(c, LOGIN_BODY_LIMIT);

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
        throw ApiError.validation(
            "请求体校验失败",
            parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        );
    }

    const email = normalizeEmail(parsed.data.email);

    // ---- 限流：先判再校验密码（避免白跑一次 argon2）----
    const limit = consumeLoginAttempt(ip, email);
    if (!limit.allowed) {
        c.header("Retry-After", String(limit.retryAfterSeconds));
        throw new ApiError("RATE_LIMITED", `登录尝试过于频繁，请 ${limit.retryAfterSeconds} 秒后重试`, {
            retryAfterSeconds: limit.retryAfterSeconds,
            limit: limit.limit,
        });
    }

    // ---- 校验凭据 ----
    const user = findUserByEmail(email);
    const passwordOk = await verifyPassword(parsed.data.password, user?.password_hash ?? DUMMY_ARGON2_HASH);

    if (!user || !passwordOk || user.is_disabled === 1) {
        // 三种情况统一返回同一个错误：不泄露"这个邮箱存在/被禁用"。
        throw new ApiError("INVALID_CREDENTIALS");
    }

    // 登录成功：清掉该组合的失败计数，避免"踩过 4 次后正常用也要被卡"。
    resetLoginAttempts(ip, email);

    issueSession(c, user.id, parsed.data.remember !== false);

    console.info(`[auth] 登录成功 user=${user.id} ip=${ip} ua=${clientUserAgent(c) ?? "-"}`);

    return ok(c, { user: toPublicUser(user) });
});

/**
 * 注销 —— 即时吊销当前会话并清 Cookie。
 *
 * 幂等：没登录时也返回 204（前端可以直接调，不用先判断）。
 */
authRoutes.post("/auth/logout", (c) => {
    const revoked = revokeCurrentSession(c);
    if (!revoked) {
        console.info("[auth] 注销请求但无有效会话（幂等返回 204）");
    }
    return c.body(null, 204);
});

/**
 * 当前登录用户。
 *
 * 刻意**不返回 401**，而是 200 + `user: null`：
 * 这是前端启动时的探针，用它决定"渲染登录页还是应用"。
 * 用 401 会让浏览器控制台在每次冷启动时刷一条红色错误，纯噪音。
 */
authRoutes.get("/auth/me", (c) => {
    const session = readSession(c);
    const initialized = isInitialized();

    if (!session) {
        return ok(c, {
            authenticated: false,
            user: null,
            setupRequired: !initialized,
            registrationEnabled: getEnv().ALLOW_REGISTRATION,
        });
    }

    return ok(c, {
        authenticated: true,
        user: toSessionUserDto(session.user),
        setupRequired: false,
        registrationEnabled: getEnv().ALLOW_REGISTRATION,
    });
});

/** 会话用户 → 对外 DTO（与 `PublicUser` 字段一致，但补充了前端需要的 `displayName`）。 */
function toSessionUserDto(user: SessionUser) {
    return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
    };
}
