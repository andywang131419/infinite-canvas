/**
 * 服务端入口 —— **显式启动**（非 Next.js instrumentation 那种隐式钩子）。
 *
 * 启动顺序（顺序不可交换）：
 *   1. 校验环境变量（失败即退出，不留半启动状态）
 *   2. 建连 + 跑迁移（幂等；schema 必须先就位）
 *   3. 启动内嵌 Worker（此时 DB 已可用，未来 T03 的 claim 才安全）
 *   4. 监听端口（对外可用时，依赖项全部就绪）
 *
 * 停机顺序相反：先停止接受新请求 → 停 Worker（等在途任务）→ 关闭 DB。
 */

import { Hono } from "hono";

import { checkDbHealth, closeDb, getDb, getMigrationInfo } from "./db/client";
import { purgeSessions } from "./db/repos/sessions";
import { EnvValidationError, getEnv, type Env } from "./env";
import { handleError, handleNotFound } from "./http/respond";
import { registerAllHandlers } from "./jobs/handlers/index";
import { startWorker, stopWorker } from "./jobs/worker";
import { assetRoutes } from "./routes/assets";
import { authRoutes } from "./routes/auth";
import { backupRoutes } from "./routes/backups";
import { canvasRoutes } from "./routes/canvases";
import { channelRoutes } from "./routes/channels";
import { healthRoutes } from "./routes/health";
import { jobRoutes } from "./routes/jobs";
import { proxyRoutes } from "./routes/proxy";
import { setupRoutes } from "./routes/setup";

/** 构建 Hono 应用（不含副作用，便于测试直接 import）。 */
export function createApp(): Hono {
    const app = new Hono();

    app.onError(handleError);
    app.notFound(handleNotFound);

    /**
     * 路由挂载顺序（T03 起）：
     * - `/api/health*`    —— 不需鉴权（compose healthcheck 用）
     * - `/api/setup*`     —— 不需鉴权，但**仅 users 表为空时**才真正生效
     * - `/api/auth/*`     —— login 不需鉴权；logout / me 自行判断会话
     * - `/api/canvases/*` —— 全部 requireAuth
     * - `/api/assets/*`   —— 全部 requireAuth
     * - `/api/channels/*` —— 全部 requireAuth（owner 才能写）
     * - `/api/jobs*`      —— 全部 requireAuth
     * - `/api/proxy`      —— 全部 requireAuth + 白名单 + SSRF 防护
     * - `/api/backups*`   —— 全部 requireAuth（owner 才能手动触发）
     *
     * 注意：**没有**全局鉴权中间件。每个受保护路由自己挂 `requireAuth`，
     * 这样 grep 一次就能审计出全部受保护端点（见 auth/middleware.ts 注释）。
     */
    app.route("/api", healthRoutes);
    app.route("/api", setupRoutes);
    app.route("/api", authRoutes);
    app.route("/api", canvasRoutes);
    app.route("/api", assetRoutes);
    app.route("/api", channelRoutes);
    app.route("/api", jobRoutes);
    app.route("/api", proxyRoutes);
    app.route("/api", backupRoutes);

    return app;
}

/** 读取环境变量；校验失败时打印全部问题并直接退出，不留半启动状态。 */
function loadEnvOrExit(): Env {
    try {
        return getEnv();
    } catch (error) {
        if (error instanceof EnvValidationError) {
            console.error(error.message);
            process.exit(1);
        }
        throw error;
    }
}

async function main(): Promise<void> {
    // ---- 1. 环境变量 ----
    const env = loadEnvOrExit();

    console.info(`[boot] infinite-canvas server ${env.APP_VERSION} (env=${env.NODE_ENV})`);

    // ---- 2. 数据库 + 迁移 ----
    getDb();
    const migrations = getMigrationInfo();
    const health = checkDbHealth();
    console.info(
        `[boot] db=${health.status} path=${health.path} schema=v${migrations.version} journal=${health.journalMode} fk=${health.foreignKeys}`,
    );
    if (migrations.appliedNow.length > 0) {
        console.info(`[boot] 本次执行迁移：${migrations.appliedNow.join(", ")}`);
    } else {
        console.info(`[boot] 迁移已是最新（共 ${migrations.total} 个，无新增）`);
    }

    // 启动时顺手清理过期/已吊销的会话记录（幂等、极便宜，避免 sessions 表无限膨胀）。
    const purged = purgeSessions();
    if (purged > 0) console.info(`[boot] 清理过期会话 ${purged} 条`);

    // ---- 3. Worker ----
    // 注册 handler 必须在 startWorker 之前：Worker 只认已注册的类型，
    // 注册晚了会有"第一个 tick 找不到 handler"的窗口（任务被判 INTERNAL 失败）。
    registerAllHandlers();
    startWorker();

    // ---- 4. HTTP ----
    const app = createApp();
    const server = Bun.serve({
        port: env.HTTP_PORT,
        hostname: env.HTTP_HOST,
        fetch: app.fetch,
        /**
         * 取 Bun 允许的上限 255s。
         *
         * 为什么不用 0：不同 Bun 版本对 `idleTimeout: 0`（关闭空闲超时）的支持不一致，
         * 个别版本会直接抛错导致进程起不来。255s 是所有版本都接受的确定值。
         *
         * 副作用与对策：SSE（画布助手流式问答，Tier2）若超过 255s 无任何字节写出会被断开，
         * 因此 **T02/T03 实现 SSE 时必须周期性发送注释心跳**（`: keep-alive\n\n`）。
         * 上游等待上限由 Caddy `read_timeout 15m` 控制，与之不冲突。
         */
        idleTimeout: 255,
        /** 请求体上限：与 Caddy `request_body max_size` 对齐（图片/视频上传）。 */
        maxRequestBodySize: env.MAX_UPLOAD_MB * 1024 * 1024,
    });

    console.info(`[boot] listening on http://${server.hostname}:${server.port}`);
    console.info(`[boot] health: http://127.0.0.1:${server.port}/api/health`);

    // ---- 优雅停机 ----
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.info(`[shutdown] 收到 ${signal}，开始优雅停机`);

        try {
            // 先停止接受新连接，避免新请求打到正在关闭的 DB。
            await server.stop();
            await stopWorker();
            closeDb();
            console.info("[shutdown] 已干净退出");
            process.exit(0);
        } catch (error) {
            console.error("[shutdown] 停机过程中出错", error);
            process.exit(1);
        }
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// 仅在被直接执行时启动（`bun run src/index.ts`）；
// 被测试 import 时不产生副作用。
if (import.meta.main) {
    main().catch((error) => {
        console.error("[boot] 启动失败：", error);
        process.exit(1);
    });
}
