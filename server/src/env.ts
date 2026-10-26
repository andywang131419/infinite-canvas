/**
 * 环境变量集中校验层。
 *
 * 设计原则（对应 ARCH Rev2 §R10 / T01 要求）：
 * 1. 所有变量在这里一次性解析、校验、给出类型，业务代码**只**通过 `getEnv()` 读取。
 * 2. **缺关键变量 = 进程启动即失败**（fail-fast），不留给运行期 500。
 * 3. 非关键变量一律给默认值，保证「空主机 docker compose up」即可启动（P0-10）。
 * 4. 解析结果缓存，避免每请求重复 parse。
 */

import { z } from "zod";

/** 布尔型环境变量：只接受 "true" / "false" 字符串。 */
const boolFromEnv = (fallback: boolean) =>
    z
        .enum(["true", "false"])
        .default(fallback ? "true" : "false")
        .transform((value) => value === "true");

/** 整数型环境变量：正整数，越界即启动失败。 */
const intFromEnv = (fallback: number, min = 1) => z.coerce.number().int().min(min).default(fallback);

/**
 * 环境变量 schema。
 *
 * 必填项只有两个：
 * - `DATABASE_PATH`：SQLite 文件路径（容器内固定 /data/app.db）
 * - `AUTH_SECRET`：会话 token 与渠道密钥的 HKDF 主密钥
 *
 * 其余全部有默认值，取自 ARCH §R10「deploy/.env.example 定稿」。
 */
const envSchema = z.object({
    // ===== 基础 =====
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_VERSION: z.string().min(1).default("0.20.0-fork.1"),
    HTTP_PORT: intFromEnv(8787),
    HTTP_HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // ===== 数据库（bun:sqlite）=====
    DATABASE_PATH: z.string().min(1, "DATABASE_PATH 不能为空，容器内通常为 /data/app.db"),
    DB_BUSY_TIMEOUT_MS: intFromEnv(5000, 100),
    MIGRATIONS_DIR: z.string().min(1).default("migrations"),

    // ===== 鉴权 =====
    AUTH_SECRET: z.string().min(32, "AUTH_SECRET 至少 32 字符，请用 `openssl rand -base64 48` 生成"),
    SESSION_TTL_DAYS: intFromEnv(30),
    /** 会话 Cookie 名（HttpOnly，不透明 token 存这里）。 */
    SESSION_COOKIE_NAME: z.string().min(1).default("ic_session"),
    ALLOW_REGISTRATION: boolFromEnv(false),
    LOGIN_RATE_LIMIT_PER_MIN: intFromEnv(5),
    COOKIE_SECURE: boolFromEnv(true),
    /**
     * 是否信任 `X-Forwarded-For`（Caddy 反代会写）。
     *
     * 生产必须为 true，否则限流会把所有请求算到同一个 IP（Caddy 的内网地址），
     * "同 IP+账号 5 次/分" 退化成"全站 5 次/分"。
     * 直接裸跑 `bun run dev`（无代理）时应设为 false。
     */
    TRUST_PROXY: boolFromEnv(true),

    // ===== 存储 =====
    STORAGE_DRIVER: z.enum(["local", "cos", "oss", "minio"]).default("local"),
    STORAGE_LOCAL_ROOT: z.string().min(1).default("/data/media"),
    MAX_UPLOAD_MB: intFromEnv(200),
    MAX_DOC_JSON_MB: intFromEnv(8),

    // ===== 任务 / Worker =====
    WORKER_ENABLED: boolFromEnv(true),
    WORKER_CONCURRENCY: intFromEnv(2),
    WORKER_POLL_MS: intFromEnv(1000, 50),
    WORKER_LEASE_SECONDS: intFromEnv(60),
    JOB_MAX_ATTEMPTS: intFromEnv(2),
    JOB_IMAGE_TIMEOUT_S: intFromEnv(180),
    JOB_VIDEO_TIMEOUT_S: intFromEnv(600),
    JOB_RETRY_BACKOFF_S: intFromEnv(30),
    MODEL_SCRIPT_ENABLED: boolFromEnv(false),

    // ===== 上游 / 安全面 =====
    LOCAL_AGENT_ENABLED: boolFromEnv(false),
    /** 逗号分隔的额外出站白名单；通常留空，仅用各 channel 的 baseUrl host。 */
    UPSTREAM_HOST_ALLOWLIST: z
        .string()
        .default("")
        .transform((value) =>
            value
                .split(",")
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean),
        ),

    // ===== 备份 =====
    // cron 侧的实际执行在 backup 容器（deploy/backup/backup.sh）；
    // 服务端只负责「手动触发一次」（POST /api/backups/run）与审计行读写的展示。
    BACKUP_ENABLED: boolFromEnv(true),
    BACKUP_CRON: z.string().min(1).default("0 3 * * *"),
    BACKUP_DB_KEEP_DAYS: intFromEnv(14),
    BACKUP_RETRY: intFromEnv(3),
    BACKUP_TARGET_LABEL: z.string().default(""),
    /** 本地暂存目录（与 backup.sh 的 BACKUP_STAGE_DIR 保持一致）。 */
    BACKUP_STAGE_DIR: z.string().min(1).default("/data/backups"),
    /** 是否把媒体目录一并统计进审计行（tar 打包仍由 backup.sh 负责）。 */
    BACKUP_INCLUDE_MEDIA: boolFromEnv(true),
    /** rclone 远端名；空 = 只留本地。 */
    RCLONE_REMOTE: z.string().default(""),
    /** rclone 目标路径（远端名之后的部分）。 */
    RCLONE_DEST: z.string().default(""),
});

/** 校验后的环境变量类型。 */
export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * 读取并校验环境变量（首次调用时解析，之后走缓存）。
 *
 * 校验失败会抛出 `EnvValidationError`，其中汇总**全部**错误字段，
 * 便于 `docker compose up` 时一眼看出缺了哪些变量。
 */
export function getEnv(): Env {
    if (cached) return cached;

    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        const details = parsed.error.issues.map((issue) => {
            const key = issue.path.join(".") || "(root)";
            return `  - ${key}: ${issue.message}`;
        });
        throw new EnvValidationError(
            ["环境变量校验失败，进程中止启动：", ...details, "", "本地开发请在 server/ 下执行：cp .env.example .env"].join("\n"),
            parsed.error.issues.map((issue) => ({ key: issue.path.join("."), message: issue.message })),
        );
    }

    cached = parsed.data;
    return cached;
}

/** 仅供测试使用：清空缓存。 */
export function resetEnvCache(): void {
    cached = null;
}

/** 环境变量校验失败。 */
export class EnvValidationError extends Error {
    readonly issues: { key: string; message: string }[];

    constructor(message: string, issues: { key: string; message: string }[]) {
        super(message);
        this.name = "EnvValidationError";
        this.issues = issues;
    }
}

/** 是否生产环境。 */
export function isProduction(): boolean {
    return getEnv().NODE_ENV === "production";
}
