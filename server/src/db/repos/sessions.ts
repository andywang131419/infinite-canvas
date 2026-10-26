/**
 * sessions 仓储 —— 不透明 token 会话。
 *
 * 安全要点：
 * - 数据库**只存 token 的 sha256**（`sessions.token_hash`），
 *   原文只出现在 Set-Cookie 里。这样即使 `app.db` 泄漏（例如备份文件被拖走），
 *   攻击者也无法直接拿去冒充登录。
 * - 校验时同时判 `revoked_at IS NULL` 与 `expires_at > now`，
 *   登出后**立即**失效（不需要等 TTL）。
 */

import { getDb } from "../client";
import { SQL_INSERT_SESSION, SQL_PURGE_SESSIONS, SQL_REVOKE_SESSION, SQL_SELECT_SESSION_WITH_USER, SQL_TOUCH_SESSION } from "./canvas-sql";
import type { UserRole } from "./users";

/** 会话校验结果（JOIN 出来的扁平行）。 */
export type SessionWithUserRow = {
    session_id: string;
    user_id: string;
    expires_at: string;
    revoked_at: string | null;
    email: string;
    display_name: string | null;
    role: UserRole;
    is_disabled: number;
};

/** 建会话入参。 */
export type CreateSessionInput = {
    userId: string;
    /** token 的 sha256（**不是**原文）。 */
    tokenHash: string;
    deviceLabel?: string | null;
    userAgent?: string | null;
    ip?: string | null;
    remember?: boolean;
    /** 过期时间，ISO8601 UTC。 */
    expiresAt: string;
};

/** 建会话，返回新会话 id。 */
export function createSession(input: CreateSessionInput): string {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    getDb()
        .query(SQL_INSERT_SESSION)
        .run(
            id,
            input.userId,
            input.tokenHash,
            input.deviceLabel ?? null,
            input.userAgent ?? null,
            input.ip ?? null,
            input.remember === false ? 0 : 1,
            now,
            now,
            input.expiresAt,
        );

    return id;
}

/**
 * 按 token 哈希校验会话。
 *
 * @param tokenHash sha256 十六进制。
 * @param now 当前时间（便于测试注入）。
 * @returns 命中且未过期未吊销时返回行，否则 `null`。
 */
export function findSessionWithUser(tokenHash: string, now: string = new Date().toISOString()): SessionWithUserRow | null {
    return (getDb().query(SQL_SELECT_SESSION_WITH_USER).get(tokenHash, now) as SessionWithUserRow | null) ?? null;
}

/**
 * 吊销单个会话（logout / 改密码）。
 *
 * @returns 实际更新行数；0 表示该 token 早已失效（幂等，不报错）。
 */
export function revokeSession(tokenHash: string, at: string = new Date().toISOString()): number {
    const result = getDb().query(SQL_REVOKE_SESSION).run(at, tokenHash);
    return Number(result.changes);
}

/** 刷新 last_seen_at（由中间件节流调用，避免每个请求都写一次）。 */
export function touchSession(sessionId: string, at: string = new Date().toISOString()): void {
    getDb().query(SQL_TOUCH_SESSION).run(at, sessionId);
}

/** 清理过期与已吊销的会话记录（启动时 / 定时跑，防止表无限膨胀）。 */
export function purgeSessions(at: string = new Date().toISOString()): number {
    const result = getDb().query(SQL_PURGE_SESSIONS).run(at, at);
    return Number(result.changes);
}
