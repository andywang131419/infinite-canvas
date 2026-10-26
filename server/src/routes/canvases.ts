/**
 * `/api/canvases/*` —— 画布 CRUD + 乐观锁。
 *
 * 路由层**只做**三件事：取参数、调 service、包信封。
 * 所有业务判断（404/409/413）都在 `services/canvas-service.ts` 里，
 * 这样同一套规则可以被脚本、测试、未来的 CLI 复用。
 *
 * 全部端点都挂 `requireAuth`（审计方式：grep `requireAuth`）。
 */

import { Hono } from "hono";

import { currentUser, requireAuth, type AuthVariables } from "../auth/middleware";
import { getEnv } from "../env";
import { readJsonBody } from "../http/request";
import { ok } from "../http/respond";
import { deleteCanvas, getCanvasDetail, getCanvasList, getCanvasRevision, putCanvas } from "../services/canvas-service";

export const canvasRoutes = new Hono<{ Variables: AuthVariables }>();

canvasRoutes.use("*", requireAuth);

/**
 * 画布 PUT 的**请求体**上限。
 *
 * 关键点：这里刻意用 `MAX_UPLOAD_MB`（默认 200MB）而不是 `MAX_DOC_JSON_MB`（8MB）。
 *
 * 原因：带内联 base64 的画布 JSON 在**清洗前**可能非常大（一张 4MB 的 PNG
 * base64 后约 5.3MB，三张就超 8MB）。如果在这里按 8MB 拦住，
 * 那么"带内联图的画布"将永远无法保存 —— 而清洗恰恰就是为了救这种画布。
 *
 * 因此分两道闸：
 *   1. 传输闸：`MAX_UPLOAD_MB`（防内存爆掉）；
 *   2. 落库闸：清洗**之后**量体积，超 `MAX_DOC_JSON_MB` 才 413。
 *
 * 两道闸都在 `putCanvas` 里：第 1 道由本文件传入的 limit 控制，
 * 第 2 道由 `docByteLimit()` 控制。
 */
function canvasBodyLimit(): number {
    return getEnv().MAX_UPLOAD_MB * 1024 * 1024;
}

/**
 * 画布列表（不含 doc）。
 *
 * Query：`?limit=100&offset=0`（limit 上限 200，越界自动夹紧，不报错）。
 */
canvasRoutes.get("/canvases", (c) => {
    const user = currentUser(c);

    const limit = Number(c.req.query("limit") ?? "100");
    const offset = Number(c.req.query("offset") ?? "0");

    const items = getCanvasList(user.id, Number.isFinite(limit) ? limit : 100, Number.isFinite(offset) ? offset : 0);

    return ok(c, { items, total: items.length });
});

/**
 * 画布详情 —— **一次返回 `canvas` + `openJobs`**。
 *
 * 前端打开画布只需要这一个请求：省去"取 doc"再"取任务"的第二个 RTT，
 * 也避免了"doc 到了但任务还没到"的中间态渲染。
 */
canvasRoutes.get("/canvases/:id", (c) => {
    const user = currentUser(c);
    const { canvas, openJobs } = getCanvasDetail(user.id, c.req.param("id"));

    return ok(c, { canvas, openJobs });
});

/**
 * 轻量版本探针 —— **不读 doc**。
 *
 * 供前端在"切回标签页 / 定时轮询"时判断要不要重新拉取。
 */
canvasRoutes.get("/canvases/:id/revision", (c) => {
    const user = currentUser(c);
    const revision = getCanvasRevision(user.id, c.req.param("id"));

    return ok(c, revision);
});

/**
 * 保存画布（乐观锁）。
 *
 * body：`{ baseRevision, doc, title?, deviceLabel? }`
 *
 * - `baseRevision = 0` → 新建（`revision` 从 1 开始）；
 * - `baseRevision >= 1` → 单条 CAS UPDATE；
 * - `changes = 0` → 409 `REVISION_CONFLICT`，`details` 里带 `latestDoc`。
 */
canvasRoutes.put("/canvases/:id", async (c) => {
    const user = currentUser(c);
    const body = await readJsonBody<unknown>(c, canvasBodyLimit());

    const result = await putCanvas(user, c.req.param("id"), body);

    // 清洗统计里如果有丢失（dropped），在响应头里透出，便于排查"为什么图没了"。
    if (result.sanitize.dropped > 0) {
        c.header("x-doc-dropped", String(result.sanitize.dropped));
    }

    return ok(c, result, result.created ? 201 : 200);
});

/** 软删画布（`deleted_at` 置位）。重复删除返回 404（幂等语义）。 */
canvasRoutes.delete("/canvases/:id", (c) => {
    const user = currentUser(c);
    deleteCanvas(user.id, c.req.param("id"));

    return c.body(null, 204);
});
