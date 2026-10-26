#!/usr/bin/env node
/**
 * P0-1 回归测试：**首次保存画布时内联图片必须真的落库**。
 *
 * ---------------------------------------------------------------------------
 * 这条测试的特殊之处：它跑的是**真实代码路径**，不是复刻
 * ---------------------------------------------------------------------------
 * `verify-t02.mjs` 的 doc 清洗用例用的是 `fakeIngest`（只返回一个假 storageKey），
 * 从不碰数据库，因此完全覆盖不到 P0-1：
 *
 *   `putCanvas(baseRevision=0)` 的执行顺序是「先清洗（会写 assets 行）→ 后 insertCanvas」，
 *   而 `assets.canvas_id` 是**立即生效**的外键（`PRAGMA foreign_keys = ON`）。
 *   只要清洗时把 canvasId 绑成"尚未插入的画布 id"，每一次 `INSERT INTO assets`
 *   都会 `FOREIGN KEY constraint failed` → 异常被 `tryIngest` 的 catch 吞掉 →
 *   `content` 被置空 + `dropped += 1`，但接口**仍然返回 201**。
 *   表现为"第一次存就少图，存第二次又好了"，极难排查。
 *
 * 所以这里刻意做到：
 *   - 用 `node:module` 的 `registerHooks()` 把 `bun:sqlite` 重定向到
 *     `scripts/bun-sqlite-shim.mjs`，从而 **import 真实的 `db/client.ts`**；
 *   - 真实执行 `migrations/0001_init.sql`（走 `db/client.ts` 的迁移执行器，
 *     含 pragma / checksum / schema_migrations 全流程）；
 *   - 真实调用 `canvas-service.putCanvas` → 真实 `asset-service.ingestAssetBytes`
 *     → 真实 `db/repos/assets.upsertAsset` → 真实 `LocalDiskDriver` 写盘。
 *
 * 断言（对应 team-lead 要求的 ①②③）：
 *   ① `assets.canvas_id` 允许 NULL，且「新建时传 null」这条路真的写进去了；
 *   ② `stats.dropped === 0`（一张图都没丢），`stats.extracted === 1`；
 *   ③ 清洗后的 doc 里节点拿到了**非空 storageKey**，且磁盘上真有那个文件。
 *
 * 顺带回归：P2-2（CAS 用 COALESCE 保留已有标题）、P2-6（openJobs 按 owner 过滤）。
 *
 * 运行：node scripts/verify-fix-p01.mjs
 * 退出码：0 = 全绿；1 = 有失败项。
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 0. 模块解析钩子：`bun:sqlite` → 垫片；无扩展名相对导入 → `.ts`
//
// 两件事都只服务于"让真实源码能在 Node 上跑"：
//   1. 本项目按 Bun 的习惯写 `import ... from "../env"`（不带扩展名），
//      而 Node 的 ESM 解析器不做"无后缀 → .ts"补全；
//   2. `bun:sqlite` 是 Bun 内置模块。
// tsc 的类型检查仍然覆盖真实源码（见 `npm run typecheck`），这里只是运行时适配。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const shimUrl = pathToFileURL(join(here, "bun-sqlite-shim.mjs")).href;

/** 源码里可能出现的扩展名。 */
const SOURCE_EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs"];

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "bun:sqlite") {
            return { url: shimUrl, format: "module", shortCircuit: true };
        }

        const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
        const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier);
        if (isRelative && !hasExtension && context.parentURL) {
            const base = new URL(specifier, context.parentURL);
            for (const extension of SOURCE_EXTENSIONS) {
                const candidate = new URL(base.href + extension);
                if (existsSync(fileURLToPath(candidate))) {
                    return { url: candidate.href, shortCircuit: true };
                }
            }
            const indexCandidate = new URL(`${base.href}/index.ts`);
            if (existsSync(fileURLToPath(indexCandidate))) {
                return { url: indexCandidate.href, shortCircuit: true };
            }
        }

        return nextResolve(specifier, context);
    },
});

// ---------------------------------------------------------------------------
// 迷你断言框架（与 verify-t02 / verify-t03 保持一致的手感）
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failures.push({ name, message: error?.message ?? String(error) });
        console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function section(title) {
    console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 1. 准备隔离环境（临时目录 + 环境变量）
// ---------------------------------------------------------------------------

const workDir = await mkdtemp(join(tmpdir(), "ic-p01-"));
const dbPath = join(workDir, "app.db");
const mediaRoot = join(workDir, "media");

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = dbPath;
process.env.STORAGE_LOCAL_ROOT = mediaRoot;
process.env.STORAGE_DRIVER = "local";
process.env.AUTH_SECRET = "verify-fix-p01-secret-0123456789abcdef";
process.env.COOKIE_SECURE = "false";
process.env.WORKER_ENABLED = "false";
process.env.MIGRATIONS_DIR = "migrations";

const { closeDb, getDb, getMigrationInfo } = await import("../src/db/client.ts");
const { countCanvases, putCanvas } = await import("../src/services/canvas-service.ts");
const { listOpenJobs } = await import("../src/db/repos/canvases.ts");
const { findAssetByStorageKey, listAssetsByCanvas } = await import("../src/db/repos/assets.ts");

section("[1] 真实 db/client.ts + 真实 0001_init.sql（node:sqlite 经 bun:sqlite 垫片）");

const db = getDb();

await check("迁移由真实执行器跑完（schema_migrations 有记录）", () => {
    const info = getMigrationInfo();
    assert(info.total >= 1, `磁盘上应至少有 1 个迁移文件，实际 ${info.total}`);
    assert(
        info.appliedNow.some((name) => name.startsWith("0001_")),
        `本次应实际执行 0001_*.sql，实际：${JSON.stringify(info.appliedNow)}`,
    );
    // 不写死版本号，而是断言「执行器把找到的迁移全部跑完了」。
    // 这样新增 0002（幂等键按用户隔离 + backups.media_expected）之后不用改这里，
    // 但若某个迁移没被应用（比如文件命名不合规范被跳过）就会被抓到。
    assertEqual(info.version, info.total, "schema 版本应与磁盘上的迁移文件数一致（有迁移没被应用）");
    assert(info.appliedNow.some((name) => name.startsWith("0002_")), `本次应实际执行 0002_*.sql，实际：${JSON.stringify(info.appliedNow)}`);
});

await check("外键真的开着（P0-1 的成因前提）", () => {
    const row = db.query("PRAGMA foreign_keys").get();
    assertEqual(row.foreign_keys, 1, "foreign_keys 必须为 ON，否则本测试失去意义");
});

await check("journal_mode 为 WAL（client.ts 的 pragma 生效）", () => {
    const row = db.query("PRAGMA journal_mode").get();
    assertEqual(String(row.journal_mode).toLowerCase(), "wal", "journal_mode 不是 WAL");
});

// ---------------------------------------------------------------------------
// 2. 复现 P0-1 的机理：绑定一个"尚不存在的画布 id"必然外键失败
// ---------------------------------------------------------------------------

section("[2] 成因验证：assets.canvas_id 指向不存在的画布 → FOREIGN KEY constraint failed");

const nowIso = new Date().toISOString();

await check("users 行就绪（后续 canvases.owner_id 的外键依赖它）", () => {
    db.query(
        "INSERT INTO users (id, email, password_hash, role, is_disabled, created_at, updated_at) VALUES (?, ?, ?, 'owner', 0, ?, ?)",
    ).run("u_p01", "p01@local", "$argon2id$fake", nowIso, nowIso);
    const row = db.query("SELECT COUNT(*) AS total FROM users").get();
    assertEqual(row.total, 1, "用户未插入");
});

await check("canvas_id 绑定一个不存在的画布 → 插入 assets 抛外键错误（= 线上丢图的直接原因）", () => {
    let message = "";
    try {
        db.query(
            "INSERT INTO assets (id, owner_id, canvas_id, kind, storage_driver, storage_key, mime, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("a_bad", "u_p01", "cvNOTEXIST", "image", "local", "image:BADBADBADBADBADB", "image/png", 10, "a".repeat(64), nowIso);
    } catch (error) {
        message = error?.message ?? String(error);
    }
    assert(/FOREIGN KEY constraint failed/i.test(message), `期望外键失败，实际：${JSON.stringify(message)}`);
});

await check("canvas_id = NULL → 插入 assets 成功（修复方案的前提成立）", () => {
    db.query(
        "INSERT INTO assets (id, owner_id, canvas_id, kind, storage_driver, storage_key, mime, bytes, sha256, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
    ).run("a_null", "u_p01", "image", "local", "image:NULLOKNULLOKNULLO", "image/png", 10, "b".repeat(64), nowIso);
    const row = db.query("SELECT canvas_id FROM assets WHERE id = 'a_null'").get();
    assert(row !== undefined, "资产未写入");
    assertEqual(row.canvas_id, null, "canvas_id 应为 NULL");
});

// 清掉机理验证用的两行，避免污染后面的真实流程断言。
db.query("DELETE FROM assets WHERE id IN ('a_bad', 'a_null')").run();

// ---------------------------------------------------------------------------
// 3. 真实 putCanvas(baseRevision = 0)：内联图片必须真的落成资产
// ---------------------------------------------------------------------------

section("[3] 真实 putCanvas(baseRevision=0)：内联 base64 → assets 行 + 磁盘文件");

/** 一个 16 字节的 PNG 头（足够被识别为 image/png，且不依赖任何外部文件）。 */
const pngBase64 = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const dataUrl = `data:image/png;base64,${pngBase64}`;

const CANVAS_ID = "cvP01FirstSave";
const user = { id: "u_p01", email: "p01@local", displayName: null, role: "owner" };

/** 首次保存的 doc：图片节点 + 文本节点（顺带回归 P2-3：文本正文不能被清）。 */
function buildFirstDoc() {
    return {
        id: CANVAS_ID,
        title: "我的画布",
        nodes: [
            { id: "n1", type: "image", title: "图1", metadata: { content: dataUrl, mimeType: "image/png" } },
            { id: "n2", type: "text", title: "笔记", metadata: { content: "blob:abc 是我的笔记正文" } },
        ],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
}

const firstResult = await putCanvas(user, CANVAS_ID, { baseRevision: 0, doc: buildFirstDoc(), title: "我的画布" });

await check("① 返回 created=true，图片没有被丢弃（dropped === 0）", () => {
    assertEqual(firstResult.created, true, "应走新建分支");
    assertEqual(firstResult.sanitize.dropped, 0, `不应有任何 data URL 被丢弃，warnings=${JSON.stringify(firstResult.sanitize.warnings)}`);
    assertEqual(firstResult.sanitize.extracted, 1, "应恰好提取 1 张内联图");
});

await check("②/③ assets 行写入成功，canvas_id 为 NULL，storageKey 是合法逻辑键", () => {
    const row = db.query("SELECT owner_id, canvas_id, storage_key, kind, mime, bytes, sha256 FROM assets").get();
    assert(row !== undefined, "assets 表里没有行 —— 内联图片没有落库（P0-1 复现）");
    assertEqual(row.canvas_id, null, "新建阶段 canvas_id 应为 NULL（不绑定尚不存在的画布）");
    assertEqual(row.owner_id, "u_p01", "owner_id 不对");
    assert(/^image:[A-Za-z0-9_-]{1,64}$/.test(row.storage_key), `storageKey 形状不合法：${row.storage_key}`);
    assertEqual(row.kind, "image", "kind 不对");
    assertEqual(row.mime, "image/png", "mime 不对");
    assertEqual(row.bytes, 16, "字节数不对");
    assertEqual(row.sha256.length, 64, "sha256 长度不对");
});

await check("③ 落库的 doc 里节点拿到非空 storageKey，且不再含 base64", () => {
    const row = db.query("SELECT doc, node_count, title FROM canvases WHERE id = ?").get(CANVAS_ID);
    assert(row !== undefined, "画布未写入");
    const doc = JSON.parse(row.doc);
    assertEqual(row.node_count, 2, "node_count 不对");
    assertEqual(row.title, "我的画布", "title 不对");
    assertEqual(doc.nodes[0].metadata.content, "", "图片节点 content 应置空");
    assert(/^image:/.test(doc.nodes[0].metadata.storageKey), "图片节点未拿到 storageKey");
    assert(!row.doc.includes(";base64,"), "doc 里仍有内联 base64");
    // P2-3 回归：文本节点的正文（以 blob: 开头）绝不能被当成死链清空。
    assertEqual(doc.nodes[1].metadata.content, "blob:abc 是我的笔记正文", "文本节点正文被误清空（P2-3 回归）");
});

await check("③ 磁盘上真的有那个文件（内容寻址路径 {yyyy}/{mm}/{sha256}.png）", async () => {
    const row = db.query("SELECT sha256 FROM assets").get();
    const dirs = await readdir(mediaRoot, { recursive: true });
    const files = dirs.filter((entry) => String(entry).endsWith(".png"));
    assert(files.length === 1, `媒体目录里应恰好 1 个 png，实际 ${files.length}：${JSON.stringify(dirs)}`);
    assert(String(files[0]).includes(row.sha256), `文件名应含 sha256：${files[0]} vs ${row.sha256}`);
    const info = await stat(join(mediaRoot, String(files[0])));
    assertEqual(info.size, 16, "落盘字节数不对");
});

await check("按画布列举资产：新建阶段没绑定 canvas_id，所以按画布查为空（已知取舍）", () => {
    const rows = listAssetsByCanvas("u_p01", CANVAS_ID);
    assertEqual(rows.length, 0, "canvas_id 为 NULL 的资产不应出现在按画布列举里");
});

// ---------------------------------------------------------------------------
// 4. 真实 putCanvas(baseRevision=1)：标题不被覆盖（P2-2）+ 资产绑定画布
// ---------------------------------------------------------------------------

section("[4] 真实 putCanvas(baseRevision=1)：COALESCE 保留标题 + 第二张图绑定画布");

/** 第二张图（不同字节，避免内容去重命中）。 */
const png2Base64 = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex").toString("base64");

const secondResult = await putCanvas(user, CANVAS_ID, {
    baseRevision: 1,
    // 注意：**故意不带 title**，且 doc 里也不带 title
    doc: {
        id: CANVAS_ID,
        nodes: [
            { id: "n1", type: "image", metadata: { content: dataUrl } },
            { id: "n3", type: "image", metadata: { content: `data:image/png;base64,${png2Base64}` } },
        ],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
    },
});

await check("更新成功且 revision 递增到 2", () => {
    assertEqual(secondResult.created, false, "应走更新分支");
    assertEqual(secondResult.canvas.revision, 2, "revision 未递增");
});

await check("P2-2：请求没带 title 时，用户起好的标题不被覆盖", () => {
    const row = db.query("SELECT title FROM canvases WHERE id = ?").get(CANVAS_ID);
    assertEqual(row.title, "我的画布", "库里标题被覆盖成默认值");
    assertEqual(secondResult.canvas.title, "我的画布", "响应里的标题应与库里一致");
});

await check("更新阶段新资产绑定到画布（canvas_id = 画布 id）", () => {
    const rows = listAssetsByCanvas("u_p01", CANVAS_ID);
    assertEqual(rows.length, 1, `应恰好 1 个资产绑到画布，实际 ${rows.length}`);
    assertEqual(rows[0].canvas_id, CANVAS_ID, "canvas_id 未绑定");
    assertEqual(rows[0].mime, "image/png", "mime 不对");
});

await check("内容去重：第一张图重复出现时不会新增资产行", () => {
    const row = db.query("SELECT COUNT(*) AS total FROM assets").get();
    assertEqual(row.total, 2, `应只有 2 行资产（首次 1 + 更新 1），实际 ${row.total}`);
    const first = findAssetByStorageKey(
        db.query("SELECT storage_key FROM assets ORDER BY created_at ASC LIMIT 1").get().storage_key,
    );
    assert(first !== null, "按 key 回读失败");
});

// ---------------------------------------------------------------------------
// 5. P2-6 回归：openJobs 的 owner 过滤下沉到 SQL
// ---------------------------------------------------------------------------

section("[5] P2-6 回归：listOpenJobs 按 owner 过滤（不再依赖调用顺序）");

await check("为他人画布/他人任务查 openJobs 查不到数据", () => {
    // 另一个用户 + 另一张画布 + 一条 queued 任务
    db.query(
        "INSERT INTO users (id, email, password_hash, role, is_disabled, created_at, updated_at) VALUES (?, ?, ?, 'member', 0, ?, ?)",
    ).run("u_other", "other@local", "$argon2id$fake", nowIso, nowIso);
    db.query(
        "INSERT INTO canvases (id, owner_id, title, doc, revision, node_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)",
    ).run("cvOther", "u_other", "别人的画布", JSON.stringify({ nodes: [] }), nowIso, nowIso);
    db.query(
        `INSERT INTO jobs (id, canvas_id, node_id, user_id, type, capability, model, params, status, progress, run_after, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?)`,
    ).run("j1", "cvOther", "n1", "u_other", "image", "image", "gpt-image-1", "{}", nowIso, nowIso, nowIso);

    assertEqual(listOpenJobs("u_other", "cvOther").length, 1, "owner 自己应能看到 1 条任务");
    assertEqual(listOpenJobs("u_p01", "cvOther").length, 0, "他人不应看到别人的 openJobs（IDOR）");
});

await check("列表总数：countCanvases 只算自己的、且不受分页影响", () => {
    assertEqual(countCanvases("u_p01"), 1, "u_p01 应有 1 张画布");
    assertEqual(countCanvases("u_other"), 1, "u_other 应有 1 张画布");
    assertEqual(countCanvases("nobody"), 0, "不存在的用户应为 0");
});

// ---------------------------------------------------------------------------
// 6. P0-2 回归：资产 MIME 白名单（真实 putAsset + 真实 upsertAsset）
// ---------------------------------------------------------------------------

section("[6] P0-2 回归：非白名单 MIME（text/html、image/svg+xml）必须被降级为 octet-stream + kind=file");

const { putAsset } = await import("../src/services/asset-service.ts");

/** 上传一段字节并回读落库结果。 */
async function uploadAs(key, mime, bytes) {
    const row = await putAsset("u_p01", key, bytes, mime, null);
    return row;
}

await check("text/html 被降级：mime=octet-stream、kind=file（同源直出的存储型 XSS 被堵住）", async () => {
    const row = await uploadAs("file:HTMLTEST0000000000", "text/html; charset=utf-8", Buffer.from("<script>alert(1)</script>"));
    assertEqual(row.mime, "application/octet-stream", "text/html 未被降级");
    assertEqual(row.kind, "file", "kind 必须是 file");
    assertEqual(row.storage_key, "file:HTMLTEST0000000000", "storageKey 被改动了");
});

await check("image/svg+xml 被降级（SVG 可内嵌脚本，不能当图片放行）", async () => {
    const row = await uploadAs("image:SVGTEST0000000000", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    assertEqual(row.mime, "application/octet-stream", "svg 未被降级");
    assertEqual(row.kind, "file", "kind 必须是 file");
});

await check("白名单内类型保留：image/png → kind=image", async () => {
    const row = await uploadAs("image:PNGTEST0000000000", "image/png", Buffer.from(pngBase64, "base64"));
    assertEqual(row.mime, "image/png", "image/png 不该被降级");
    assertEqual(row.kind, "image", "kind 应为 image");
});

await check("未声明 Content-Type 时按 storageKey 前缀兜底（Blob 直传场景）", async () => {
    const row = await uploadAs("image:NOCTYPE00000000000", "", Buffer.alloc(32, 7));
    assertEqual(row.mime, "image/png", "空 Content-Type + image: 前缀应兜底为 image/png");
    assertEqual(row.kind, "image", "kind 应为 image");
});

await check("application/octet-stream 且前缀是 file → 保持 octet-stream + kind=file", async () => {
    const row = await uploadAs("file:OCTETTEST000000000", "application/octet-stream", Buffer.alloc(24, 9));
    assertEqual(row.mime, "application/octet-stream", "mime 不该被改写");
    assertEqual(row.kind, "file", "kind 必须是 file");
});

// ---------------------------------------------------------------------------
// 7. P1-1 / P2-3 回归：doc 清洗的两条绕过与"正文误伤"
// ---------------------------------------------------------------------------

section("[7] P1-1 / P2-3 回归：深度绕过、storageKey 旁路、正文字段");

const { decodeDataUrl, sanitizeCanvasDoc } = await import("../src/services/doc-sanitizer.ts");

await check("P0-2 同源：decodeDataUrl 拒绝 text/html（与资产侧共用白名单）", () => {
    assertEqual(decodeDataUrl("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="), null, "text/html 竟被解码");
    assertEqual(decodeDataUrl("data:image/svg+xml;base64,PHN2Zy8+"), null, "svg 竟被解码");
    assert(decodeDataUrl(`data:image/png;base64,${pngBase64}`)?.mime, "image/png", "合法 png 不该被拒");
});

await check("P1-1 A：第 70 层埋 base64 不再原样入库（整棵子树丢弃 + 计数）", async () => {
    let deep = { v: `data:image/png;base64,${pngBase64}` };
    for (let index = 0; index < 70; index += 1) deep = { child: deep };

    const { doc, stats } = await sanitizeCanvasDoc(deep, null);
    assert(!JSON.stringify(doc).includes("base64"), "深层 base64 仍被原样保留（绕过成功）");
    assert(stats.dropped >= 1, `应计入 dropped，实际 ${stats.dropped}`);
});

await check("P1-1 B：storageKey 里的 data: URL 被置空并计数", async () => {
    const { doc, stats } = await sanitizeCanvasDoc(
        { nodes: [{ id: "n1", metadata: { storageKey: `data:image/png;base64,${pngBase64}`, content: "" } }] },
        null,
    );
    assertEqual(doc.nodes[0].metadata.storageKey, "", "storageKey 未被置空");
    assert(stats.dropped >= 1, "应计入 dropped");
});

await check("P2-3：文本节点正文 / prompt 里的 data:/blob: 字样原样保留", async () => {
    const { doc } = await sanitizeCanvasDoc(
        {
            nodes: [
                { id: "t1", type: "text", metadata: { content: "blob:abc 是我的笔记正文，data:image 只是字样" } },
                { id: "c1", type: "config", metadata: { prompt: "把 data:image/png;base64,AAAA 当文案讲一遍" } },
            ],
        },
        null,
    );
    assertEqual(doc.nodes[0].metadata.content, "blob:abc 是我的笔记正文，data:image 只是字样", "文本正文被清空");
    assertEqual(doc.nodes[1].metadata.prompt, "把 data:image/png;base64,AAAA 当文案讲一遍", "prompt 被清空");
});

await check("P2-3：未知字段里的短 data URL 按文本保留（长度阈值生效）", async () => {
    const short = "data:image/png;base64,AAAA";
    const { doc } = await sanitizeCanvasDoc({ pluginField: short }, null);
    assertEqual(doc.pluginField, short, "短 data URL 被误当载荷丢弃");
});

// ---------------------------------------------------------------------------
// 8. 收尾：关连接 + 清理临时目录
// ---------------------------------------------------------------------------

closeDb();
await rm(workDir, { recursive: true, force: true });

console.log("\n" + "=".repeat(64));
if (failures.length === 0) {
    console.log(`全部通过：${passed} 项断言组`);
    console.log("=".repeat(64));
    process.exit(0);
}

console.log(`失败 ${failures.length} 项，通过 ${passed} 项：`);
for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
console.log("=".repeat(64));
process.exit(1);
