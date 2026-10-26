/**
 * 初始化页（T02 第 2 条的 UI 入口 —— 骨架，真样式 T04 精修）。
 *
 * 只有在 `users` 表为空时才有意义：
 * - store 的 `status === "setup"` → 正常展示表单；
 * - 若已被别人初始化（`ALREADY_INITIALIZED` 或 status 变 `unauthenticated`）
 *   → 展示"已完成初始化"提示并给去登录页的链接，而不是让用户对着表单反复提交。
 *
 * 这个页面**不绕过任何服务端校验**：`POST /api/setup` 自己会用
 * `BEGIN IMMEDIATE` + `countUsers()` 再确认一次（见 server/src/routes/setup.ts）。
 */

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { useAuthStore } from "@/stores/use-auth-store";

/** 初始化页。 */
export default function SetupPage() {
    const navigate = useNavigate();

    const status = useAuthStore((state) => state.status);
    const submitting = useAuthStore((state) => state.submitting);
    const error = useAuthStore((state) => state.error);
    const setup = useAuthStore((state) => state.setup);

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [localError, setLocalError] = useState<string | null>(null);

    // 已登录（初始化成功或本来就有会话）→ 进应用。
    useEffect(() => {
        if (status === "authenticated") navigate("/", { replace: true });
    }, [status, navigate]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setLocalError(null);

        if (password !== confirm) {
            setLocalError("两次输入的密码不一致");
            return;
        }

        const ok = await setup({ email, password, displayName: displayName.trim() || undefined });
        if (ok) navigate("/", { replace: true });
    }

    const alreadyInitialized = status === "unauthenticated";
    const message = localError ?? error;

    if (alreadyInitialized) {
        return (
            <div className="flex min-h-screen w-full items-center justify-center bg-background px-6">
                <div className="w-full max-w-sm space-y-3 text-center">
                    <h1 className="text-lg font-semibold text-foreground">系统已完成初始化</h1>
                    <p className="text-sm text-muted-foreground">本实例已经有管理员账号，请直接登录。</p>
                    <button
                        type="button"
                        onClick={() => navigate("/login", { replace: true })}
                        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                    >
                        去登录
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen w-full items-center justify-center bg-background px-6">
            <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
                <header className="space-y-1 text-center">
                    <h1 className="text-lg font-semibold text-foreground">初始化 Infinite Canvas</h1>
                    <p className="text-sm text-muted-foreground">创建第一个管理员账号，此入口在初始化后自动关闭</p>
                </header>

                <div className="space-y-1">
                    <label htmlFor="display-name" className="text-sm text-foreground">
                        显示名（可选）
                    </label>
                    <input
                        id="display-name"
                        type="text"
                        maxLength={64}
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                        placeholder="管理员"
                    />
                </div>

                <div className="space-y-1">
                    <label htmlFor="setup-email" className="text-sm text-foreground">
                        邮箱
                    </label>
                    <input
                        id="setup-email"
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
                    <label htmlFor="setup-password" className="text-sm text-foreground">
                        密码（至少 8 位）
                    </label>
                    <input
                        id="setup-password"
                        type="password"
                        autoComplete="new-password"
                        required
                        minLength={8}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                        placeholder="••••••••"
                    />
                </div>

                <div className="space-y-1">
                    <label htmlFor="setup-confirm" className="text-sm text-foreground">
                        确认密码
                    </label>
                    <input
                        id="setup-confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                        minLength={8}
                        value={confirm}
                        onChange={(event) => setConfirm(event.target.value)}
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                        placeholder="••••••••"
                    />
                </div>

                {message ? (
                    <p role="alert" className="rounded-md border border-border bg-accent px-3 py-2 text-sm text-foreground">
                        {message}
                    </p>
                ) : null}

                <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                    {submitting ? "创建中…" : "创建管理员并进入"}
                </button>
            </form>
        </div>
    );
}
