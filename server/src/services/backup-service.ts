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

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import { resolveBackupTarget, uploadWithRclone } from "./backup-target";
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
    /**
     * 是否真的传到了远端：`true` 已传 / `false` 配了远端但没传成（含没装 rclone）/
     * `null` 没配远端或还没轮到这一步。
     *
     * 单看 `target` 不够：人工标签（`BACKUP_TARGET_LABEL`）场景下 target 是用户
     * 自己写的字符串，无法从它判断有没有真的上传，必须靠这个字段。
     */
    uploaded: boolean | null;
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
        uploaded: row.uploaded === null ? null : row.uploaded === 1,
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
    /**
     * 是否上传到了 rclone 远端（三态，与审计列一致）：
     * `true` 已传 / `false` 配了远端但没传成 / `null` 没配远端。
     */
    uploaded: boolean | null;
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

    // running 行还不知道上传成不成，uploaded 传 null → 写的是**意图**目的地。
    const intendedTarget = resolveBackupTarget({
        label: env.BACKUP_TARGET_LABEL,
        remote: env.RCLONE_REMOTE,
        dest: env.RCLONE_DEST,
        stageDir,
        uploaded: null,
    });

    insertBackupRun(id, trigger, intendedTarget, startedAt);

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
        const uploadedRaw = await uploadWithRclone(stageDir);
        // 没配远端时 uploaded 是 null（"不适用"），配了才区分成/不成。
        const uploaded = env.RCLONE_REMOTE ? uploadedRaw : null;

        // ---- 5. 清理 ----
        const prunedFiles = await pruneLocalBackups(stageDir, env.BACKUP_DB_KEEP_DAYS);
        pruneBackupRows(env.BACKUP_DB_KEEP_DAYS);

        // 终态的 target 必须是**真实去向**：配了远端却没传成（典型是 server 镜像里
        // 没装 rclone）时降回 stageDir，不能让审计行继续谎称数据已在远端。
        // 人工标签 BACKUP_TARGET_LABEL 由 resolveBackupTarget 原样返回，不受影响。
        const finalTarget = resolveBackupTarget({
            label: env.BACKUP_TARGET_LABEL,
            remote: env.RCLONE_REMOTE,
            dest: env.RCLONE_DEST,
            stageDir,
            uploaded,
        });

        const finishedAt = new Date().toISOString();
        finishBackupSuccess(id, { dbBytes, mediaFiles: media.files, mediaBytes: media.bytes, target: finalTarget, uploaded }, finishedAt);

        console.info(`[backup] 手动备份完成：${outputPath}（${dbBytes} bytes，上传=${uploaded}，清理=${prunedFiles}，去向=${finalTarget}）`);

        return {
            backup: {
                id,
                trigger,
                status: "success",
                dbBytes,
                mediaFiles: media.files,
                mediaBytes: media.bytes,
                target: finalTarget,
                uploaded,
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

// `uploadWithRclone` 与 `isMissingBinary` 已挪到 `./backup-target`（不依赖数据库，
// 才能在 Node 上被 verify 脚本真实 import 执行）。行为未改：ENOENT 仍然不算失败。

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
