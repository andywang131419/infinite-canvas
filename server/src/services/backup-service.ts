/**
 * 备份服务 —— 服务端侧的"手动备份"实现。
 *
 * 与 `deploy/backup/backup.sh` 的分工（重要）：
 * | 能力            | backup.sh（cron 容器） | 本文件（手动触发） |
 * |-----------------|------------------------|--------------------|
 * | DB 在线快照      | `sqlite3 .backup`      | `VACUUM INTO`      |
 * | gzip            | gzip                   | `node:zlib`        |
 * | 媒体 tar 打包    | tar                     | 仅统计，不打包      |
 * | rclone 上传      | rclone                  | rclone（若存在）    |
 * | 写 backups 审计行 | sqlite3 INSERT          | repos/backups.ts   |
 *
 * 为什么手动备份不直接调用 backup.sh：
 * 1. 服务端镜像里没有 `sqlite3` CLI（只有 Bun 运行时，见 T01 Dockerfile）；
 * 2. `VACUUM INTO` 同样是 SQLite 官方的在线快照能力（3.27+），
 *    在 WAL 模式下能拿到一致快照，效果与 `.backup` 等价；
 * 3. 少一个 shell 依赖 → 少一类"路径/权限/引号"事故。
 *
 * 媒体不打包是有意的取舍：媒体动辄几十 GB，手动点击触发一次 tar 会长时间占用 IO，
 * 且服务端进程内做 tar 需要额外库。媒体备份交给 cron 容器的 `BACKUP_INCLUDE_MEDIA=true`。
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import { getDb } from "../db/client";
import {
    finishBackupFailed,
    finishBackupSuccess,
    insertBackupRun,
    listBackups,
    latestBackup,
    pruneBackupRows,
    type BackupRow,
    type BackupTrigger,
} from "../db/repos/backups";
import { getEnv } from "../env";
import { ApiError } from "../http/errors";

const gzip = promisify(gzipCallback);
const execFileAsync = promisify(execFile);

/** 统计媒体目录的结果。 */
export type MediaStats = { files: number; bytes: number };

/** 备份 DTO（前端展示用）。 */
export type BackupDto = {
    id: string;
    trigger: string;
    status: string;
    dbBytes: number | null;
    mediaFiles: number | null;
    mediaBytes: number | null;
    target: string | null;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
};

/** 行 → DTO。 */
export function toBackupDto(row: BackupRow): BackupDto {
    return {
        id: row.id,
        trigger: row.trigger,
        status: row.status,
        dbBytes: row.db_bytes,
        mediaFiles: row.media_files,
        mediaBytes: row.media_bytes,
        target: row.target,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}

/** 列表（含最近一次的摘要）。 */
export function listBackupDtos(limit = 20): { items: BackupDto[]; latest: BackupDto | null } {
    const items = listBackups(limit).map(toBackupDto);
    const latestRow = latestBackup();
    return { items, latest: latestRow ? toBackupDto(latestRow) : null };
}

/** 一次备份的详细结果（同步返回给调用方，便于立即展示）。 */
export type BackupRunResult = {
    backup: BackupDto;
    /** 本地生成的快照文件路径（`app-<ts>.sqlite.gz`）。 */
    file: string;
    /** 实际字节数（压缩后）。 */
    bytes: number;
    /** 是否上传到了 rclone 远端。 */
    uploaded: boolean;
    /** 保留策略删掉的文件数。 */
    prunedFiles: number;
};

/**
 * 执行一次备份。
 *
 * 步骤（任一步失败都会把审计行写成 `failed` 并抛出）：
 *   1. 建审计行（running）
 *   2. `VACUUM INTO` 生成临时快照
 *   3. gzip 压缩到 `BACKUP_STAGE_DIR/app-<stamp>.sqlite.gz`
 *   4. 统计媒体（可选）
 *   5. rclone 上传（配了才做）
 *   6. 清理超期本地文件 + 审计行
 *   7. 审计行写 success
 *
 * @throws {ApiError} `BACKUP_FAILED` 失败原因
 */
export async function runBackup(trigger: BackupTrigger = "manual"): Promise<BackupRunResult> {
    const env = getEnv();

    if (!env.BACKUP_ENABLED) {
        throw new ApiError("BACKUP_FAILED", "备份已通过 BACKUP_ENABLED=false 关闭");
    }

    const id = `bk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    const stamp = startedAt.replace(/[-:]/g, "").replace(/\..+$/, "Z");
    const stageDir = env.BACKUP_STAGE_DIR;
    const snapshotPath = join(stageDir, `.snapshot-${stamp}.sqlite`);
    const outputPath = join(stageDir, `app-${stamp}.sqlite.gz`);
    const target = env.BACKUP_TARGET_LABEL || (env.RCLONE_REMOTE ? `${env.RCLONE_REMOTE}:${env.RCLONE_DEST}` : stageDir);

    insertBackupRun(id, trigger, target, startedAt);

    let dbBytes = 0;
    let media: MediaStats = { files: 0, bytes: 0 };

    try {
        // ---- 1. 目录与在线快照 ----
        await mkdir(stageDir, { recursive: true });
        vacuumInto(snapshotPath);

        // ---- 2. 压缩 ----
        const raw = await readFile(snapshotPath);
        const gz = await gzip(raw);
        await writeFile(outputPath, gz);
        dbBytes = gz.byteLength;

        // ---- 3. 媒体统计 ----
        media = env.BACKUP_INCLUDE_MEDIA ? await countMedia(env.STORAGE_LOCAL_ROOT) : { files: 0, bytes: 0 };

        // ---- 4. 上传 ----
        const uploaded = await uploadWithRclone(stageDir);

        // ---- 5. 清理 ----
        const prunedFiles = await pruneLocalBackups(stageDir, env.BACKUP_DB_KEEP_DAYS);
        pruneBackupRows(env.BACKUP_DB_KEEP_DAYS);

        const finishedAt = new Date().toISOString();
        finishBackupSuccess(id, { dbBytes, mediaFiles: media.files, mediaBytes: media.bytes, target }, finishedAt);

        console.info(`[backup] 手动备份完成：${outputPath}（${dbBytes} bytes，上传=${uploaded}，清理=${prunedFiles}）`);

        return {
            backup: {
                id,
                trigger,
                status: "success",
                dbBytes,
                mediaFiles: media.files,
                mediaBytes: media.bytes,
                target,
                errorMessage: null,
                startedAt,
                finishedAt,
            },
            file: outputPath,
            bytes: dbBytes,
            uploaded,
            prunedFiles,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finishBackupFailed(id, { dbBytes, mediaFiles: media.files, mediaBytes: media.bytes }, message, new Date().toISOString());
        console.error(`[backup] 手动备份失败：${message}`);
        throw new ApiError("BACKUP_FAILED", `备份失败：${message}`);
    } finally {
        // 临时快照必须删：它没有压缩，一张 200MB 的库会把卷占满。
        await unlink(snapshotPath).catch(() => undefined);
    }
}

/**
 * `VACUUM INTO` 在线快照。
 *
 * 路径是服务端自己拼的（stage 目录 + 时间戳），不含用户输入；
 * 仍然做一次单引号转义，避免 stage 目录里带引号时把语句拼坏。
 */
function vacuumInto(path: string): void {
    const escaped = path.replace(/'/g, "''");
    getDb().exec(`VACUUM INTO '${escaped}'`);
}

/**
 * 列目录（失败返回空数组）。
 *
 * 单独封装的原因：`readdir(dir, { withFileTypes: true })` 的返回类型在
 * `@types/node` 里有多个重载，直接内联会退化成 `Dirent<NonSharedBuffer>[]`，
 * 在这里统一收敛成 `Dirent[]`。
 */
async function listEntries(dir: string): Promise<Dirent[]> {
    try {
        return (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
    } catch {
        return [];
    }
}

/** 递归统计媒体目录的文件数与字节数（目录不存在时返回 0）。 */
async function countMedia(root: string): Promise<MediaStats> {
    let files = 0;
    let bytes = 0;

    async function walk(dir: string): Promise<void> {
        const entries = await listEntries(dir);

        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            try {
                const info = await stat(full);
                files += 1;
                bytes += info.size;
            } catch {
                // 单个文件不可读（权限/竞态）不影响整体统计。
            }
        }
    }

    await walk(root);
    return { files, bytes };
}

/**
 * 用 rclone 上传最近产生的快照。
 *
 * 未配置远端或本机没有 rclone 时返回 false（**不算失败**：
 * 本地备份文件已经存在，符合"至少有一份"的底线）。
 */
async function uploadWithRclone(stageDir: string): Promise<boolean> {
    const env = getEnv();
    if (!env.RCLONE_REMOTE) return false;

    try {
        await execFileAsync(
            "rclone",
            ["copy", stageDir, `${env.RCLONE_REMOTE}:${env.RCLONE_DEST}`, "--include", "app-*.sqlite.gz", "--stats-one-line"],
            { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
        );
        return true;
    } catch (error) {
        // 找不到 rclone 命令 = 部署时没装，按"未上传"处理；其他错误才算真失败。
        if (isMissingBinary(error)) {
            console.warn("[backup] 未找到 rclone 命令，跳过远端上传（本地备份仍有效）");
            return false;
        }
        throw new Error(`rclone 上传失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

/** 判断是否是"命令不存在"。 */
function isMissingBinary(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: string }).code;
    return code === "ENOENT";
}

/** 删除超过保留期的本地备份文件。 */
async function pruneLocalBackups(stageDir: string, keepDays: number): Promise<number> {
    const cutoff = Date.now() - Math.max(1, keepDays) * 86_400_000;
    let removed = 0;

    const entries = await listEntries(stageDir);
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/^app-.+\.sqlite\.gz$/.test(entry.name) && !/^media-.+\.tar\.gz$/.test(entry.name)) continue;

        const full = join(stageDir, entry.name);
        try {
            const info = await stat(full);
            if (info.mtimeMs >= cutoff) continue;
            await unlink(full);
            removed += 1;
        } catch {
            // 删不掉就算了：下次 cron 备份还会再试。
        }
    }

    return removed;
}
