/**
 * 会话签发 / 校验 / 吊销 + Cookie 读写。
 *
 * Cookie 规格（T02 第 1 条）：
 *   `Set-Cookie: ic_session=<43 字符 base64url>; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`
 *
 * 四个属性都不能省：
 * - `HttpOnly`：JS 读不到，XSS 也偷不走会话；
 * - `SameSite=Lax`：挡住跨站表单 POST（CSRF 主入口），同时不影响同站 `<img>`/`<video>` 带 Cookie
 *   读取 `/api/assets/raw`（Lax 允许导航与同站子资源）；
 * - `Secure`：生产必须开（`COOKIE_SECURE=true`，Caddy 提供 HTTPS）；
 *   本地 `http://localhost` 调试时设为 false，否则浏览器不存 Cookie；
 * - `Path=/`：整站有效。
 *
 * 30 天 TTL 由 `SESSION_TTL_DAYS` 控制；`remember=false` 时不写 `Max-Age`
 * （浏览器会话 Cookie，关窗即失效，但服务端记录仍在，直到 TTL 到期）。
 */

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";

import { createSession, findSessionWithUser, revokeSession, touchSession } from "../db/repos/sessions";
import { touchUserLogin, type UserRole } from "../db/repos/users";
import { getEnv } from "../env";
import { clientIp } from "../http/request";
import { createSessionToken, hashSessionToken, looksLikeSessionToken } from "./tokens";

/** 会话中的用户最小信息（挂到 `c.var.user`）。 */
export type SessionUser = {
    id: string;
    email: string;
    displayName: string | null;
    role: UserRole;
};

/** 当前请求命中的会话。 */
export type ActiveSession = {
    sessionId: string;
    user: SessionUser;
};

/** `last_seen_at` 写库节流间隔：同一会话 5 分钟内只更新一次。 */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/** sessionId → 上次写库时间（内存态，进程重启后重新开始，无副作用）。 */
const lastTouchedAt = new Map<string, number>();

/** 会话 TTL（秒）。 */
export function sessionTtlSeconds(): number {
    return getEnv().SESSION_TTL_DAYS * 24 * 60 * 60;
}

/**
 * 为新登录签发会话：生成 token → 只把 sha256 写库 → 把原文塞进 Cookie。
 *
 * @param c Hono 上下文（用于写 Cookie）。
 * @param userId 用户 id。
 * @param remember 是否"记住我"（决定是否写 `Max-Age`）。
 * @returns 会话 id 与 token（token 仅此一次可见，调用方不要记日志）。
 */
export function issueSession(c: Context, userId: string, remember: boolean): { sessionId: string; token: string } {
    const env = getEnv();
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    const ttlSeconds = sessionTtlSeconds();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const sessionId = createSession({
        userId,
        tokenHash,
        userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
        ip: clientIp(c),
        remember,
        expiresAt,
    });

    const options: CookieOptions = {
        path: "/",
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: "Lax",
        ...(remember ? { maxAge: ttlSeconds } : {}),
    };
    setCookie(c, env.SESSION_COOKIE_NAME, token, options);

    touchUserLogin(userId);

    return { sessionId, token };
}

/**
 * 解析当前请求的会话。
 *
 * 一次 JOIN 同时完成三件事：token 校验、过期校验、吊销校验。
 *
 * @returns 命中返回 `{ sessionId, user }`，否则 `null`（**不抛错**，
 *          由中间件决定抛 401 还是放行）。
 */
export function readSession(c: Context): ActiveSession | null {
    const env = getEnv();
    const token = getCookie(c, env.SESSION_COOKIE_NAME);
    if (!looksLikeSessionToken(token)) return null;

    const row = findSessionWithUser(hashSessionToken(token));
    if (!row) return null;

    // 账号被禁用 → 视为无会话（比"登录后再 403"更安全：直接不给会话）。
    if (row.is_disabled === 1) return null;

    touchSessionThrottled(row.session_id);

    return {
        sessionId: row.session_id,
        user: {
            id: row.user_id,
            email: row.email,
            displayName: row.display_name,
            role: row.role,
        },
    };
}

/** 节流更新 `last_seen_at`（避免每个请求一次写事务，WAL 下也是不必要的开销）。 */
function touchSessionThrottled(sessionId: string): void {
    const now = Date.now();
    const previous = lastTouchedAt.get(sessionId) ?? 0;
    if (now - previous < TOUCH_INTERVAL_MS) return;

    lastTouchedAt.set(sessionId, now);
    touchSession(sessionId, new Date(now).toISOString());
}

/**
 * 吊销当前请求的会话并清 Cookie。
 *
 * 关键点：`UPDATE sessions SET revoked_at = ?` 是**即时**生效的 ——
 * 下一次请求的 JOIN 就会因为 `revoked_at IS NULL` 不成立而查不到会话。
 * 不依赖 JWT 那种"等过期"的妥协。
 *
 * @returns 是否真的吊销了一条会话（false = 本来就没登录）。
 */
export function revokeCurrentSession(c: Context): boolean {
    const env = getEnv();
    const token = getCookie(c, env.SESSION_COOKIE_NAME);
    if (!looksLikeSessionToken(token)) {
        clearSessionCookie(c);
        return false;
    }

    const tokenHash = hashSessionToken(token);
    // 先查一次以拿到 sessionId，才能同步清掉节流表里的记录（否则 map 会缓慢泄漏）。
    const row = findSessionWithUser(tokenHash);
    const changed = revokeSession(tokenHash) > 0;
    if (row) lastTouchedAt.delete(row.session_id);
    clearSessionCookie(c);
    return changed;
}

/** 清掉 Cookie（注销 / 会话失效时调用）。 */
export function clearSessionCookie(c: Context): void {
    const env = getEnv();
    deleteCookie(c, env.SESSION_COOKIE_NAME, {
        path: "/",
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: "Lax",
    });
}

/** 仅供测试：清空节流表。 */
export function resetSessionTouchCache(): void {
    lastTouchedAt.clear();
}
