/**
 * 登录限流 —— 滑动窗口，粒度 `IP + 账号`。
 *
 * 为什么是"IP + 账号"而不是只按 IP：
 * - 只按 IP：同一 NAT 后面两个人会互相拖累；且攻击者换 IP 就绕过。
 * - 只按账号：攻击者可以用一个 IP 打爆别人的账号（锁死攻击）。
 * - 两者拼接（T02 要求）：既能挡住针对**某个账号**的暴力破解，
 *   也能挡住同一台机器对**多个账号**的撞库（因为每个组合独立计数）。
 *
 * 已知局限（必须写明）：计数在**进程内存**里。
 * 单容器单进程部署（本项目形态）完全够用；若将来横向扩容，
 * 需要换成 Redis 或 SQLite 计数表，否则限流会在实例间被分摊。
 */

import { getEnv } from "../env";

/** 窗口长度（毫秒）—— 固定 1 分钟，与 `LOGIN_RATE_LIMIT_PER_MIN` 语义对齐。 */
const WINDOW_MS = 60_000;

/** 单个组合的命中时间戳队列。 */
type Bucket = { hits: number[]; lastTouched: number };

const buckets = new Map<string, Bucket>();

/** 限流判定结果。 */
export type RateLimitResult = {
    allowed: boolean;
    /** 剩余可用次数（允许时为 >= 0；拒绝时为 0）。 */
    remaining: number;
    /** 拒绝时建议的 `Retry-After` 秒数。 */
    retryAfterSeconds: number;
    /** 窗口内已用次数。 */
    used: number;
    /** 上限。 */
    limit: number;
};

/**
 * 消耗一次配额并返回判定结果。
 *
 * 注意语义：**允许时才计数**。被拒绝的请求不再累加计数 ——
 * 否则一个持续攻击者会把窗口"续期"，让正常用户永远等不到解锁。
 *
 * @param ip 客户端 IP。
 * @param account 账号标识（邮箱小写）；`null` 表示匿名尝试（例如空账号），
 *                此时仍按 IP 单独计数，避免空账号请求无限打。
 * @param nowMs 当前毫秒时间戳（可注入，便于测试）。
 */
export function consumeLoginAttempt(ip: string, account: string | null, nowMs: number = Date.now()): RateLimitResult {
    const limit = getEnv().LOGIN_RATE_LIMIT_PER_MIN;
    const key = `${ip}|${(account ?? "").toLowerCase()}`;
    const now = nowMs;

    const bucket = buckets.get(key) ?? { hits: [], lastTouched: now };
    bucket.lastTouched = now;

    // 滑出窗口的旧记录一律丢弃。
    const cutoff = now - WINDOW_MS;
    bucket.hits = bucket.hits.filter((at) => at > cutoff);

    const used = bucket.hits.length;

    if (used >= limit) {
        buckets.set(key, bucket);
        // 最早一次命中滑出窗口时即可重试。
        const oldest = bucket.hits[0] ?? now;
        const retryAfterMs = Math.max(0, oldest + WINDOW_MS - now);
        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
            used,
            limit,
        };
    }

    bucket.hits.push(now);
    buckets.set(key, bucket);
    pruneIfNeeded(now);

    return { allowed: true, remaining: Math.max(0, limit - (used + 1)), retryAfterSeconds: 0, used: used + 1, limit };
}

/**
 * 登录成功后清空该组合的计数。
 *
 * 目的：让"连续登录失败 5 次后又成功"的用户立刻恢复正常配额，
 * 而不是继续背负之前的失败记录。
 */
export function resetLoginAttempts(ip: string, account: string | null): void {
    buckets.delete(`${ip}|${(account ?? "").toLowerCase()}`);
}

/** 桶数量超过阈值时清掉 2 个窗口以上未活动的键，防止内存缓慢泄漏。 */
function pruneIfNeeded(nowMs: number): void {
    if (buckets.size <= 1024) return;

    const cutoff = nowMs - WINDOW_MS * 2;
    for (const [key, bucket] of buckets) {
        if (bucket.lastTouched < cutoff) buckets.delete(key);
    }
}

/** 仅供测试：清空所有计数。 */
export function resetAllLoginAttempts(): void {
    buckets.clear();
}

/** 仅供测试：当前桶数量。 */
export function loginAttemptBucketCount(): number {
    return buckets.size;
}
