/**
 * 从 Hono 的 `Context` 里取"与业务无关但与安全/协议有关的"原始信息。
 *
 * 单独成文件的理由：这些函数都很短，但每个都有**必须一次性做对**的细节
 * （XFF 取哪一段、Range 语法、body 大小限制），散落在各路由里迟早会写歪。
 */

import type { Context } from "hono";

import { getEnv } from "../env";
import { ApiError } from "./errors";

/**
 * 客户端 IP。
 *
 * 取用顺序（`TRUST_PROXY=true` 即生产/Caddy 环境）：
 * 1. `X-Forwarded-For` 的**第一段**（最靠近客户端的那跳）；Caddy 默认追加而非覆盖，
 *    首段是真实客户端 IP。
 * 2. `X-Real-IP`（部分反代只设这个）。
 * 3. `Bun` 提供的 socket 地址（`c.env` 里拿不到时用 `0.0.0.0` 兜底）。
 *
 * `TRUST_PROXY=false` 时**忽略**所有转发头 ——
 * 否则客户端自己伪造 `X-Forwarded-For: 1.2.3.4` 就能绕过"同 IP 5 次/分"限流。
 */
export function clientIp(c: Context): string {
    const env = getEnv();
    if (!env.TRUST_PROXY) return socketIp(c) ?? "direct";

    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
        const first = forwarded.split(",")[0]?.trim();
        if (first) return normalizeIp(first);
    }

    const realIp = c.req.header("x-real-ip");
    if (realIp?.trim()) return normalizeIp(realIp.trim());

    return socketIp(c) ?? "unknown";
}

/** Bun/Hono 的底层连接信息（拿不到就返回 null）。 */
function socketIp(c: Context): string | null {
    const raw = c.env as { remoteAddress?: string; requestIP?: (request: Request) => { address: string } | null } | undefined;
    if (typeof raw?.requestIP === "function") {
        const info = raw.requestIP(c.req.raw);
        if (info?.address) return normalizeIp(info.address);
    }
    return raw?.remoteAddress ? normalizeIp(raw.remoteAddress) : null;
}

/** IPv6 映射地址归一化（`::ffff:1.2.3.4` → `1.2.3.4`），避免同一台机器算成两个 IP。 */
function normalizeIp(value: string): string {
    const trimmed = value.trim();
    return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

/** 客户端 User-Agent（截断到 512 字符，防止有人塞巨串）。 */
export function clientUserAgent(c: Context): string | null {
    const value = c.req.header("user-agent");
    return value ? value.slice(0, 512) : null;
}

/** 读取 JSON body，并保证体积上限。 */
export async function readJsonBody<T = unknown>(c: Context, maxBytes: number): Promise<T> {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("application/json")) {
        throw ApiError.validation("请求必须是 application/json");
    }

    let raw: string;
    try {
        raw = await c.req.text();
    } catch (error) {
        throw ApiError.validation(`读取请求体失败：${error instanceof Error ? error.message : String(error)}`);
    }

    // 用字节长度而不是字符数：中文场景下 `raw.length` 会低估实际传输量。
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes > maxBytes) {
        throw new ApiError("DOC_TOO_LARGE", `请求体 ${formatMb(bytes)} 超过上限 ${formatMb(maxBytes)}`);
    }
    if (raw.trim().length === 0) {
        throw ApiError.validation("请求体为空");
    }

    try {
        return JSON.parse(raw) as T;
    } catch {
        throw ApiError.validation("请求体不是合法 JSON");
    }
}

/** 字节数 → 人类可读 MB（用于错误文案）。 */
export function formatMb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/** 解析后的 `Range`。 */
export type ParsedRange = { start: number; end?: number } | "unsatisfiable" | null;

/**
 * 解析单区间 `Range: bytes=start-end` / `bytes=start-` / `bytes=-suffix`。
 *
 * 只支持**单区间**（RFC 7233 允许服务端忽略多区间请求）：
 * multipart/byteranges 对 `<video>` 播放不是必需，但实现复杂度高一个量级。
 * 多区间请求直接返回 `null`（= 忽略 Range，返回整份 200），
 * 这是 RFC 允许的合法行为。
 *
 * @returns
 * - `null`：无 Range 头 / 语法不识别 / 多区间 → 调用方按整份返回 200
 * - `"unsatisfiable"`：语法合法但区间不可能满足 → 416
 */
export function parseRangeHeader(value: string | undefined, size: number): ParsedRange {
    if (!value) return null;

    const matched = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (!matched) return null;

    const [, rawStart, rawEnd] = matched;
    const hasStart = rawStart !== undefined && rawStart !== "";
    const hasEnd = rawEnd !== undefined && rawEnd !== "";

    // `bytes=-500`：最后 500 字节
    if (!hasStart && hasEnd) {
        const suffix = Number(rawEnd);
        if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
        if (size === 0) return "unsatisfiable";
        return { start: Math.max(0, size - suffix), end: size };
    }

    if (!hasStart) return null;

    const start = Number(rawStart);
    if (!Number.isFinite(start) || start < 0) return "unsatisfiable";
    if (start >= size) return "unsatisfiable";

    if (!hasEnd) return { start };

    const end = Number(rawEnd);
    if (!Number.isFinite(end) || end < start) return "unsatisfiable";

    // HTTP Range 的 end 是**闭**区间，内部统一用开区间。
    return { start, end: Math.min(end + 1, size) };
}
