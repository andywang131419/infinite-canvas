/**
 * 密码哈希 —— `Bun.password`（argon2id）。
 *
 * 为什么用 argon2id 而不是 bcrypt/PBKDF2（ARCH Rev2 §R6）：
 * - argon2id 同时抗 GPU 与抗侧信道，是当前密码哈希的推荐算法；
 * - **关键工程原因**：`Bun.password` 是 Bun 运行时内置的，零原生依赖，
 *   不需要 `node-gyp` / `python3` / `make` / `g++` ——
 *   这正好满足 ARCH R2.1「镜像里绝不引入原生编译工具链」的硬约束。
 *   （`bcrypt` / `argon2` 等 npm 包都需要编译，直接排除。）
 *
 * 参数选择：memoryCost 19 MiB / timeCost 2 是 OWASP 对 argon2id 的
 * 首选配置（单次约 20~50ms，单用户场景完全够用）。
 */

/** 哈希参数。改这些值只影响**新**密码，旧哈希仍可校验（参数编码在哈希串里）。 */
const ARGON2_OPTIONS = {
    algorithm: "argon2id" as const,
    /** 19 MiB，OWASP 推荐下限。 */
    memoryCost: 19_456,
    /** 迭代次数。 */
    timeCost: 2,
};

/** 密码最短长度。 */
export const PASSWORD_MIN_LENGTH = 8;
/** 密码最长长度（argon2 本身不限，这里防 DoS 与误用超长密钥）。 */
export const PASSWORD_MAX_LENGTH = 256;

/** 密码强度校验结果。 */
export type PasswordCheck = { ok: true } | { ok: false; message: string };

/**
 * 校验密码是否满足最低要求。
 *
 * 刻意只做长度校验，不强制"大小写+数字+符号"组合 ——
 * 组合规则会促使用户产生 `Password1!` 这类可预测密码，
 * 而单用户自托管场景下长度才是主要防线。
 */
export function checkPasswordStrength(password: string): PasswordCheck {
    if (typeof password !== "string" || password.length === 0) {
        return { ok: false, message: "密码不能为空" };
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
        return { ok: false, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` };
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return { ok: false, message: `密码不得超过 ${PASSWORD_MAX_LENGTH} 位` };
    }
    return { ok: true };
}

/** 计算哈希（存进 `users.password_hash`）。 */
export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password, ARGON2_OPTIONS);
}

/**
 * 校验密码。
 *
 * 失败时**不区分**"用户不存在"与"密码错误"（时序/文案都不区分），
 * 避免账号枚举。调用方应对两种情况返回同一个 `INVALID_CREDENTIALS`。
 *
 * 哈希串损坏（例如手工改过库）会返回 `false` 而不是抛错，
 * 保证登录接口不会因为一行脏数据 500。
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    if (typeof hash !== "string" || hash.length === 0) return false;
    try {
        return await Bun.password.verify(password, hash);
    } catch {
        return false;
    }
}

/**
 * 判断字符串是否是 Bun.password 产出的 argon2 哈希。
 *
 * 用途：`scripts/create-user.ts` 与 `/api/setup` 写入前自检，
 * 防止把明文密码误写进 password_hash 列。
 */
export function isPasswordHash(value: string): boolean {
    return typeof value === "string" && /^\$argon2(id|i|d)\$/.test(value);
}
