/**
 * 前端鉴权 API（T02 第 6 条）。
 *
 * 只包四个端点：
 *   GET  /api/setup/status
 *   POST /api/setup
 *   POST /api/auth/login
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *
 * 全部复用 `api-client.ts`（同源相对路径 + 统一信封），
 * 因此不需要处理 CORS、也不用手动带 Cookie（同源默认带）。
 */

import { apiGet, apiPost } from "./api-client";

/** 登录用户（与 server 端 `SessionUser` 对齐）。 */
export type AuthUser = {
    id: string;
    email: string;
    displayName: string | null;
    role: "owner" | "member";
};

/** `GET /api/auth/me` 的响应。 */
export type MePayload = {
    authenticated: boolean;
    user: AuthUser | null;
    /** 系统尚未初始化（users 表为空）→ 前端应跳 `/setup`。 */
    setupRequired: boolean;
    /** 公开注册是否开启（本版固定 false）。 */
    registrationEnabled: boolean;
};

/** `GET /api/setup/status` 的响应。 */
export type SetupStatusPayload = {
    initialized: boolean;
    registrationEnabled: boolean;
};

/** 登录入参。 */
export type LoginInput = {
    email: string;
    password: string;
    /** 记住我（true = 30 天持久 Cookie）。 */
    remember?: boolean;
};

/** 读取当前会话状态（永不 401，失败即视为未登录）。 */
export function fetchMe(): Promise<MePayload> {
    return apiGet<MePayload>("/api/auth/me");
}

/** 初始化状态。 */
export function fetchSetupStatus(): Promise<SetupStatusPayload> {
    return apiGet<SetupStatusPayload>("/api/setup/status");
}

/** 登录。 */
export function login(input: LoginInput): Promise<{ user: AuthUser }> {
    return apiPost<{ user: AuthUser }>("/api/auth/login", {
        email: input.email,
        password: input.password,
        remember: input.remember !== false,
    });
}

/** 注销（服务端即时吊销会话）。 */
export async function logout(): Promise<void> {
    await apiPost<undefined>("/api/auth/logout");
}

/** 初始化首个管理员（仅 users 表为空时可用）。 */
export function createFirstOwner(input: { email: string; password: string; displayName?: string }): Promise<{ user: AuthUser }> {
    return apiPost<{ user: AuthUser }>("/api/setup", input);
}
