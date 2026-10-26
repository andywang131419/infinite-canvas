/**
 * SQLite 连接与迁移执行器（`bun:sqlite`）。
 *
 * 对应 ARCH Rev2 §R2.3 兜底方案：**所有 DB 访问只经本文件 + 未来的 repos/*
 * 若 Bun 出现阻塞性问题，只需替换本文件，业务代码零改动。**
 *
 * 职责：
 * 1. 建立连接并设置 4 个关键 pragma（WAL / NORMAL / busy_timeout / foreign_keys）
 * 2. 以「schema_migrations 版本号」为唯一依据执行幂等迁移（纯 SQL 文件）
 * 3. 提供健康探针与优雅关闭
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getEnv } from "../env";

/** 迁移记录表名（T01 约定，取代 drizzle 默认的 __drizzle_migrations）。 */
const MIGRATIONS_TABLE = "schema_migrations";

/** 迁移文件名形如 `0001_init.sql`。 */
const MIGRATION_FILE_PATTERN = /^(\d+)_(.+)\.sql$/;

/** 已执行的迁移记录。 */
type AppliedMigration = {
    version: number;
    name: string;
    checksum: string;
    applied_at: string;
};

/** 单个迁移文件。 */
type MigrationFile = {
    version: number;
    name: string;
    path: string;
    sql: string;
    checksum: string;
};

let db: Database | null = null;
let lastMigrationInfo: MigrationInfo | null = null;

/** 迁移执行结果，供 `/api/health` 展示。 */
export type MigrationInfo = {
    /** 执行完成后数据库处于的 schema 版本。 */
    version: number;
    /** 本次进程启动实际执行的迁移文件名。 */
    appliedNow: string[];
    /** 磁盘上发现的迁移文件总数。 */
    total: number;
};

/**
 * 获取（必要时创建）数据库连接。
 *
 * 首次调用会：创建父目录 → 建连 → 设 pragma → 跑迁移。
 * 之后返回同一实例（进程级单例）。
 */
export function getDb(): Database {
    if (db) return db;

    const env = getEnv();
    const databasePath = env.DATABASE_PATH;

    // 确保 /data 之类的父目录存在（容器首次启动时卷是空的）。
    const parent = dirname(databasePath);
    if (parent && parent !== "." && !existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
    }

    const instance = new Database(databasePath, { create: true });
    applyPragmas(instance, env.DB_BUSY_TIMEOUT_MS);

    db = instance;
    lastMigrationInfo = runMigrations(instance, resolveMigrationsDir(env.MIGRATIONS_DIR));

    return db;
}

/** 关闭连接（优雅停机 / 测试用）。 */
export function closeDb(): void {
    if (!db) return;
    try {
        db.close();
    } finally {
        db = null;
        lastMigrationInfo = null;
    }
}

/**
 * 设置 4 个关键 pragma —— 缺一不可：
 * - `journal_mode=WAL`     读写不互斥（备份容器可在服务运行时 .backup）
 * - `synchronous=NORMAL`   WAL 下的推荐值，兼顾耐久与吞吐
 * - `busy_timeout=5000`    并发写冲突时排队而非立刻 SQLITE_BUSY
 * - `foreign_keys=ON`      SQLite 默认**关闭**外键，必须显式打开
 */
function applyPragmas(instance: Database, busyTimeoutMs: number): void {
    // journal_mode 会返回一行结果，用 query 读回以便校验是否真的切到 WAL。
    const journal = instance.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | null;
    if (journal?.journal_mode?.toLowerCase() !== "wal") {
        throw new Error(`无法将 journal_mode 切换为 WAL（当前：${journal?.journal_mode ?? "unknown"}）。请确认数据库文件可写。`);
    }

    instance.exec("PRAGMA synchronous = NORMAL");
    instance.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    instance.exec("PRAGMA foreign_keys = ON");
}

/** 数据库健康探针：能否查询 + 当前 schema 版本 + 关键 pragma 实证。 */
export type DbHealth = {
    status: "ok" | "error";
    path: string;
    schemaVersion: number;
    journalMode: string;
    foreignKeys: boolean;
    migrationsAppliedNow: number;
    error?: string;
};

/** 执行一次轻量健康检查（不抛错，失败时 status="error"）。 */
export function checkDbHealth(): DbHealth {
    const env = getEnv();
    try {
        const instance = getDb();
        const probe = instance.query("SELECT 1 AS ok").get() as { ok: number } | null;
        if (probe?.ok !== 1) throw new Error("SELECT 1 返回异常");

        const journal = instance.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
        const fk = instance.query("PRAGMA foreign_keys").get() as { foreign_keys?: number } | null;

        return {
            status: "ok",
            path: env.DATABASE_PATH,
            schemaVersion: currentSchemaVersion(instance),
            journalMode: (journal?.journal_mode ?? "unknown").toLowerCase(),
            foreignKeys: fk?.foreign_keys === 1,
            migrationsAppliedNow: lastMigrationInfo?.appliedNow.length ?? 0,
        };
    } catch (error) {
        return {
            status: "error",
            path: env.DATABASE_PATH,
            schemaVersion: 0,
            journalMode: "unknown",
            foreignKeys: false,
            migrationsAppliedNow: 0,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

// =============================================================================
// 迁移执行器
// =============================================================================

/** 把 MIGRATIONS_DIR 解析成绝对路径：相对路径以 `server/` 为基准（dev 与镜像内布局一致）。 */
function resolveMigrationsDir(configured: string): string {
    if (isAbsolute(configured)) return configured;
    const here = dirname(fileURLToPath(import.meta.url)); // server/src/db
    const serverRoot = join(here, "..", ".."); // server/
    return join(serverRoot, configured);
}

/** 读取并按版本号升序排列迁移文件。 */
function loadMigrationFiles(dir: string): MigrationFile[] {
    if (!existsSync(dir)) {
        throw new Error(`迁移目录不存在：${dir}`);
    }

    const files: MigrationFile[] = [];
    for (const entry of readdirSync(dir)) {
        const matched = MIGRATION_FILE_PATTERN.exec(entry);
        if (!matched) continue;

        const version = Number(matched[1]);
        const name = matched[2];
        if (!Number.isInteger(version) || version <= 0) {
            throw new Error(`迁移文件名版本号非法：${entry}`);
        }

        const path = join(dir, entry);
        const sql = readFileSync(path, "utf8");
        files.push({ version, name, path, sql, checksum: sha256(sql) });
    }

    files.sort((a, b) => a.version - b.version);

    const seen = new Set<number>();
    for (const file of files) {
        if (seen.has(file.version)) throw new Error(`迁移版本号重复：${file.version}`);
        seen.add(file.version);
    }

    return files;
}

/**
 * 幂等执行迁移。
 *
 * 规则：
 * - 已记录的版本 → 校验 checksum，不一致说明迁移文件被改过（视为严重错误，直接失败）
 * - 未记录的版本 → 在单个事务内执行，成功后写入 schema_migrations
 * - **不使用** `PRAGMA user_version`，版本以 schema_migrations 表为唯一依据
 */
function runMigrations(instance: Database, dir: string): MigrationInfo {
    ensureMigrationsTable(instance);

    const applied = readAppliedMigrations(instance);
    const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
    const files = loadMigrationFiles(dir);
    const knownVersions = new Set(files.map((file) => file.version));

    // 数据库里存在、磁盘上已消失的迁移 → 通常意味着回滚了代码，必须人工介入。
    const orphan = applied.filter((row) => !knownVersions.has(row.version));
    if (orphan.length > 0) {
        throw new Error(`数据库中存在磁盘上已缺失的迁移：${orphan.map((row) => row.version).join(", ")}。请勿删除已发布的迁移文件。`);
    }

    const appliedNow: string[] = [];

    for (const file of files) {
        const recorded = appliedByVersion.get(file.version);

        if (recorded) {
            if (recorded.checksum !== file.checksum) {
                throw new Error(
                    `迁移 ${String(file.version).padStart(4, "0")}_${file.name}.sql 的内容与已执行记录不一致（checksum 不匹配）。已发布的迁移文件不可修改，请新增一个迁移。`,
                );
            }
            continue;
        }

        const fileName = `${String(file.version).padStart(4, "0")}_${file.name}.sql`;
        instance.exec("BEGIN");
        try {
            instance.exec(file.sql);
            instance
                .query(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`)
                .run(file.version, file.name, file.checksum, new Date().toISOString());
            instance.exec("COMMIT");
        } catch (error) {
            instance.exec("ROLLBACK");
            throw new Error(`迁移 ${fileName} 执行失败：${error instanceof Error ? error.message : String(error)}`);
        }

        appliedNow.push(fileName);
    }

    return {
        version: currentSchemaVersion(instance),
        appliedNow,
        total: files.length,
    };
}

/** 建 schema_migrations（本身也要幂等）。 */
function ensureMigrationsTable(instance: Database): void {
    instance.exec(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            checksum   TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );
    `);
}

/** 读出已执行迁移。表刚创建时返回空数组。 */
function readAppliedMigrations(instance: Database): AppliedMigration[] {
    return instance.query(`SELECT version, name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`).all() as AppliedMigration[];
}

/** 当前 schema 版本 = schema_migrations 的最大 version（无记录则为 0）。 */
function currentSchemaVersion(instance: Database): number {
    const row = instance.query(`SELECT COALESCE(MAX(version), 0) AS version FROM ${MIGRATIONS_TABLE}`).get() as { version: number } | null;
    return row?.version ?? 0;
}

/** 内容校验和。 */
function sha256(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 取最近一次迁移执行的摘要（供健康检查 / 启动日志）。 */
export function getMigrationInfo(): MigrationInfo {
    getDb();
    return lastMigrationInfo ?? { version: 0, appliedNow: [], total: 0 };
}
