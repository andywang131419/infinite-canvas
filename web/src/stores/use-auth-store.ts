/**
 * 鉴权 store（T02 骨架；真样式/成员管理在 T04）。
 *
 * 状态机（`status`）：
 *   "loading"          —— 首次探测中（AuthGate 显示骨架屏，不闪登录页）
 *   "authenticated"    —— 已登录，`user` 就绪
 *   "unauthenticated"  —— 未登录且系统已初始化 → 跳 `/login`
 *   "setup"            —— 系统未初始化 → 跳 `/setup`
 *   "error"            —— 后端不可达（断网 / server 未启动），`error` 有文案
 *
 * 为什么用 store 而不是 React Context：
 * 之后画布页、顶栏、设置页都要读 `user`，Context 会造成大面积重渲染；
 * zustand 的选择器订阅不会有这个问题，且与项目其它 store 保持一致。
 */

import { create } from "zustand";

import { createFirstOwner, fetchMe, login as loginRequest, logout as logoutRequest, type AuthUser } from "@/lib/auth-api";
import { ApiError } from "@/lib/api-client";

/** 鉴权状态。 */
export type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "setup" | "error";

/** store 形状。 */
type AuthStore = {
    status: AuthStatus;
    user: AuthUser | null;
    /** 最近一次失败的人话文案（登录失败 / 网络不可达）。 */
    error: string | null;
    /** 正在提交（登录/初始化按钮的 loading 态）。 */
    submitting: boolean;
    /** 是否已完成过一次探测（避免重复探测）。 */
    resolved: boolean;

    /** 探活：读 `/api/auth/me` 并落到对应状态。 */
    refresh: () => Promise<void>;
    /** 登录。成功返回 true。 */
    login: (input: { email: string; password: string; remember?: boolean }) => Promise<boolean>;
    /** 初始化首个管理员。成功返回 true。 */
    setup: (input: { email: string; password: string; displayName?: string }) => Promise<boolean>;
    /** 注销并回到未登录态。 */
    logout: () => Promise<void>;
    /** 清掉错误提示。 */
    clearError: () => void;
};

/** 把异常翻译成能直接展示的中文文案。 */
function toMessage(error: unknown): string {
    if (error instanceof ApiError) {
        if (error.code === "NETWORK_ERROR") return "无法连接后端服务，请确认 server 已启动";
        return error.message;
    }
    return error instanceof Error ? error.message : "未知错误";
}

export const useAuthStore = create<AuthStore>()((set, get) => ({
    status: "loading",
    user: null,
    error: null,
    submitting: false,
    resolved: false,

    refresh: async () => {
        try {
            const payload = await fetchMe();

            if (payload.authenticated && payload.user) {
                set({ status: "authenticated", user: payload.user, error: null, resolved: true });
                return;
            }

            set({
                status: payload.setupRequired ? "setup" : "unauthenticated",
                user: null,
                error: null,
                resolved: true,
            });
        } catch (error) {
            // 后端不可达：不要把人踢到登录页，否则用户会以为是密码错了。
            set({ status: "error", user: null, error: toMessage(error), resolved: true });
        }
    },

    login: async (input) => {
        set({ submitting: true, error: null });
        try {
            const result = await loginRequest(input);
            set({ status: "authenticated", user: result.user, submitting: false, resolved: true });
            return true;
        } catch (error) {
            set({ submitting: false, error: toMessage(error) });
            return false;
        }
    },

    setup: async (input) => {
        set({ submitting: true, error: null });
        try {
            const result = await createFirstOwner(input);
            set({ status: "authenticated", user: result.user, submitting: false, resolved: true });
            return true;
        } catch (error) {
            const message = toMessage(error);
            // 已被别人抢先初始化 → 引导去登录页，而不是卡在初始化页。
            if (error instanceof ApiError && error.code === "ALREADY_INITIALIZED") {
                set({ submitting: false, error: message, status: "unauthenticated" });
                return false;
            }
            set({ submitting: false, error: message });
            return false;
        }
    },

    logout: async () => {
        try {
            await logoutRequest();
        } catch {
            // 注销失败也要把本地状态清干净：服务端会话过期/TTL 到期都属于正常情况。
        }
        set({ status: "unauthenticated", user: null, error: null });
    },

    clearError: () => {
        if (get().error !== null) set({ error: null });
    },
}));

/** 便捷选择器：当前是否已登录。 */
export function useIsAuthenticated(): boolean {
    return useAuthStore((state) => state.status === "authenticated");
}
