/**
 * `backups` 表仓储。
 *
 * 这张表是**审计表**：容器内的 `deploy/backup/backup.sh`（cron）与
 * 服务端的 `POST /api/backups/run`（手动）都往这里写一行，
 * 设置页只 `GET /api/backups` 读。因此本文件的写入必须"终态可查"：
 * 先插 `running`，再改成 `success` / `failed`，绝不留下永远 running 的行。
 */

import { getDb } from "../client";

/** 触发来源（与 CHECK 约束一致）。 */
export type BackupTrigger = "cron" | "manual";

/** 状态（与 CHECK 约束一致）。 */
export type BackupStatus = "running" | "success" | "failed";

/** 备份行。 */
export type BackupRow = {
    id: string;
    trigger: BackupTrigger;
    status: BackupStatus;
    db_bytes: number | null;
    media_files: number | null;
    media_bytes: number | null;
    target: string | null;
    /**
     * 是否真的传到了远端（0003 迁移加的列）：1 = 已传 / 0 = 配了远端但没传成 /
     * NULL = 没配远端或还没轮到这一步。
     */
    uploaded: number | null;
    error_message: string | null;
    started_at: string;
    finished_at: string | null;
};

const SQL_INSERT = `
INSERT INTO backups (id, trigger, status, target, started_at)
VALUES (?, ?, 'running', ?, ?)
`;

const SQL_FINISH_SUCCESS = `
UPDATE backups
   SET status = 'success',
       db_bytes = ?,
       media_files = ?,
       media_bytes = ?,
       target = ?,
       uploaded = ?,
       error_message = NULL,
       finished_at = ?
 WHERE id = ?
`;

const SQL_FINISH_FAILED = `
UPDATE backups
   SET status = 'failed',
       db_bytes = ?,
       media_files = ?,
       media_bytes = ?,
       error_message = ?,
       finished_at = ?
 WHERE id = ?
`;

const SQL_LIST = `
SELECT * FROM backups
 ORDER BY started_at DESC
 LIMIT ?
`;

const SQL_LATEST = `
SELECT * FROM backups
 ORDER BY started_at DESC
 LIMIT 1
`;

const SQL_PRUNE = `
DELETE FROM backups
 WHERE finished_at IS NOT NULL
   AND finished_at < ?
`;

/** 建一条 running 记录。 */
export function insertBackupRun(id: string, trigger: BackupTrigger, target: string | null, startedAt: string): void {
    getDb().query(SQL_INSERT).run(id, trigger, target, startedAt);
}

/**
 * 标记成功。
 *
 * `uploaded` 三态见 `BackupRow.uploaded` 注释。它和 `target` 一起决定"这次备份
 * 到底去哪了"能不能自解释 —— 不能只写 target：配了远端但没传成时 target 会降级
 * 成 stageDir，而人工标签场景下 target 是用户写的字符串，两种情况都靠 uploaded
 * 才能真正说清有没有上远端。
 */
export function finishBackupSuccess(
    id: string,
    metrics: { dbBytes: number; mediaFiles: number; mediaBytes: number; target: string | null; uploaded: boolean | null },
    finishedAt: string,
): void {
    const uploaded = metrics.uploaded === null ? null : metrics.uploaded ? 1 : 0;
    getDb()
        .query(SQL_FINISH_SUCCESS)
        .run(metrics.dbBytes, metrics.mediaFiles, metrics.mediaBytes, metrics.target, uploaded, finishedAt, id);
}

/** 标记失败（错误信息截断到 500 字符，避免整段堆栈进表）。 */
export function finishBackupFailed(
    id: string,
    metrics: { dbBytes: number; mediaFiles: number; mediaBytes: number },
    errorMessage: string,
    finishedAt: string,
): void {
    getDb()
        .query(SQL_FINISH_FAILED)
        .run(metrics.dbBytes, metrics.mediaFiles, metrics.mediaBytes, errorMessage.slice(0, 500), finishedAt, id);
}

/** 列出最近的备份记录。 */
export function listBackups(limit = 20): BackupRow[] {
    return getDb().query(SQL_LIST).all(Math.min(Math.max(1, limit), 100)) as BackupRow[];
}

/** 最近一次备份（设置页顶部展示用）。 */
export function latestBackup(): BackupRow | null {
    return (getDb().query(SQL_LATEST).get() as BackupRow | null) ?? null;
}

/**
 * 清理过老的审计行。
 *
 * @param keepDays 保留天数（对应 `BACKUP_DB_KEEP_DAYS`）
 * @returns 删除行数
 */
export function pruneBackupRows(keepDays: number, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - Math.max(1, keepDays) * 86_400_000).toISOString();
    return Number(getDb().query(SQL_PRUNE).run(cutoff).changes);
}
