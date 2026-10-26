import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { AuthGate } from "@/components/layout/auth-gate";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import SetupPage from "@/pages/setup";
import VideoPage from "@/pages/video";

/**
 * 路由表。
 *
 * T02 变更：整棵应用路由被 `AuthGate` 包住 ——
 * 未登录访问**任何**应用页（含 `/canvas/:id`）都会跳 `/login`，
 * 未初始化则跳 `/setup`。这两个页面本身**不在**闸门内，否则会死循环。
 *
 * 注意 `/canvas/:id` 对应的组件 `pages/canvas/project.tsx` 是上游 198KB 大文件，
 * T02 **不改动它**（硬约束），因此"打开画布时从后端拉 doc"的接线放在后续任务。
 */
export const router = createBrowserRouter([
    // 闸门之外的页面
    { path: "/login", element: <LoginPage /> },
    { path: "/setup", element: <SetupPage /> },

    // 闸门之内的应用
    {
        element: (
            <AuthGate>
                <UserLayout>
                    <AnalyticsTracker />
                    <Outlet />
                </UserLayout>
            </AuthGate>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
        ],
    },

    { path: "*", element: <NotFound /> },
]);
