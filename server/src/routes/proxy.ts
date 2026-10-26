/**
 * `/api/proxy` —— Tier2 直通代理（画布助手的流式问答就走这条）。
 *
 * 存在理由：浏览器的 `fetch` 受同源策略限制，第三方模型接口大多不回 CORS 头，
 * 直接前端调用会失败。让服务端代发一次请求是最小成本的解法 ——
 * 但一旦有了"服务端代发任意 URL"的能力，SSRF 就是必答题（见 `proxy/guard.ts`）。
 *
 * 安全设计（按重要性排序）：
 * 1. **白名单为主闸**：目标主机必须属于「已启用渠道的 baseUrl 主机」或
 *    `UPSTREAM_HOST_ALLOWLIST`；否则 403。
 * 2. **不接受客户端凭据**：`authorization` / `cookie` / `host` 一律丢弃；
 *    密钥由服务端从 channels 表解密后注入（`channelId` 或按主机名自动匹配）。
 * 3. **字面量 + DNS 双重内网拦截**：`169.254.169.254`、`127.0.0.1`、
 *    `10/8`、`::1` 等直接 403。
 * 4. **不限流但限体积**：请求体 4MB 上限（够放多轮对话，挡得住压缩炸弹）。
 *
 * 流式处理：上游是 `text/event-stream` 时**不缓冲**，并注入 `: keep-alive` 心跳
 * —— 对应 T01 `idleTimeout: 255` 的约束（见 `proxy/sse.ts` 顶部说明）。
 */

import { Hono } from "hono";
import { z } from "zod";

import { currentUser, requireAuth, type AuthVariables } from "../auth/middleware";
import { getEnv } from "../env";
import { ApiError } from "../http/errors";
import { readJsonBody } from "../http/request";
import { ok } from "../http/respond";
import { checkTarget, normalizeHost, resolveAndCheckHost } from "../proxy/guard";
import { sseHeaders, withHeartbeat } from "../proxy/sse";
import { findChannelForHost, resolveChannelSecret, upstreamHostAllowlist } from "../services/channel-service";

export const proxyRoutes = new Hono<{ Variables: AuthVariables }>();

proxyRoutes.use("*", requireAuth);

/** 请求体上限（多轮对话 + 参考图 base64 之外的文本，4MB 足够）。 */
const PROXY_BODY_LIMIT = 4 * 1024 * 1024;

/**
 * 上游总超时。
 *
 * 取 15 分钟：与 `deploy/Caddyfile` 的 `read_timeout 15m` 对齐，
 * 再长也没有意义 —— 反代会先断开。
 */
const PROXY_TIMEOUT_MS = 15 * 60_000;

/** 允许客户端透传的请求头（其余一律丢弃）。 */
const FORWARDABLE_HEADERS = new Set(["content-type", "accept", "accept-language", "user-agent"]);

/** 请求体校验。 */
const proxySchema = z.object({
    /** 绝对 URL（必须带协议）。 */
    url: z.string().min(1).max(2048),
    method: z.enum(["GET", "POST"]).optional(),
    /** 可选：显式指定用哪个渠道的密钥。省略时按主机名匹配。 */
    channelId: z.string().min(1).max(64).optional(),
    /** 透传的请求头（只接受白名单内的键）。 */
    headers: z.record(z.string(), z.string()).optional(),
    /** JSON body（对象/数组）；字符串会被原样当 JSON 文本发出去。 */
    body: z.unknown().optional(),
});

/**
 * 直通代理。
 *
 * 成功时**原样**返回上游状态码与响应体（包括 4xx/5xx）——
 * 代理不应该替客户端"美化"上游错误，否则前端永远看不到真实原因。
 * 只有"连不上上游"才由本服务生成 502。
 */
proxyRoutes.post("/proxy", async (c) => {
    const user = currentUser(c);
    const raw = await readJsonBody<unknown>(c, PROXY_BODY_LIMIT);

    const parsed = proxySchema.safeParse(raw);
    if (!parsed.success) {
        throw ApiError.validation(
            "请求体校验失败",
            parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        );
    }

    const input = parsed.data;
    const allowlist = buildAllowlist(user.id);

    // ---- 闸门 1/2：协议 + 字面量内网 + 白名单（纯函数，可单测）----
    const target = checkTarget(input.url, allowlist);
    if (!target.ok) {
        throw new ApiError("FORBIDDEN", `代理目标被拒绝：${target.reason}`, { url: redactUrl(input.url) });
    }

    // ---- 闸门 3：DNS 解析后再次确认不是内网 ----
    const hostCheck = await resolveAndCheckHost(target.url.hostname);
    if (!hostCheck.ok) {
        throw new ApiError("FORBIDDEN", `代理目标被拒绝：${hostCheck.reason}`, { host: normalizeHost(target.url.hostname) });
    }

    // ---- 凭据注入（只在这里，且只进 headers，不进日志）----
    const headers = new Headers();
    for (const [key, value] of Object.entries(input.headers ?? {})) {
        if (FORWARDABLE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    }
    headers.set("accept", headers.get("accept") ?? "*/*");

    injectUpstreamAuth(user.id, target.url.hostname, input.channelId ?? null, headers);

    // ---- 发请求 ----
    const method = input.method ?? (input.body === undefined ? "GET" : "POST");
    const body = method === "GET" ? undefined : serializeBody(input.body, headers);

    const controller = new AbortController();
    // 不 unref：这个定时器在"正在等上游"期间就是进程唯一的活动来源之一，
    // unref 会让进程在上游还没返回时提前退出（await 永远不落地）。
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

    let upstream: Response;
    try {
        upstream = await fetch(target.url.toString(), {
            method,
            headers,
            body,
            signal: controller.signal,
            // 重定向不跟随：跟随会把白名单校验绕过去（跳到内网也照样被打通）。
            redirect: "manual",
        });
    } catch (error) {
        clearTimeout(timer);
        const message = error instanceof Error && error.name === "AbortError" ? "上游请求超时" : "无法连接上游";
        throw new ApiError("PROVIDER_UPSTREAM_ERROR", `${message}（${normalizeHost(target.url.hostname)}）`);
    }

    const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
    const isStream = contentType.includes("text/event-stream");

    if (isStream && upstream.body) {
        // 流式：清掉超时定时器（流的生命周期由客户端控制），改为心跳保活。
        clearTimeout(timer);
        return new Response(withHeartbeat(upstream.body), {
            status: upstream.status,
            headers: { ...sseHeaders(), ...passthroughHeaders(upstream) },
        });
    }

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    clearTimeout(timer);

    return new Response(bytes, {
        status: upstream.status,
        headers: passthroughHeaders(upstream),
    });
});

/** 代理自身的可达性探针（供前端"测试代理"用，不需要渠道配置）。 */
proxyRoutes.get("/proxy", (c) => {
    const user = currentUser(c);
    const allowlist = buildAllowlist(user.id);
    return ok(c, {
        proxy: "infinite-canvas-server",
        version: getEnv().APP_VERSION,
        allowlist: [...allowlist].sort(),
    });
});

/**
 * 组装白名单：启用渠道的 baseUrl 主机 ∪ `UPSTREAM_HOST_ALLOWLIST`。
 *
 * 停用渠道等于"关掉这条出站路径"，所以只取 enabled。
 */
function buildAllowlist(ownerId: string): Set<string> {
    const hosts = upstreamHostAllowlist(ownerId);
    for (const host of getEnv().UPSTREAM_HOST_ALLOWLIST) hosts.add(host);
    return hosts;
}

/**
 * 注入上游鉴权头。
 *
 * 顺序：显式 `channelId` → 按主机名匹配已启用渠道 → 不注入（匿名上游，例如自建网关）。
 *
 * 注意：这里绝不把密钥写进返回值/日志，只在 `Headers` 对象里活一次。
 */
function injectUpstreamAuth(ownerId: string, hostname: string, channelId: string | null, headers: Headers): void {
    const channel = channelId ? findChannelForHost(ownerId, hostname, channelId) : findChannelForHost(ownerId, hostname);
    if (!channel) return;

    const { apiKey } = resolveChannelSecret(channel.id);
    if (channel.api_format === "gemini") {
        headers.set("x-goog-api-key", apiKey);
    } else {
        headers.set("authorization", `Bearer ${apiKey}`);
    }
}

/**
 * 序列化请求体：对象 → JSON 字符串；字符串 → 原样。
 *
 * 返回类型刻意是 `string | undefined`（而不是 `BodyInit`）：
 * 本项目的 tsconfig 只有 `lib: ["ESNext"]`，没有 DOM 的 `BodyInit` 类型。
 */
function serializeBody(body: unknown, headers: Headers): string | undefined {
    if (body === undefined || body === null) return undefined;
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    return typeof body === "string" ? body : JSON.stringify(body);
}

/** 只透传"有意义且安全"的响应头（不复制 set-cookie 等）。 */
function passthroughHeaders(upstream: Response): Record<string, string> {
    const result: Record<string, string> = {};
    const contentType = upstream.headers.get("content-type");
    if (contentType) result["Content-Type"] = contentType;
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) result["Retry-After"] = retryAfter;
    result["Cache-Control"] = "no-store";
    return result;
}

/** 日志/错误里出现的 URL 去掉 query（可能含 `key=`）。 */
function redactUrl(raw: string): string {
    try {
        const parsed = new URL(raw);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return raw.slice(0, 120);
    }
}
