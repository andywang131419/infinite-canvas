#!/usr/bin/env node
/**
 * T02 自检脚本（**不依赖 Bun**）。
 *
 * 为什么需要它：本机没有 Bun、也没有 Docker，`bun test` 跑不了。
 * 但 T02 的核心逻辑其实分两类，都可以用 Node 22 真跑：
 *
 * 1. **SQL 类**（迁移、乐观锁）→ `node:sqlite` 直接执行**从源码里抽取**的 SQL；
 * 2. **纯函数类**（storageKey 校验、doc 清洗、路径推导、区间归一化、
 *    本地磁盘驱动）→ Node 22.18+ 默认开启类型剥离，可 `import("./x.ts")` 直接调用。
 *
 * 关键设计：乐观锁的 SQL **不是**在这里抄一份，而是用正则从
 * `src/db/repos/canvas-sql.ts` 里原样抽出来执行。抄一份就等于没测 ——
 * 源码改了而测试没改，测试依然全绿。
 *
 * 运行：
 *   node scripts/verify-t02.mjs
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 *
 * 覆盖的验收点：
 *   ✓ 迁移可执行 / 幂等
 *   ✓ 乐观锁：20 个并发同 baseRevision 只成功 1 个，其余 0 行
 *   ✓ doc 清洗：DB 里不出现 data:image / blob:
 *   ✓ 路径穿越：`../../etc/passwd`、`/etc/passwd`、`a/../b` 全部拒绝
 *   ✓ 内容寻址落盘 + Range 读取 + 去重 + 删除
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 迷你断言框架
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failures.push({ name, message: error?.message ?? String(error) });
        console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
    }
}

async function checkAsync(name, fn) {
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
// 0. 源码读取
// ---------------------------------------------------------------------------

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const migrationSql = readFileSync(join(repoRoot, "migrations/0001_init.sql"), "utf8");
const canvasSqlSource = readFileSync(join(repoRoot, "src/db/repos/canvas-sql.ts"), "utf8");

/** 从 canvas-sql.ts 里原样抽出某个 SQL 常量。 */
function extractSql(constName) {
    const pattern = new RegExp(`export const ${constName} = \`([\\s\\S]*?)\`;`);
    const matched = pattern.exec(canvasSqlSource);
    if (!matched) throw new Error(`无法从源码中抽取 ${constName}`);
    return matched[1];
}

// ---------------------------------------------------------------------------
// 1. 迁移
// ---------------------------------------------------------------------------

section("[1] 迁移 0001_init.sql（node:sqlite 真跑）");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");

check("首次执行不报错", () => {
    db.exec(migrationSql);
});

check("包含 9 张业务表", () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const names = rows.map((row) => row.name);
    for (const table of ["app_settings", "assets", "backups", "canvas_revisions", "canvases", "channels", "jobs", "sessions", "users"]) {
        assert(names.includes(table), `缺少表 ${table}（实际：${names.join(", ")}）`);
    }
});

check("重复执行幂等（IF NOT EXISTS）", () => {
    db.exec(migrationSql);
    db.exec(migrationSql);
});

// ---------------------------------------------------------------------------
// 2. 乐观锁（T02 验收点 3）
// ---------------------------------------------------------------------------

section("[2] 乐观锁：20 个并发 PUT 同一个 baseRevision");

const SQL_UPDATE_CANVAS_CAS = extractSql("SQL_UPDATE_CANVAS_CAS");
const SQL_SOFT_DELETE_CANVAS = extractSql("SQL_SOFT_DELETE_CANVAS");
const SQL_SELECT_CANVAS_REVISION = extractSql("SQL_SELECT_CANVAS_REVISION");

// 造一个用户 + 一张画布（revision 从 1 开始）。
db.prepare("INSERT INTO users (id, email, password_hash, role, is_disabled, created_at, updated_at) VALUES (?, ?, ?, 'owner', 0, ?, ?)").run(
    "u1",
    "u1@local",
    "$argon2id$fake",
    "2026-10-01T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z",
);
db.prepare(
    "INSERT INTO canvases (id, owner_id, title, doc, revision, node_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)",
).run("cv1", "u1", "测试画布", JSON.stringify({ nodes: [] }), "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");

const updateStmt = db.prepare(SQL_UPDATE_CANVAS_CAS);
const revisionStmt = db.prepare(SQL_SELECT_CANVAS_REVISION);

/**
 * 模拟一次 PUT：客户端手里 baseRevision=1，20 个"并发"请求同时写。
 *
 * 真实并发下 SQLite 用写锁串行化；node:sqlite 是同步 API，
 * 因此这里顺序执行 —— 但**语义完全等价**：每个请求的 WHERE revision=1
 * 都基于同一个陈旧 baseRevision，第一个把 revision 推到 2，
 * 后面 19 个的 WHERE 必然不成立。原子性来自那条单条 UPDATE 本身，
 * 与应用层是否加锁无关。
 */
const concurrentResults = [];
for (let index = 0; index < 20; index += 1) {
    const row = updateStmt.get(
        JSON.stringify({ nodes: [], writer: index }),
        0,
        `画布-${index}`,
        `device-${index}`,
        "2026-10-02T00:00:00.000Z",
        "cv1",
        "u1",
        1,
    );
    concurrentResults.push(row ?? null);
}

check("20 次写入中恰好 1 次成功", () => {
    const succeeded = concurrentResults.filter((row) => row !== null);
    assertEqual(succeeded.length, 1, "成功次数不对");
});

check("其余 19 次返回 0 行（→ 409 REVISION_CONFLICT）", () => {
    const failed = concurrentResults.filter((row) => row === null);
    assertEqual(failed.length, 19, "冲突次数不对");
});

check("成功的那次 revision 从 1 递增到 2", () => {
    const winner = concurrentResults.find((row) => row !== null);
    assertEqual(winner.revision, 2, "返回的 revision 不对");
});

check("库里最终 revision = 2（没有多次自增）", () => {
    const row = revisionStmt.get("cv1", "u1");
    assertEqual(row.revision, 2, "最终 revision 不对");
});

check("用陈旧 baseRevision=1 再写必然失败", () => {
    const row = updateStmt.get(JSON.stringify({ nodes: [] }), 0, "again", null, "2026-10-03T00:00:00.000Z", "cv1", "u1", 1);
    assert(row === undefined || row === null, "陈旧版本竟写入成功");
});

check("用正确 baseRevision=2 可以写入，revision → 3", () => {
    const row = updateStmt.get(JSON.stringify({ nodes: [] }), 0, "ok", null, "2026-10-03T00:00:00.000Z", "cv1", "u1", 2);
    assert(row !== undefined && row !== null, "正确版本写入失败");
    assertEqual(row.revision, 3, "revision 未递增到 3");
});

check("别人的 owner_id 无法写（横向越权防护）", () => {
    db.prepare("INSERT INTO users (id, email, password_hash, role, is_disabled, created_at, updated_at) VALUES (?, ?, ?, 'member', 0, ?, ?)").run(
        "u2",
        "u2@local",
        "$argon2id$fake",
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
    );
    const row = updateStmt.get(JSON.stringify({ nodes: [] }), 0, "hijack", null, "2026-10-04T00:00:00.000Z", "cv1", "u2", 3);
    assert(row === undefined || row === null, "越权写入成功了");
});

check("软删后即使 revision 正确也写不进去", () => {
    db.prepare(SQL_SOFT_DELETE_CANVAS).run("2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z", "cv1", "u1");
    const row = updateStmt.get(JSON.stringify({ nodes: [] }), 0, "after-delete", null, "2026-10-06T00:00:00.000Z", "cv1", "u1", 3);
    assert(row === undefined || row === null, "已删除画布被写入了");
});

check("外键级联：删除用户后画布随之消失", () => {
    db.prepare("DELETE FROM users WHERE id = 'u1'").run();
    const row = db.prepare("SELECT COUNT(*) AS total FROM canvases WHERE owner_id = 'u1'").get();
    assertEqual(row.total, 0, "画布未被级联删除");
});

// ---------------------------------------------------------------------------
// 3. doc 清洗（T02 验收点 4）
// ---------------------------------------------------------------------------

section("[3] doc 清洗：内联 base64 → storageKey，blob: 置空");

const { sanitizeCanvasDoc, collectStorageKeys, decodeDataUrl } = await import("../src/services/doc-sanitizer.ts");

const pngBase64 = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const dataUrl = `data:image/png;base64,${pngBase64}`;

/** 假 ingest：只返回一个可断言的 storageKey，不碰磁盘。 */
const ingestCalls = [];
const fakeIngest = async (payload) => {
    ingestCalls.push(payload);
    return { storageKey: `image:EXTRACTED${ingestCalls.length}`, sha256: "b".repeat(64), bytes: payload.bytes.length, mime: payload.mime };
};

/** 构造一份覆盖全部脏点的 CanvasProject。 */
function buildDirtyDoc() {
    return {
        id: "cv1",
        title: "脏画布",
        nodes: [
            // 图片节点：content 是内联 base64，没有 storageKey
            { id: "n1", type: "image", title: "图1", metadata: { content: dataUrl, mimeType: "image/png" } },
            // 图片节点：content 是 blob: 死链接
            { id: "n2", type: "image", title: "图2", metadata: { content: "blob:http://localhost:3000/dead-link" } },
            // 配置节点：images[] 内联 + references[]（字符串数组，含 storageKey / data URL / blob）
            {
                id: "n3",
                type: "config",
                title: "配置",
                metadata: {
                    prompt: "画一只猫",
                    images: [{ id: "i1", status: "success", content: dataUrl, naturalWidth: 8, naturalHeight: 8, bytes: 16, mimeType: "image/png" }],
                    references: ["image:REALKEY0000000000000", dataUrl, "blob:http://x/y"],
                },
            },
            // 文本节点：content 是纯文本，绝不能被误伤
            { id: "n4", type: "text", title: "文本", metadata: { content: "这不是图片，data:image 只是文本里的字样" } },
        ],
        chatSessions: [
            {
                id: "s1",
                title: "对话",
                messages: [
                    // 关键路径：chatSessions[].messages[].references[].dataUrl
                    {
                        id: "m1",
                        role: "user",
                        text: "改这张图",
                        references: [
                            { id: "r1", type: "image", title: "ref1", dataUrl },
                            { id: "r2", type: "image", title: "ref2", dataUrl: "", storageKey: "image:KEEPME00000000000000" },
                        ],
                    },
                ],
            },
        ],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
}

const dirty = buildDirtyDoc();
const { doc: cleanDoc, stats } = await sanitizeCanvasDoc(dirty, fakeIngest);
const cleanJson = JSON.stringify(cleanDoc);

check("清洗后 JSON 中不再出现 base64 内联载荷", () => {
    // 注意：不能直接断言 "data:image" 不存在 ——
    // fixture 里那个文本节点**故意**包含字面量 "data:image"（用来证明文本不被误伤）。
    // 真正的判据是「不再有 base64 载荷」。
    assert(!cleanJson.includes(";base64,"), "仍然存在 base64 内联载荷");
});

check("清洗后 JSON 中不再出现 `blob:`", () => {
    assert(!cleanJson.includes("blob:"), "仍然存在 blob:");
});

check("图片节点 content 置空并补上 storageKey", () => {
    assertEqual(cleanDoc.nodes[0].metadata.content, "", "content 未置空");
    assert(String(cleanDoc.nodes[0].metadata.storageKey).startsWith("image:"), "storageKey 未写入");
});

check("blob: 字段被置空", () => {
    assertEqual(cleanDoc.nodes[1].metadata.content, "", "blob 未被置空");
});

check("metadata.images[].content 同样被提取", () => {
    assertEqual(cleanDoc.nodes[2].metadata.images[0].content, "", "images[0].content 未置空");
    assert(String(cleanDoc.nodes[2].metadata.images[0].storageKey).startsWith("image:"), "images[0].storageKey 未写入");
});

check("metadata.references[] 三种形态都正确（合格 key 保留 / data URL 换 key / blob 置空）", () => {
    const refs = cleanDoc.nodes[2].metadata.references;
    assertEqual(refs[0], "image:REALKEY0000000000000", "已合格的 storageKey 被改动了");
    assert(String(refs[1]).startsWith("image:"), "data URL 未换成 storageKey");
    assertEqual(refs[2], "", "blob 未置空");
});

check("★ chatSessions[].messages[].references[].dataUrl 被提取（T02 明确要求）", () => {
    const ref = cleanDoc.chatSessions[0].messages[0].references[0];
    assertEqual(ref.dataUrl, "", "reference.dataUrl 未置空");
    assert(String(ref.storageKey).startsWith("image:"), "reference.storageKey 未写入");
});

check("已有 storageKey 的引用不被覆盖", () => {
    const ref = cleanDoc.chatSessions[0].messages[0].references[1];
    assertEqual(ref.storageKey, "image:KEEPME00000000000000", "storageKey 被覆盖了");
});

check("文本节点的 content 原样保留（不能被误伤）", () => {
    assertEqual(cleanDoc.nodes[3].metadata.content, "这不是图片，data:image 只是文本里的字样", "文本被误改");
});

check("其他字段逐一保持（title / prompt / viewport）", () => {
    assertEqual(cleanDoc.title, "脏画布", "title 变了");
    assertEqual(cleanDoc.nodes[2].metadata.prompt, "画一只猫", "prompt 变了");
    assertEqual(JSON.stringify(cleanDoc.viewport), JSON.stringify({ x: 0, y: 0, k: 1 }), "viewport 变了");
});

check("输入对象未被就地修改（纯函数）", () => {
    const original = buildDirtyDoc();
    assertEqual(JSON.stringify(dirty), JSON.stringify(original), "入参被修改了");
});

check(`清洗统计：extracted=${stats.extracted}（应为 4：节点 content ×1、images[0] ×1、references[1] ×1、messages[].references[0] ×1）`, () => {
    assertEqual(stats.extracted, 4, "extracted 计数不对");
    assertEqual(stats.blobCleared, 2, "blobCleared 计数不对（n2.content + references[2]）");
});

check("decodeDataUrl 能正确解出 MIME 与字节", () => {
    const payload = decodeDataUrl(dataUrl);
    assert(payload !== null, "解码失败");
    assertEqual(payload.mime, "image/png", "mime 不对");
    assertEqual(payload.bytes.length, 16, "字节数不对");
});

check("collectStorageKeys 能递归收集（前后端同语义）", () => {
    const keys = collectStorageKeys(cleanDoc);
    assert(keys.has("image:REALKEY0000000000000"), "漏掉了 references 里的 key");
    assert(keys.has("image:KEEPME00000000000000"), "漏掉了 messages 里的 key");
});

// 存储不可用时的降级：必须仍然不写 data:image。
const { doc: degradedDoc } = await sanitizeCanvasDoc(buildDirtyDoc(), null);
check("ingest=null 时 data URL 被丢弃而不是入库", () => {
    const json = JSON.stringify(degradedDoc);
    assert(!json.includes(";base64,"), "存储不可用时仍写入了内联载荷");
});

// 端到端：把清洗结果真正写进 SQLite，再读回来断言（这才是验收口径）。
check("★ 写入数据库后，canvases.doc 里没有任何内联 base64 / blob: 死链", () => {
    db.prepare(
        "INSERT INTO canvases (id, owner_id, title, doc, revision, node_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
    ).run("cv2", "u2", "脏画布", cleanJson, cleanDoc.nodes.length, "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    const row = db.prepare("SELECT doc FROM canvases WHERE id = 'cv2'").get();
    assert(!row.doc.includes(";base64,"), "数据库里出现了内联 base64");
    assert(!row.doc.includes('"blob:'), "数据库里出现了 blob: 死链");
});

// ---------------------------------------------------------------------------
// 4. storageKey 校验 / 路径穿越（T02 验收点 5）
// ---------------------------------------------------------------------------

section("[4] storageKey 校验：路径穿越一律拒绝");

const { parseStorageKey, deriveObjectRelPath, extensionFromMime, generateStorageKey, isSafeRelPath, StorageKeyError } = await import(
    "../src/storage/key.ts"
);

const traversalAttempts = [
    "../../etc/passwd",
    "/etc/passwd",
    "a/../b",
    "..",
    "..%2f..%2fetc%2fpasswd",
    "image:../../etc/passwd",
    "image:/etc/passwd",
    "image:a/b",
    "image:a\\b",
    "C:\\Windows\\win.ini",
    "",
    "   ",
    "image:",
    "unknown:abc",
    "image:has space",
    "image:with\u0000null",
    `image:${"A".repeat(65)}`,
];

for (const attempt of traversalAttempts) {
    check(`拒绝 ${JSON.stringify(attempt)}`, () => {
        let thrown = null;
        try {
            parseStorageKey(attempt);
        } catch (error) {
            thrown = error;
        }
        assert(thrown instanceof StorageKeyError, "未拒绝该 key");
    });
}

check("拒绝 undefined / 对象等非字符串输入", () => {
    for (const bad of [undefined, null, 123, {}, ["image:abc"]]) {
        let thrown = false;
        try {
            parseStorageKey(bad);
        } catch {
            thrown = true;
        }
        assert(thrown, `未拒绝 ${JSON.stringify(bad)}`);
    }
});

check("接受合法 key image:V1StGXR8_Z5jdHi6B-myT", () => {
    const parsed = parseStorageKey("image:V1StGXR8_Z5jdHi6B-myT");
    assertEqual(parsed.prefix, "image", "前缀不对");
    assertEqual(parsed.id, "V1StGXR8_Z5jdHi6B-myT", "标识不对");
});

check("接受全部 6 种合法前缀", () => {
    for (const prefix of ["image", "video", "audio", "file", "video-reference", "audio-reference"]) {
        const parsed = parseStorageKey(`${prefix}:abc123`);
        assertEqual(parsed.prefix, prefix, `前缀 ${prefix} 解析失败`);
    }
});

check("生成的 storageKey 能通过自身校验", () => {
    for (let index = 0; index < 50; index += 1) {
        const key = generateStorageKey("image");
        assertEqual(parseStorageKey(key).prefix, "image", "生成的 key 不合法");
    }
});

check("isSafeRelPath 拒绝穿越相对路径", () => {
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "C:/x", "a\\b", ""]) {
        assert(!isSafeRelPath(bad), `未拒绝 ${bad}`);
    }
    assert(isSafeRelPath("2026/10/abc.png"), "合法相对路径被拒");
});

// ---------------------------------------------------------------------------
// 5. 内容寻址路径
// ---------------------------------------------------------------------------

section("[5] 内容寻址路径推导");

const sha = "a".repeat(64);

check("路径形如 {yyyy}/{mm}/{sha256}.{ext}", () => {
    const rel = deriveObjectRelPath({ sha256: sha, mime: "image/png", createdAt: "2026-10-05T12:34:56.000Z" });
    assertEqual(rel, `2026/10/${sha}.png`, "路径格式不对");
});

check("扩展名随 MIME 变化", () => {
    assertEqual(extensionFromMime("image/jpeg"), "jpg", "jpeg 映射错");
    assertEqual(extensionFromMime("video/mp4"), "mp4", "mp4 映射错");
    assertEqual(extensionFromMime("audio/mpeg"), "mp3", "mp3 映射错");
    assertEqual(extensionFromMime("image/webp; charset=binary"), "webp", "带参数时未裁剪");
    assertEqual(extensionFromMime("application/x-weird"), "xweird", "未知类型兜底错");
});

check("非法 sha256 直接抛错", () => {
    let thrown = false;
    try {
        deriveObjectRelPath({ sha256: "not-a-hash", mime: "image/png", createdAt: "2026-10-05T00:00:00.000Z" });
    } catch {
        thrown = true;
    }
    assert(thrown, "未拒绝非法 sha256");
});

// ---------------------------------------------------------------------------
// 6. 本地磁盘驱动（真写盘 + Range + 去重 + 删除）
// ---------------------------------------------------------------------------

section("[6] LocalDiskDriver：真写盘 / Range 读取 / 去重 / 删除");

const { LocalDiskDriver, normalizeRange } = await import("../src/storage/local-disk.ts");

const tempRoot = await mkdtemp(join(tmpdir(), "ic-t02-"));
const driver = new LocalDiskDriver(tempRoot);

const fileBytes = new Uint8Array(1024);
for (let index = 0; index < fileBytes.length; index += 1) fileBytes[index] = index % 256;

const putResult = await driver.put({ bytes: fileBytes, mime: "image/png", createdAt: "2026-10-05T00:00:00.000Z" });

await checkAsync("写入后文件真的落在 {yyyy}/{mm}/{sha}.png", async () => {
    assertEqual(putResult.relPath, `2026/10/${putResult.sha256}.png`, "相对路径不对");
    const info = await stat(join(tempRoot, putResult.relPath));
    assertEqual(info.size, 1024, "文件大小不对");
});

await checkAsync("sha256 与内容一致（内容寻址）", async () => {
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(fileBytes).digest("hex");
    assertEqual(putResult.sha256, expected, "sha256 计算不一致");
});

await checkAsync("重复写入同一内容 → 去重（不再产生新文件）", async () => {
    const second = await driver.put({ bytes: fileBytes, mime: "image/png", createdAt: "2026-10-05T00:00:00.000Z" });
    assert(second.deduplicated === true, "未命中去重");

    const monthDir = join(tempRoot, "2026/10");
    const files = (await readdir(monthDir)).filter((name) => name.endsWith(".png"));
    assertEqual(files.length, 1, `目录里出现了多份相同内容：${files.join(", ")}`);
});

await checkAsync("没有残留 .tmp 临时文件（原子 rename 生效）", async () => {
    const files = await readdir(join(tempRoot, "2026/10"));
    const leftovers = files.filter((name) => name.includes(".tmp-"));
    assertEqual(leftovers.length, 0, `存在临时文件：${leftovers.join(", ")}`);
});

await checkAsync("整份读取字节完全一致", async () => {
    const body = await driver.get(putResult.relPath);
    const bytes = await readAll(body.stream);
    assertEqual(bytes.length, 1024, "长度不对");
    assertEqual(bytes[0], 0, "首字节不对");
    assertEqual(bytes[255], 255, "第 255 字节不对");
});

await checkAsync("Range 读取 [100,200) 正确", async () => {
    const body = await driver.get(putResult.relPath, { start: 100, end: 200 });
    const bytes = await readAll(body.stream);
    assertEqual(bytes.length, 100, "区间长度不对");
    assertEqual(bytes[0], 100, "区间起点不对");
    assertEqual(body.range.start, 100, "返回的 range 不对");
});

await checkAsync("Range 越界 → StorageRangeError（→ 416）", async () => {
    let thrown = false;
    try {
        await driver.get(putResult.relPath, { start: 5000, end: 6000 });
    } catch {
        thrown = true;
    }
    assert(thrown, "越界区间未被拒绝");
});

await checkAsync("stat 不存在的对象返回 null", async () => {
    const info = await driver.stat(`2026/10/${"c".repeat(64)}.png`);
    assert(info === null, "不存在却返回了元信息");
});

await checkAsync("绝对路径 / 穿越路径被驱动二次拒绝", async () => {
    for (const bad of ["/etc/passwd", "../../etc/passwd", "a/../../b"]) {
        let thrown = false;
        try {
            await driver.get(bad);
        } catch {
            thrown = true;
        }
        assert(thrown, `驱动未拒绝 ${bad}`);
    }
});

await checkAsync("删除后文件消失，且重复删除幂等", async () => {
    await driver.delete(putResult.relPath);
    assertEqual(await driver.stat(putResult.relPath), null, "文件未被删除");
    await driver.delete(putResult.relPath); // 不应抛错
});

check("normalizeRange 边界行为", () => {
    assertEqual(JSON.stringify(normalizeRange(undefined, 100)), JSON.stringify({ start: 0 }), "无区间时应从 0 开始");
    assertEqual(normalizeRange({ start: 10, end: 500 }, 100).end, 100, "超长 end 应被截断到 size");

    for (const bad of [{ start: 100 }, { start: -1 }, { start: 10, end: 10 }, { start: 10, end: 5 }]) {
        let thrown = false;
        try {
            normalizeRange(bad, 100);
        } catch {
            thrown = true;
        }
        assert(thrown, `未拒绝 ${JSON.stringify(bad)}`);
    }
});

await rm(tempRoot, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 7. 全部 server TS 文件语法检查
// ---------------------------------------------------------------------------

section("[7] 语法检查：server/src + server/scripts 全部 .ts");

const { stripTypeScriptTypes } = await import("node:module");
const { readdirSync } = await import("node:fs");

/** 递归收集 .ts 文件。 */
function collectTsFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...collectTsFiles(full));
        else if (entry.name.endsWith(".ts")) found.push(full);
    }
    return found;
}

const tsFiles = [...collectTsFiles(join(repoRoot, "src")), ...collectTsFiles(join(repoRoot, "scripts"))];

check(`${tsFiles.length} 个 .ts 文件语法可解析（等价于 tsc 的语法阶段）`, () => {
    const broken = [];
    for (const file of tsFiles) {
        try {
            // mode: "transform" 比 "strip" 更宽松（能处理 enum / 参数属性等），
            // 这里只借它做语法解析，不执行任何代码。
            stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" });
        } catch (error) {
            broken.push(`${file.replace(repoRoot, "")}: ${error.message}`);
        }
    }
    assert(broken.length === 0, `存在语法错误的文件：\n      ${broken.join("\n      ")}`);
});

check("server/src 下文件数量符合 T02 预期（>= 20）", () => {
    assert(tsFiles.length >= 20, `只有 ${tsFiles.length} 个文件，可能有文件未写入`);
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/** 把 ReadableStream 读成 Uint8Array。 */
async function readAll(stream) {
    const chunks = [];
    const reader = stream.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return merged;
}

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
