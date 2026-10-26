/**
 * `/api/assets/*` —— 资产二进制读写。
 *
 * 三个端点（T02 第 5 条）：
 *   PUT    /api/assets?key=<storageKey>   上传（body 为原始字节）
 *   GET    /api/assets/raw?key=<storageKey>  读取（**支持 Range/206 + ETag**）
 *   DELETE /api/assets?key=<storageKey>   删除
 *
 * Range 为什么必须做对：
 * 视频节点的 `<video src>` 会先发 `Range: bytes=0-` 做渐进播放，
 * 服务端若不返回 206 + `Accept-Ranges: bytes`，Safari 会直接黑屏、
 * Chrome 会退化成"整包下载后才能拖进度"。
 *
 * 鉴权用 Cookie（同站请求天然带 `ic_session`），
 * 因此 `<img src="/api/assets/raw?key=...">` 这种"浏览器直接发起的请求"也能通过，
 * 不需要把 token 拼进 URL（那样会泄漏在 Referer / 日志里）。
 */

import { Hono } from "hono";
import type { Handler } from "hono";

import { currentUser, requireAuth, type AuthVariables } from "../auth/middleware";
import { ApiError } from "../http/errors";
import { ok } from "../http/respond";
import { openAsset, putAsset, removeAsset } from "../services/asset-service";
import type { AssetRow } from "../db/repos/assets";

/** 受保护路由的 handler 类型（避免手写 `Context<{Variables: ...}>`）。 */
type AuthedHandler = Handler<{ Variables: AuthVariables }>;

export const assetRoutes = new Hono<{ Variables: AuthVariables }>();

assetRoutes.use("*", requireAuth);

/** 资产的对外 DTO（**不暴露**物理路径与物理存储细节）。 */
export type AssetDto = {
    id: string;
    storageKey: string;
    kind: string;
    mime: string;
    bytes: number;
    sha256: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    canvasId: string | null;
    createdAt: string;
    /** 前端可直接用于 `<img src>` / `<video src>` 的地址。 */
    url: string;
};

/** 行 → DTO。 */
function toAssetDto(row: AssetRow): AssetDto {
    return {
        id: row.id,
        storageKey: row.storage_key,
        kind: row.kind,
        mime: row.mime,
        bytes: row.bytes,
        sha256: row.sha256,
        width: row.width,
        height: row.height,
        durationMs: row.duration_ms,
        canvasId: row.canvas_id,
        createdAt: row.created_at,
        url: `/api/assets/raw?key=${encodeURIComponent(row.storage_key)}`,
    };
}

/**
 * 上传。
 *
 * Query：`key`（必填，严格校验）、`canvasId`（可选）
 * Header：`Content-Type`（决定扩展名与落库 mime）
 *
 * 错误：400 非法 key / 413 超出 `MAX_UPLOAD_MB` / 409 键被占用
 */
assetRoutes.put("/assets", async (c) => {
    const user = currentUser(c);

    const key = c.req.query("key");
    const canvasId = c.req.query("canvasId") ?? null;
    const declaredMime = c.req.header("content-type") ?? "application/octet-stream";

    const bytes = new Uint8Array(await c.req.arrayBuffer());

    const row = await putAsset(user.id, key, bytes, declaredMime, canvasId);

    return ok(c, { asset: toAssetDto(row) });
});

/**
 * 读取（`GET` / `HEAD`，支持 Range）。
 *
 * 响应头：
 * - `Accept-Ranges: bytes`
 * - `ETag: "<sha256>"`（内容寻址 → 强 ETag，永不变）
 * - `Cache-Control: private, max-age=31536000, immutable`
 *   （内容不可变，可长期缓存；`private` 防止 CDN/代理跨用户共享）
 * - 206 时额外带 `Content-Range: bytes start-end/size`
 *
 * `If-None-Match` 命中 → 304，**不返回 body**。
 */
const serveAsset: AuthedHandler = async (c) => {
    const user = currentUser(c);

    const key = c.req.query("key");
    const opened = await openAsset(user.id, key, c.req.header("range"));

    const etag = `"${opened.row.sha256}"`;

    // 强校验：客户端已有完全相同的内容 → 304。
    if (matchesEtag(c.req.header("if-none-match"), etag)) {
        c.header("ETag", etag);
        c.header("Cache-Control", "private, max-age=31536000, immutable");
        return c.body(null, 304);
    }

    const start = opened.range.start;
    const end = opened.range.end ?? opened.size;
    const length = Math.max(0, end - start);

    const headers = new Headers({
        "Content-Type": opened.row.mime || "application/octet-stream",
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
        ETag: etag,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
    });

    if (opened.partial) {
        // Content-Range 的 end 是**闭**区间，内部用开区间 → 减 1。
        headers.set("Content-Range", `bytes ${start}-${end - 1}/${opened.size}`);
    }

    const status = opened.partial ? 206 : 200;

    // HEAD：只要头部，不消费字节流（也不能消费，否则会白读一遍磁盘）。
    if (c.req.method === "HEAD") {
        return new Response(null, { status, headers });
    }

    return new Response(opened.stream, { status, headers });
};

// 逐个方法注册（不用 `on(["GET","HEAD"], ...)` 数组形式）：
// Hono 的 `on()` 类型签名是单方法字符串，数组形式在部分版本上会报类型错。
assetRoutes.on("GET", "/assets/raw", serveAsset);
assetRoutes.on("HEAD", "/assets/raw", serveAsset);
assetRoutes.on("GET", "/assets", serveAsset);
assetRoutes.on("HEAD", "/assets", serveAsset);

/**
 * 删除。
 *
 * 两条路径都支持：
 * - `DELETE /api/assets?key=`（与 PUT 对称）
 * - `DELETE /api/assets/raw?key=`（与 GET 对称）
 *
 * 语义：先删元数据行；确认没有其它行引用同一内容后，才删物理文件。
 */
const deleteAsset: AuthedHandler = async (c) => {
    const user = currentUser(c);

    const removed = await removeAsset(user.id, c.req.query("key"));
    if (!removed) throw ApiError.notFound("资产不存在");

    return c.body(null, 204);
};

assetRoutes.delete("/assets", deleteAsset);
assetRoutes.delete("/assets/raw", deleteAsset);

/**
 * `If-None-Match` 是否命中给定 ETag。
 *
 * 兼容：`*`、弱前缀 `W/"..."`、逗号分隔的多个值。
 */
export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
    if (!ifNoneMatch) return false;
    const normalized = ifNoneMatch.trim();
    if (normalized === "*") return true;

    return normalized.split(",").some((candidate) => {
        const value = candidate.trim().replace(/^W\//, "");
        return value === etag;
    });
}
