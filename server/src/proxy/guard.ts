/**
 * Tier2 直通代理的安全闸门（SSRF 防护 + 主机白名单）。
 *
 * 为什么需要它：`POST /api/proxy` 会把**用户给的 URL** 变成服务端发出的请求。
 * 如果不加限制，它就等于一个"从你的服务器访问内网"的通用跳板
 * （云厂商 metadata 服务 169.254.169.254 是最经典的利用目标）。
 *
 * 三道闸，顺序不可交换：
 * 1. **协议**：只允许 http/https（`file:` / `gopher:` 一律拒）；
 * 2. **字面量 IP / 特殊主机名**：回环、私网、链路本地、保留段直接拒；
 * 3. **白名单**：hostname 必须出现在"已启用渠道的 baseUrl 主机"集合里
 *    （`services/channel-service.ts: upstreamHostAllowlist`）。
 *
 * 第 3 道闸是主闸：即使某天 DNS 解析检查有漏洞，攻击者也只能打到
 * 他已经配置好的那些上游域名。第 2 道闸拦的是"配了一个内网地址当渠道"的误用。
 *
 * 本文件不 import env / DB，可用 `node` 直接加载（校验脚本要用）。
 */

/** 检查结果。 */
export type TargetCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** 主机校验结果（不含 URL，因为此处只关心"能不能访问"）。 */
export type HostCheck = { ok: true } | { ok: false; reason: string };

/** 明确禁止的主机名（不区分大小写，已在 `normalizeHost` 里统一小写）。 */
const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "kubernetes.default",
    "kubernetes.default.svc",
]);

/** 允许的协议。 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** 把 hostname 归一（小写、去掉 IPv6 方括号）。 */
export function normalizeHost(hostname: string): string {
    const value = (hostname || "").trim().toLowerCase();
    if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
    // URL 解析会把 IPv6 写成 `[::1]`，有的运行时会带点号后缀（`localhost.`）。
    return value.replace(/\.$/, "");
}

/**
 * 判断 IPv4 是否属于禁止访问的网段。
 *
 * 覆盖：`0.0.0.0/8`、`10/8`、`127/8`、`169.254/16`（含 metadata）、
 * `172.16/12`、`192.168/16`、`100.64/10`（CGNAT）、`192.0.0/24`、
 * `198.18/15`（基准测试段）、`224/4`（组播）、`240/4`（保留）。
 */
export function isBlockedIpv4(ip: string): boolean {
    const parts = ip.split(".");
    if (parts.length !== 4) return false;

    const octets = parts.map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

    const [a, b] = octets as [number, number, number, number];

    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;

    return false;
}

/**
 * 判断 IPv6 是否属于禁止访问的网段。
 *
 * 覆盖：`::`（未指定）、`::1`（回环）、`fc00::/7`（唯一本地）、
 * `fe80::/10`（链路本地）、`ff00::/8`（组播）、`::ffff:a.b.c.d`（映射到 IPv4 后按 v4 规则判）。
 */
export function isBlockedIpv6(ip: string): boolean {
    const value = normalizeHost(ip);
    if (value === "::" || value === "::1") return true;

    // IPv4-mapped（`::ffff:127.0.0.1`）：拆出尾部按 v4 判，否则会被当成"公网 v6"。
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
    if (mapped) return isBlockedIpv4(mapped[1]!);

    const first = value.split(":")[0] ?? "";
    if (first.length === 0) return value.startsWith(":") ? false : true;

    const head = parseInt(first, 16);
    if (!Number.isFinite(head)) return false;
    if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((head & 0xff00) === 0xff00) return true; // ff00::/8

    return false;
}

/** 是否是 IP 字面量（而不是域名）。 */
export function isIpLiteral(host: string): boolean {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
    return host.includes(":");
}

/** 判断一个主机是否命中 SSRF 禁止列表（域名 + IP 两类）。 */
export function isBlockedHost(hostname: string): boolean {
    const host = normalizeHost(hostname);
    if (host.length === 0) return true;
    if (BLOCKED_HOSTNAMES.has(host)) return true;

    // 一些云厂商的 metadata 别名形如 `xxx.internal` / `*.local`。
    if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) return true;

    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isBlockedIpv4(host);
    if (host.includes(":")) return isBlockedIpv6(host);

    return false;
}

/**
 * 判断 host 是否在白名单里。
 *
 * 匹配规则：完全相等，或以 `.白名单项` 结尾（允许 `api.openai.com` 这类子域）。
 * **不允许**白名单项是 `.com` 这种过度宽泛的值 —— 由调用方保证白名单来源可信
 * （只来自 channels.base_url 与 env，不来自请求体）。
 */
export function isAllowedHost(hostname: string, allowlist: ReadonlySet<string>): boolean {
    const host = normalizeHost(hostname);
    if (host.length === 0) return false;
    if (allowlist.has(host)) return true;

    for (const entry of allowlist) {
        const normalized = normalizeHost(entry);
        if (normalized.length === 0) continue;
        if (host.endsWith(`.${normalized}`)) return true;
    }
    return false;
}

/**
 * 检查一个目标 URL 是否可代理。
 *
 * 纯函数：不发请求、不做 DNS 解析（DNS 解析在路由层用
 * `resolveAndCheckHost()` 单独做，避免校验脚本联网）。
 */
export function checkTarget(rawUrl: string, allowlist: ReadonlySet<string>): TargetCheck {
    let url: URL;
    try {
        url = new URL((rawUrl ?? "").trim());
    } catch {
        return { ok: false, reason: "url 不是合法 URL" };
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        return { ok: false, reason: `只允许 http/https，当前是 ${url.protocol}` };
    }
    if (!url.hostname) {
        return { ok: false, reason: "url 缺少主机名" };
    }
    if (url.username || url.password) {
        return { ok: false, reason: "url 不得包含账号密码" };
    }

    const host = normalizeHost(url.hostname);
    if (isBlockedHost(host)) {
        return { ok: false, reason: `目标主机 ${host} 属于内网/保留地址，禁止代理` };
    }
    if (!isAllowedHost(host, allowlist)) {
        return { ok: false, reason: `目标主机 ${host} 不在渠道白名单内` };
    }

    return { ok: true, url };
}

/**
 * 解析域名并逐个检查解析结果。
 *
 * 为什么需要：`http://127.0.0.1.nip.io` 这种域名解析后是回环地址，
 * 只查字面量会被绕过。路由层在真正 fetch 之前调用本函数。
 *
 * 解析失败不拦截 —— 让上游请求自己失败并返回更准确的信息；
 * 真正危险的是"解析成功但指向内网"。
 */
export async function resolveAndCheckHost(hostname: string): Promise<HostCheck> {
    const host = normalizeHost(hostname);
    if (host.length === 0) return { ok: false, reason: "缺少主机名" };
    if (isBlockedHost(host)) return { ok: false, reason: `目标主机 ${host} 属于内网/保留地址` };
    if (isIpLiteral(host)) return { ok: true };

    try {
        const addresses = await lookupAll(host);
        for (const address of addresses) {
            if (isBlockedHost(address)) {
                return { ok: false, reason: `目标主机 ${host} 解析到内网地址 ${address}，禁止代理` };
            }
        }
    } catch {
        // 解析不了就交给 fetch 报错。
    }

    return { ok: true };
}

/** DNS 查询（动态 import，避免把 `node:dns` 变成模块加载期的硬依赖）。 */
async function lookupAll(host: string): Promise<string[]> {
    const dns = await import("node:dns/promises");
    const records = await dns.lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
}
