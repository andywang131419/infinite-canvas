/**
 * 不透明会话 token 的生成与哈希。
 *
 * 设计（ARCH Rev2 §R6 / T02 第 1 条）：
 * - token 是 **32 字节随机数的 base64url**（43 字符，无 padding），
 *   不是 JWT —— 不需要在客户端解析任何东西，也没有"改了 payload 就提权"的风险；
 * - 数据库只存 `sha256(token)`。校验是"哈希后等值查表"，
 *   等价于密码学意义上的常量时间比较（攻击者无法从表里反推 token）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** token 字节数（32 字节 = 256 bit 熵，远超暴力猜测可能）。 */
const TOKEN_BYTES = 32;

/**
 * 生成新 token 原文。
 *
 * 只在「登录成功 → 写 Set-Cookie」这一处调用，**绝不落库、绝不写日志**。
 */
export function createSessionToken(): string {
    return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** 计算 token 的 sha256（十六进制，64 字符）—— 这是唯一入库的形式。 */
export function hashSessionToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 常量时间比较（供需要"已知哈希"比对的场景使用）。
 *
 * 注意：正常校验走的是"哈希后查表"（`SQL_SELECT_SESSION_WITH_USER`），
 * 由索引完成比对，**不需要**调用本函数；这里保留给后续 TOTP 校验等场景。
 */
export function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

/** token 形状校验（挡住明显不是我们发的 Cookie，避免无谓查库）。 */
export function looksLikeSessionToken(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
