/**
 * 鉴权中间件。
 *
 * 三条规则：
 * 1. 没有会话 → 401 `UNAUTHORIZED`；但若系统**还没初始化**（users 表为空），
 *    返回 403 `SETUP_REQUIRED`，让前端明确跳到 `/setup` 而不是死循环在登录页；
 * 2. 有会话 → 把 `user` / `sessionId` 塞进 `c.var`，下游路由直接取用；
 * 3. 所有受保护路由都必须显式挂 `requireAuth` —— 没有"默认保护"的黑魔法，
 *    这样 grep `requireAuth` 就能审计出全部受保护端点。
 */

import type { Context, MiddlewareHandler } from "hono";

import { isInitialized } from "../db/repos/users";
import { ApiError } from "../http/errors";
import { readSession, type SessionUser } from "./session";

/** 受保护路由的上下文变量。 */
export type AuthVariables = {
    user: SessionUser;
    sessionId: string;
};

/** 已鉴权上下文类型别名（路由里用来标注 handler 的泛型）。 */
export type AuthedContext = Context<{ Variables: AuthVariables }>;

/** 要求已登录。 */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    const session = readSession(c);

    if (!session) {
        // 区分"没初始化"和"没登录"：两者的前端动作完全不同。
        if (!isInitialized()) {
            throw new ApiError("SETUP_REQUIRED");
        }
        throw new ApiError("UNAUTHORIZED");
    }

    c.set("user", session.user);
    c.set("sessionId", session.sessionId);

    await next();
};

/**
 * 从上下文取当前用户（只能在 `requireAuth` 之后调用）。
 *
 * 之所以做成函数而不是直接 `c.var.user`：
 * TS 下 `c.get("user")` 一定有值，但为了防御"忘记挂中间件"这种低级错误，
 * 这里仍然显式判空并抛 INTERNAL —— 宁可 500 也不能让未鉴权请求走进业务逻辑。
 */
export function currentUser(c: AuthedContext): SessionUser {
    const user = c.get("user");
    if (!user) {
        throw new ApiError("INTERNAL", "鉴权上下文缺失（该路由未挂 requireAuth？）");
    }
    return user;
}

/** 当前会话 id（注销 / 审计用）。 */
export function currentSessionId(c: AuthedContext): string {
    const sessionId = c.get("sessionId");
    if (!sessionId) {
        throw new ApiError("INTERNAL", "会话上下文缺失（该路由未挂 requireAuth？）");
    }
    return sessionId;
}
