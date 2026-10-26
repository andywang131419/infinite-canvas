/**
 * `/api/backups` —— 备份记录与手动触发。
 *
 * 权限：只有 `owner` 能触发手动备份；`member` 可以查列表
 * （让他知道"数据有备份"，但不给他触发 IO 密集操作的能力）。
 *
 * 并发保护：进程内互斥。手动点击两次不应该同时跑两个 `VACUUM INTO`
 * （会互相抢锁，且可能生成两份几乎相同的快照）。跨进程的并发
 * （手动 + cron 容器）由 SQLite 的 busy_timeout 与"两份文件不同名"兜住。
 */

import { Hono } from "hono";

import { currentUser, requireAuth, type AuthVariables } from "../auth/middleware";
import { ApiError } from "../http/errors";
import { ok } from "../http/respond";
import { listBackupDtos, runBackup } from "../services/backup-service";

export const backupRoutes = new Hono<{ Variables: AuthVariables }>();

backupRoutes.use("*", requireAuth);

/** 进程内互斥标记（手动备份同一时刻只允许一个）。 */
let manualRunning = false;

/** 备份列表（倒序）+ 最近一次摘要。 */
backupRoutes.get("/backups", (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    const { items, latest } = listBackupDtos(Number.isFinite(limit) ? limit : 20);
    return ok(c, { items, total: items.length, latest });
});

/**
 * 手动触发一次备份。
 *
 * 同步执行（`VACUUM INTO` + gzip 通常几百毫秒到几秒），
 * 直接返回结果：管理员点一下就能看到"生成了哪个文件、多大"。
 * 若将来库大到几十 GB，再改成"投递任务 + 轮询"。
 */
backupRoutes.post("/backups/run", async (c) => {
    const user = currentUser(c);
    if (user.role !== "owner") {
        throw new ApiError("FORBIDDEN", "只有管理员可以触发手动备份");
    }

    if (manualRunning) {
        throw new ApiError("IDEMPOTENCY_DUPLICATE", "上一次手动备份尚未结束，请稍后再试");
    }

    manualRunning = true;
    try {
        const result = await runBackup("manual");
        return ok(c, result, 201);
    } finally {
        manualRunning = false;
    }
});
