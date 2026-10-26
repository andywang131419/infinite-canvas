/**
 * users 仓储。
 *
 * 职责边界（ARCH Rev2 §R2.3）：
 * - 只做 SQL ↔ 对象映射，**不含**业务规则（密码强度、锁账号等放在 auth/ 层）；
 * - 所有 DB 访问都通过 `getDb()`，不自己建连接。
 */

import { getDb } from "../client";
import { SQL_COUNT_USERS, SQL_INSERT_USER, SQL_SELECT_USER_BY_EMAIL, SQL_SELECT_USER_BY_ID, SQL_TOUCH_USER_LOGIN } from "./canvas-sql";

/** 用户角色（对应 `users.role` 的 CHECK 约束）。 */
export type UserRole = "owner" | "member";

/** 数据库行。 */
export type UserRow = {
    id: string;
    email: string;
    password_hash: string;
    display_name: string | null;
    role: UserRole;
    is_disabled: number;
    created_at: string;
    updated_at: string;
    last_login_at: string | null;
};

/** 可以安全返回给前端的用户信息（**绝不包含** password_hash）。 */
export type PublicUser = {
    id: string;
    email: string;
    displayName: string | null;
    role: UserRole;
    createdAt: string;
    lastLoginAt: string | null;
};

/** 行 → 对外结构。 */
export function toPublicUser(row: UserRow): PublicUser {
    return {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
    };
}

/** 用户总数 —— 判断"要不要走 /api/setup"。 */
export function countUsers(): number {
    const row = getDb().query(SQL_COUNT_USERS).get() as { total: number } | null;
    return row?.total ?? 0;
}

/** 系统是否已初始化（只要有一个用户就算）。 */
export function isInitialized(): boolean {
    return countUsers() > 0;
}

/**
 * 按邮箱查用户。
 *
 * 邮箱一律 `trim().toLowerCase()` 后存储与查询 —— 见 {@link normalizeEmail}。
 * SQLite 的 `TEXT` 比较是大小写敏感的，不自建规范化就会出现
 * "Admin@x.com 与 admin@x.com 是两个账号"。
 */
export function findUserByEmail(email: string): UserRow | null {
    return (getDb().query(SQL_SELECT_USER_BY_EMAIL).get(normalizeEmail(email)) as UserRow | null) ?? null;
}

/** 按 id 查用户。 */
export function findUserById(id: string): UserRow | null {
    return (getDb().query(SQL_SELECT_USER_BY_ID).get(id) as UserRow | null) ?? null;
}

/** 建用户入参。 */
export type CreateUserInput = {
    email: string;
    /** 已计算好的哈希（argon2id），本层不碰明文密码。 */
    passwordHash: string;
    displayName?: string | null;
    role?: UserRole;
};

/**
 * 建用户。
 *
 * @throws 当邮箱已存在时抛出（由 `ux_users_email` 唯一索引保证）。
 */
export function createUser(input: CreateUserInput): UserRow {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const email = normalizeEmail(input.email);

    getDb()
        .query(SQL_INSERT_USER)
        .run(id, email, input.passwordHash, input.displayName ?? null, input.role ?? "owner", now, now);

    const created = findUserById(id);
    if (!created) throw new Error("用户创建后无法读回，数据库状态异常");
    return created;
}

/** 更新最后登录时间。 */
export function touchUserLogin(id: string, at: string = new Date().toISOString()): void {
    getDb().query(SQL_TOUCH_USER_LOGIN).run(at, at, id);
}

/**
 * 邮箱规范化：去空白 + 全小写。
 *
 * 只做这两件事，**不**尝试 RFC 5322 全套解析 —— 过度解析反而会把
 * `a+b@x.com` 这类合法地址改坏。
 */
export function normalizeEmail(email: string): string {
    return (email ?? "").trim().toLowerCase();
}

/** 邮箱是否形如合法地址（保守校验：有且仅有一个 @，有域名点号）。 */
export function isPlausibleEmail(email: string): boolean {
    const value = normalizeEmail(email);
    if (value.length < 5 || value.length > 254) return false;
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}
