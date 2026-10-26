/**
 * `/api/health` —— 健康探针。
 *
 * 用途（ARCH §R8 T01 验收标准）：
 * 1. `docker compose` 的 server healthcheck 打这个地址
 * 2. Caddy `depends_on: service_healthy` 的依据
 * 3. 人工确认「空主机 up 起来后 db / worker / backup 三件套状态」
 *
 * 该路由**不需要鉴权**（§4.0 白名单：`/api/auth/login`、`/api/health`）。
 * 因为同域访问，天然没有 CORS 预检（§R2.4 验收要求）。
 */

import { Hono } from "hono";

import { checkDbHealth, getMigrationInfo } from "../db/client";
import { getEnv } from "../env";
import { ApiError } from "../http/errors";
import { fail, ok } from "../http/respond";
import { getWorkerStatus } from "../jobs/worker";

export const healthRoutes = new Hono();

/** 进程启动时刻（模块首次加载时间），用于计算 uptime。 */
const processStartedAt = Date.now();

healthRoutes.get("/health", (c) => {
    const env = getEnv();
    const db = checkDbHealth();
    const worker = getWorkerStatus();
    const migrations = getMigrationInfo();

    // DB 不可用 = 服务实质不可用 → 503，让 compose healthcheck 正确判定失败。
    if (db.status !== "ok") {
        return fail(c, new ApiError("INTERNAL", "数据库不可用", { db }));
    }

    return ok(c, {
        /** 应用版本（APP_VERSION，默认 0.20.0-fork.1）。 */
        version: env.APP_VERSION,
        /** 数据库状态；验收要求为 "ok"。 */
        db: "ok",
        /** Worker 状态：running / idle / stopping / stopped / disabled。 */
        worker: worker.enabled ? worker.state : "disabled",
        /** 备份开关（实际执行在 backup 容器，这里只反映配置）。 */
        backup: env.BACKUP_ENABLED ? "enabled" : "disabled",
        /** 运行环境。 */
        env: env.NODE_ENV,
        /** 进程已运行毫秒数。 */
        uptimeMs: Date.now() - processStartedAt,
        /** 服务端时间（ISO8601 UTC）。 */
        time: new Date().toISOString(),
        /** 数据库细节，便于排障。 */
        database: {
            schemaVersion: db.schemaVersion,
            journalMode: db.journalMode,
            foreignKeys: db.foreignKeys,
            migrationsTotal: migrations.total,
            migrationsAppliedOnBoot: migrations.appliedNow,
        },
        /** Worker 细节。 */
        workerDetail: {
            concurrency: worker.concurrency,
            pollMs: worker.pollMs,
            inFlight: worker.inFlight,
            ticks: worker.ticks,
            registeredTypes: worker.registeredTypes,
        },
    });
});

/** 轻量存活探针：只证明事件循环还活着，不碰 DB（供 Caddy / 编排用）。 */
healthRoutes.get("/health/live", (c) => ok(c, { alive: true, uptimeMs: Date.now() - processStartedAt }));

/** 就绪探针：DB 可用才 200。 */
healthRoutes.get("/health/ready", (c) => {
    const db = checkDbHealth();
    if (db.status !== "ok") {
        return fail(c, new ApiError("INTERNAL", "数据库未就绪", { db }));
    }
    return ok(c, { ready: true, schemaVersion: db.schemaVersion });
});
