// Runtime configuration access layer.
// Priority: window.__RUNTIME_CONFIG__ (injected by the container entrypoint) > build-time VITE_ variables > defaults.
// This supports both configuring the same image with docker run -e and injecting values during custom builds.
//
// Each analytics provider has its own variable; configured providers are enabled independently and all are disabled by default.
// Only GA4 and Baidu are supported. Both accept IDs only, and script URLs are assembled in code without arbitrary scripts or inline JavaScript.

type RuntimeConfig = {
    ANALYTICS_GA4_ID?: string; // GA4 measurement ID (G-XXXX)
    ANALYTICS_BAIDU_ID?: string; // Baidu Analytics site ID
    /**
     * 后端 API 根地址。留空 = 同域（推荐，生产由 Caddy 把 /api/* 分流到 server）。
     * 仅在把 server 拆到独立子域时才需要填，例如 https://api.example.com。
     * 由于是构建后由容器写入 config.js，改地址无需重新构建镜像。
     */
    API_BASE_URL?: string;
};

declare global {
    interface Window {
        __RUNTIME_CONFIG__?: RuntimeConfig;
    }
}

const runtime: RuntimeConfig = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, buildTime: string | undefined, fallback = ""): string {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof buildTime === "string" && buildTime.trim()) return buildTime.trim();
    return fallback;
}

export const ANALYTICS_GA4_ID = read("ANALYTICS_GA4_ID", import.meta.env.VITE_ANALYTICS_GA4_ID);
export const ANALYTICS_BAIDU_ID = read("ANALYTICS_BAIDU_ID", import.meta.env.VITE_ANALYTICS_BAIDU_ID);

/**
 * 后端 API 根地址。
 *
 * 默认空字符串 = 同域，前端所有请求走 `/api/...` 相对路径：
 * - 开发期：vite.config.ts 的 `server.proxy["/api"]` 转发到 127.0.0.1:8787
 * - 生产期：Caddy 把 `/api/*` 分流到 server:8787
 *
 * 两种情况下浏览器看到的都是同源请求 → 无 CORS、无预检、Cookie 天然 SameSite=Lax。
 * 末尾斜杠统一去掉，避免拼出 `//api/health`。
 */
export const API_BASE_URL = read("API_BASE_URL", import.meta.env.VITE_API_BASE_URL).replace(/\/+$/, "");
