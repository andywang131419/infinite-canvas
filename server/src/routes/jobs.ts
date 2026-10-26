/**
 * `/api/jobs` —— 异步任务入口。
 *
 * 关键契约（T03 第 B 条）：
 * - `POST /api/jobs` 必须 **< 300ms** 返回 `202 + jobId`；
 *   这里在实现上保证：只有一次画布归属查询 + 一次 INSERT，没有任何上游调用；
 * - `GET /api/jobs?canvasId=&open=true` 给"重新打开画布"时恢复 loading 态用；
 * - `GET /api/jobs/:id` 给轮询单任务用（前端按 1~2s 轮询，直到终态）。
 *
 * 幂等：`POST` 命中 `idempotencyKey` 时返回 **200**（不是 202），
 * `data.created === false`，前端据此知道"这次没有真的新建任务"。
 */

import { Hono } from "hono";

import { currentUser, requireAuth, type AuthVariables } from "../auth/middleware";
import { getEnv } from "../env";
import { readJsonBody } from "../http/request";
import { ok } from "../http/respond";
import { cancelJobForUser, createJobForUser, getJobForUser, listJobsForUser } from "../services/job-service";

export const jobRoutes = new Hono<{ Variables: AuthVariables }>();

jobRoutes.use("*", requireAuth);

/** 入队请求体上限（params 上限 64KB，这里给 4 倍余量）。 */
function jobBodyLimit(): number {
    return Math.max(256 * 1024, getEnv().MAX_DOC_JSON_MB * 1024);
}

/** 超过这个耗时就在日志里点名（不影响响应，只用于持续观察 300ms 预算）。 */
const SLOW_ENQUEUE_MS = 300;

/**
 * 建任务 → `202 Accepted`。
 *
 * 为什么是 202 而不是 201：任务资源"已接受但未完成"，
 * 前端拿到 202 + jobId 后去轮询 `GET /api/jobs/:id`。
 */
jobRoutes.post("/jobs", async (c) => {
    const startedAt = Date.now();
    const user = currentUser(c);
    const body = await readJsonBody<unknown>(c, jobBodyLimit());

    const { job, created } = createJobForUser(user, body);

    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_ENQUEUE_MS) {
        console.warn(`[jobs] POST /api/jobs 耗时 ${elapsed}ms，超过 ${SLOW_ENQUEUE_MS}ms 预算（type=${job.type}）`);
    }

    // 命中幂等键 → 200（"这个任务早就存在"），新建 → 202（"已接受，去轮询"）。
    return ok(c, { job, created, jobId: job.id }, created ? 202 : 200);
});

/**
 * 列任务。
 *
 * Query：
 * - `canvasId`（必填）：限定画布；
 * - `open=true`：只要 `queued|running`（画布重新打开时恢复 loading 态）；
 * - `limit`：默认 50，上限 200。
 */
jobRoutes.get("/jobs", (c) => {
    const user = currentUser(c);

    const canvasId = (c.req.query("canvasId") ?? "").trim();
    if (!canvasId) {
        return ok(c, { items: [], total: 0 }, 200);
    }

    const openOnly = c.req.query("open") === "true";
    const limit = Number(c.req.query("limit") ?? "50");
    const items = listJobsForUser(user, canvasId, openOnly, Number.isFinite(limit) ? limit : 50);

    return ok(c, { items, total: items.length });
});

/** 单个任务（前端轮询点）。 */
jobRoutes.get("/jobs/:id", (c) => {
    const user = currentUser(c);
    return ok(c, { job: getJobForUser(user, c.req.param("id")) });
});

/** 取消任务（只允许自己的、且未终态）。 */
jobRoutes.delete("/jobs/:id", (c) => {
    const user = currentUser(c);
    return ok(c, { job: cancelJobForUser(user, c.req.param("id")) });
});
