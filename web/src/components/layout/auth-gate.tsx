/**
 * AuthGate —— 应用级登录闸门（T02 第 6 条）。
 *
 * 行为矩阵：
 *
 * | status            | 渲染                                   |
 * |-------------------|----------------------------------------|
 * | `loading`         | 居中骨架（**不闪登录页**，避免白屏抖动） |
 * | `authenticated`   | 正常渲染 children                       |
 * | `unauthenticated` | `<Navigate to="/login">`（带回跳地址）  |
 * | `setup`           | `<Navigate to="/setup">`               |
 * | `error`           | 错误卡片 + 重试按钮（**不跳登录页**）   |
 *
 * 关键细节：
 * 1. 只在挂载时探测一次（`resolved` 标记），路由切换不会重复打 `/api/auth/me`；
 * 2. 回跳地址通过 `location.state.from` 传递，登录成功后由登录页消费；
 *    用 `state` 而不是 query 参数，避免 URL 变脏（也避免被当成 open redirect 入口）。
 */

import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuthStore } from "@/stores/use-auth-store";

/** 全屏居中的加载/错误容器。 */
function CenteredPanel({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
    return (
        <div className="flex min-h-screen w-full items-center justify-center bg-background px-6">
            <div className="w-full max-w-sm space-y-3 text-center">
                <h1 className="text-base font-medium text-foreground">{title}</h1>
                {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
                {action ? <div className="pt-2">{action}</div> : null}
            </div>
        </div>
    );
}

export function AuthGate({ children }: { children: ReactNode }) {
    const location = useLocation();
    const status = useAuthStore((state) => state.status);
    const resolved = useAuthStore((state) => state.resolved);
    const error = useAuthStore((state) => state.error);
    const refresh = useAuthStore((state) => state.refresh);

    useEffect(() => {
        if (!resolved) void refresh();
    }, [resolved, refresh]);

    if (status === "loading") {
        return <CenteredPanel title="正在加载…" description="正在确认登录状态" />;
    }

    if (status === "error") {
        return (
            <CenteredPanel
                title="后端服务不可用"
                description={error ?? "请确认 server 容器/进程已启动"}
                action={
                    <button
                        type="button"
                        className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
                        onClick={() => void refresh()}
                    >
                        重试
                    </button>
                }
            />
        );
    }

    if (status === "setup") {
        return <Navigate to="/setup" replace />;
    }

    if (status === "unauthenticated") {
        // 只记 pathname + search：hash 与 state 里的循环引用不该进回跳参数。
        const from = `${location.pathname}${location.search}`;
        return <Navigate to="/login" replace state={{ from }} />;
    }

    return <>{children}</>;
}

export default AuthGate;
