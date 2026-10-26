/**
 * 密钥保险箱 —— 用 AES-256-GCM 加密渠道 API Key 再入库。
 *
 * 为什么不是"加密即可"而是 GCM：
 * GCM 是 AEAD，解密时会校验 tag。攻击者篡改数据库里的密文（哪怕改一个字节）
 * 都会在解密阶段直接失败，而不是解出一段垃圾密钥再去打上游（那会产生
 * 难以归因的 401/计费异常）。这一点在 T03 的自检里有专门的断言。
 *
 * 密钥派生（ARCH Rev2 §R5）：
 *   key = HKDF-SHA256(ikm = AUTH_SECRET, salt = "infinite-canvas/secret-box", info = "aes-256-gcm", L = 32)
 *
 * 为什么用 HKDF 而不是直接截取 AUTH_SECRET 的前 32 字节：
 * - AUTH_SECRET 是 base64，直接截取会浪费熵且分布不均；
 * - 同一个 AUTH_SECRET 还会派生别的用途（会话签名等），HKDF 的 `info`
 *   保证不同用途得到**互相独立**的子密钥（域分离）。
 *
 * 密文格式（带版本前缀，便于将来轮换算法）：
 *   `v1.<base64url(iv | tag | ciphertext)>`
 *   - iv：12 字节随机（GCM 推荐长度，每次加密必须重新生成）
 *   - tag：16 字节认证标签
 *   - ciphertext：与明文等长
 *
 * 安全红线：本模块导出的任何函数都**不写日志**。密钥只往 DB / 上游请求头里走。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { getEnv } from "../env.ts";

/** 当前密文版本号。将来换算法时递增，并保留旧版解密分支。 */
const CURRENT_VERSION = "v1";

/** HKDF 参数（改这些值等于让所有已存密文失效，务必谨慎）。 */
const HKDF_SALT = "infinite-canvas/secret-box";
const HKDF_INFO = "aes-256-gcm";

/** AES-256 → 32 字节密钥。 */
const KEY_LENGTH = 32;
/** GCM 推荐 IV 长度。 */
const IV_LENGTH = 12;
/** GCM 认证标签长度。 */
const TAG_LENGTH = 16;

/** 解密失败（密文被篡改 / 换了 AUTH_SECRET / 格式不对）。 */
export class SecretBoxError extends Error {
    readonly reason: "malformed" | "unknown_version" | "auth_failed" | "empty";

    constructor(reason: SecretBoxError["reason"], message: string) {
        super(message);
        this.name = "SecretBoxError";
        this.reason = reason;
    }
}

/** AUTH_SECRET → 子密钥的缓存（避免每次加解密都跑一遍 HKDF）。 */
let cachedKey: { secret: string; key: Buffer } | null = null;

/**
 * 取出（必要时派生）AES 密钥。
 *
 * 缓存按 `AUTH_SECRET` 原文校验：若运行期改了环境变量（不该发生，但测试会），
 * 会自动重新派生而不是用旧密钥。
 */
function getKey(): Buffer {
    const { AUTH_SECRET } = getEnv();
    if (cachedKey && cachedKey.secret === AUTH_SECRET) return cachedKey.key;

    const derived = hkdfSync("sha256", Buffer.from(AUTH_SECRET, "utf8"), Buffer.from(HKDF_SALT, "utf8"), Buffer.from(HKDF_INFO, "utf8"), KEY_LENGTH);
    const key = Buffer.from(derived);

    if (key.length !== KEY_LENGTH) {
        throw new Error(`HKDF 派生长度异常：${key.length}`);
    }

    cachedKey = { secret: AUTH_SECRET, key };
    return key;
}

/**
 * 加密。
 *
 * @param plaintext 明文（API Key）。
 * @returns `v1.<base64url(iv|tag|ciphertext)>`
 * @throws {SecretBoxError} 明文为空
 */
export function encryptSecret(plaintext: string): string {
    if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new SecretBoxError("empty", "待加密内容为空");
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    // 拼接顺序固定为 iv | tag | ciphertext，解密端按同一顺序切分。
    const packed = Buffer.concat([iv, tag, ciphertext]);
    return `${CURRENT_VERSION}.${packed.toString("base64url")}`;
}

/**
 * 解密。
 *
 * @param sealed `v1.<...>` 密文。
 * @returns 明文。
 * @throws {SecretBoxError}
 * - `empty`：空输入
 * - `malformed`：缺少版本前缀 / base64 解不开 / 长度不足
 * - `unknown_version`：版本前缀不是已知的
 * - `auth_failed`：**GCM tag 校验失败**（密文被篡改，或 AUTH_SECRET 变了）
 */
export function decryptSecret(sealed: string): string {
    if (typeof sealed !== "string" || sealed.length === 0) {
        throw new SecretBoxError("empty", "待解密内容为空");
    }

    const dotAt = sealed.indexOf(".");
    if (dotAt <= 0) {
        throw new SecretBoxError("malformed", "密文缺少版本前缀（应为 v1.<payload>）");
    }

    const version = sealed.slice(0, dotAt);
    if (version !== CURRENT_VERSION) {
        throw new SecretBoxError("unknown_version", `不支持的密文版本：${version}`);
    }

    let packed: Buffer;
    try {
        packed = Buffer.from(sealed.slice(dotAt + 1), "base64url");
    } catch {
        throw new SecretBoxError("malformed", "密文 base64 解码失败");
    }

    if (packed.length <= IV_LENGTH + TAG_LENGTH) {
        throw new SecretBoxError("malformed", "密文长度不足（iv+tag+payload）");
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

    try {
        const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plaintext.toString("utf8");
    } catch {
        // 统一报 auth_failed：不区分"tag 错"与"密钥错"，避免成为探测接口。
        throw new SecretBoxError("auth_failed", "解密失败：密文已损坏或主密钥不匹配");
    }
}

/**
 * 生成给前端展示的密钥提示，形如 `sk-****abcd`。
 *
 * 规则（对齐 ARCH §R5「api_key_hint」）：
 * - 保留「第一个 `-` 之前的前缀」（`sk` / `gsk` / `AIza` 之类有语义），
 *   保留末尾 4 位用于人工核对；
 * - 太短的密钥（< 12 位）只显示 `****`，不泄露首尾；
 * - **中间部分永远不出现**，且本函数不返回任何可用于还原的信息。
 */
export function maskApiKey(key: string): string {
    if (typeof key !== "string" || key.length === 0) return "";

    if (key.length < 12) return "****";

    const dashAt = key.indexOf("-");
    const prefix = dashAt > 0 && dashAt <= 6 ? key.slice(0, dashAt) : "";
    const tail = key.slice(-4);

    return prefix ? `${prefix}-****${tail}` : `****${tail}`;
}

/**
 * 常量时间比较两个密钥（例如测试里核对解密结果）。
 *
 * 正常业务不需要它：上游鉴权由 provider 负责；
 * 这里保留是为了避免将来有人用 `===` 比较密钥。
 */
export function secretEquals(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

/** 仅供测试：清空派生缓存（配合 resetEnvCache 使用）。 */
export function resetSecretBoxCache(): void {
    cachedKey = null;
}
