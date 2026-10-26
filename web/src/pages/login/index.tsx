/**
 * 登录页（T02 骨架 —— 真样式在 T04 精修）。
 *
 * 保留完整的可用逻辑，样式只用项目已有的 tailwind 语义 token
 * （`bg-background` / `text-foreground` / `border-border` ...，见 `styles/globals.css:9-41`），
 * 不直接调 antd 组件 —— 免得 T04 换设计语言时还要拆一遍。
 */

import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuthStore } from "@/stores/use-auth-store";

/** 登录页。 */
export default function LoginPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const status = useAuthStore((state) => state.status);
    const submitting = useAuthStore((state) => state.submitting);
    const error = useAuthStore((state) => state.error);
    const login = useAuthStore((state) => state.login);

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [remember, setRemember] = useState(true);

    /** 登录成功后的回跳地址（AuthGate 通过 `location.state.from` 传进来）。 */
    const from = readRedirectTarget(location.state);

    // 已登录用户访问 /login → 直接送走，避免"登录后又看到登录页"的错觉。
    useEffect(() => {
        if (status === "authenticated") navigate(from, { replace: true });
    }, [status, from, navigate]);

    // 系统还没初始化 → 该去 /setup 而不是登录（这里只在竞态下才可能发生）。
    useEffect(() => {
        if (status === "setup") navigate("/setup", { replace: true });
    }, [status, navigate]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const ok = await login({ email, password, remember });
        if (ok) navigate(from, { replace: true });
    }

    return (
        <div className="flex min-h-screen w-full items-center justify-center bg-background px-6">
            <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
                <header className="space-y-1 text-center">
                    <h1 className="text-lg font-semibold text-foreground">登录 Infinite Canvas</h1>
                    <p className="text-sm text-muted-foreground">自托管实例，仅限已创建的账号</p>
                </header>

                <div className="space-y-1">
                    <label htmlFor="email" className="text-sm text-foreground">
                        邮箱
                    </label>
                    <input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="username"
                        required
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                        placeholder="you@example.com"
                    />
                </div>

                <div className="space-y-1">
                    <label htmlFor="password" className="text-sm text-foreground">
                        密码
                    </label>
                    <input
                        id="password"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                        placeholder="••••••••"
                    />
                </div>

                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                    记住我（30 天）
                </label>

                {error ? (
                    <p role="alert" className="rounded-md border border-border bg-accent px-3 py-2 text-sm text-foreground">
                        {error}
                    </p>
                ) : null}

                <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                    {submitting ? "登录中…" : "登录"}
                </button>

                <p className="text-center text-xs text-muted-foreground">
                    没有账号？在服务器上执行 <code className="font-mono">bun run user:create</code> 创建
                </p>
            </form>
        </div>
    );
}

/**
 * 从路由 state 里安全地取出回跳目标。
 *
 * 只接受站内绝对路径（`/` 开头且不是 `//`），
 * 传外部 URL 一律丢弃 —— 否则 `state.from = "https://evil.com"`
 * 就变成了一个 open redirect。
 */
function readRedirectTarget(state: unknown): string {
    if (!state || typeof state !== "object") return "/";
    const from = (state as { from?: unknown }).from;
    if (typeof from !== "string") return "/";
    if (!from.startsWith("/") || from.startsWith("//")) return "/";
    if (from.startsWith("/login") || from.startsWith("/setup")) return "/";
    return from;
}
