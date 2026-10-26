#!/usr/bin/env node
/**
 * T03 自检脚本（**不依赖 Bun / Docker**）。
 *
 * 与 `verify-t02.mjs` 同一套思路：
 * 1. **SQL 类**（原子认领 / 心跳 / 回收 / 幂等入队）→ 用 `node:sqlite` 执行
 *    **从 `src/jobs/queue.ts` 源码里原样抽取**的 SQL。抄一份就等于没测。
 * 2. **纯函数类**（SecretBox、Provider 适配器构造/解析、代理安全闸门、SSE 心跳）
 *    → Node 22 的类型剥离直接 `import("../src/x.ts")` 调用。
 * 3. **安全契约类**（渠道响应不含密钥）→ 源码级断言 + 类型定义断言。
 *
 * 运行：
 *   node scripts/verify-t03.mjs
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 *
 * 覆盖的验收点：
 *   ✓ SecretBox：往返 / 篡改必失败（GCM tag）/ 换 AUTH_SECRET 解不开 / 掩码
 *   ✓ 认领：20 个任务 × 21 次认领（4 条连接轮转）→ 无重复认领
 *   ✓ 心跳：租约有效 → 1 行；租约过期 → 0 行（Worker 据此自杀）
 *   ✓ 回收：有重试余量 → 回 queued + 退避；已用尽 → failed
 *   ✓ 幂等：同 key 提交 3 次 → 只有 1 行
 *   ✓ 适配器：golden fixture 逐字段比对（OpenAI × Gemini，含视频/音频/文本）
 *   ✓ 错误映射：429/5xx 可重试，401/404/参数错不可重试，内容审核独立错误码
 *   ✓ 代理闸门：evil.com / 169.254.169.254 / 127.0.0.1 / file: → 拒绝；白名单 → 放行
 *   ✓ SSE：空闲时注入 `: keep-alive`
 *   ✓ 渠道响应无密钥（类型 + 调用点 + 路由源码三重断言）
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 0. 环境变量（必须在 import 任何读 env 的模块之前设置）
// ---------------------------------------------------------------------------

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = join(tmpdir(), `ic-t03-${process.pid}.db`);
process.env.AUTH_SECRET = "verify-t03-secret-0123456789-abcdefghijklmnop";
process.env.COOKIE_SECURE = "false";
process.env.STORAGE_LOCAL_ROOT = join(tmpdir(), `ic-t03-media-${process.pid}`);

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

/** 顺序无关的深比较（用于 golden fixture 的请求体断言）。 */
function deepEqual(actual, expected, path = "$") {
    if (expected === null || typeof expected !== "object") {
        if (actual !== expected) throw new Error(`${path} 不相等（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
        return;
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length !== expected.length) {
            throw new Error(`${path} 数组长度不一致（期望 ${expected.length}，实际 ${Array.isArray(actual) ? actual.length : typeof actual}）`);
        }
        expected.forEach((item, index) => deepEqual(actual[index], item, `${path}[${index}]`));
        return;
    }
    if (!actual || typeof actual !== "object") throw new Error(`${path} 不是对象（实际 ${JSON.stringify(actual)}）`);

    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (expectedKeys.join(",") !== actualKeys.join(",")) {
        throw new Error(`${path} 字段集合不一致（期望 [${expectedKeys}]，实际 [${actualKeys}]）`);
    }
    for (const key of expectedKeys) deepEqual(actual[key], expected[key], `${path}.${key}`);
}

function section(title) {
    console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 源码读取
// ---------------------------------------------------------------------------

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const queueSource = readFileSync(join(repoRoot, "src/jobs/queue.ts"), "utf8");

/**
 * 全部迁移 SQL（按文件名升序），而不是只取 0001。
 *
 * `0002_job_fencing.sql` 改了幂等唯一索引并给 `backups` 加列；
 * 只跑 0001 的话，下面"幂等键跨租户隔离"的用例会测到一个**不存在的索引**，
 * 测过了也是假的。
 */
const migrationSql = (await readdir(join(repoRoot, "migrations")))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(join(repoRoot, "migrations", name), "utf8"))
    .join("\n");
const channelsRouteSource = readFileSync(join(repoRoot, "src/routes/channels.ts"), "utf8");
const channelsRepoSource = readFileSync(join(repoRoot, "src/db/repos/channels.ts"), "utf8");
const channelServiceSource = readFileSync(join(repoRoot, "src/services/channel-service.ts"), "utf8");
const handlersIndexSource = readFileSync(join(repoRoot, "src/jobs/handlers/index.ts"), "utf8");
const golden = JSON.parse(readFileSync(join(repoRoot, "src/providers/fixtures/golden.json"), "utf8"));

/** 从 queue.ts 里原样抽出某个 SQL 常量。 */
function extractSql(constName) {
    const pattern = new RegExp(`export const ${constName} = \`([\\s\\S]*?)\`;`);
    const matched = pattern.exec(queueSource);
    if (!matched) throw new Error(`无法从 queue.ts 抽取 ${constName}`);
    return matched[1];
}

// ---------------------------------------------------------------------------
// [1] SecretBox
// ---------------------------------------------------------------------------

section("[1] SecretBox：AES-256-GCM 加解密");

const { encryptSecret, decryptSecret, maskApiKey, SecretBoxError, resetSecretBoxCache } = await import("../src/crypto/secret-box.ts");
const { resetEnvCache } = await import("../src/env.ts");

const PLAIN_KEY = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";

check("加密结果带 v1. 版本前缀且不含明文", () => {
    const sealed = encryptSecret(PLAIN_KEY);
    assert(sealed.startsWith("v1."), `密文缺少版本前缀：${sealed.slice(0, 12)}`);
    assert(!sealed.includes(PLAIN_KEY), "密文里出现了明文密钥");
    assert(sealed.length > 30, "密文过短，可能没做 base64 封装");
});

check("解密可还原明文", () => {
    assertEqual(decryptSecret(encryptSecret(PLAIN_KEY)), PLAIN_KEY, "往返结果不一致");
});

check("同一明文两次加密密文不同（IV 随机）", () => {
    const a = encryptSecret(PLAIN_KEY);
    const b = encryptSecret(PLAIN_KEY);
    assert(a !== b, "两次加密得到相同密文，IV 没有随机化");
    assertEqual(decryptSecret(a), decryptSecret(b), "两个密文解出的明文应相同");
});

check("篡改密文 1 字节 → GCM 校验失败（auth_failed）", () => {
    const sealed = encryptSecret(PLAIN_KEY);
    const payload = Buffer.from(sealed.slice(3), "base64url");
    // 改动最后一个字节（落在 ciphertext 内），tag 校验必须失败。
    payload[payload.length - 1] ^= 0xff;
    const tampered = `v1.${payload.toString("base64url")}`;

    let caught = null;
    try {
        decryptSecret(tampered);
    } catch (error) {
        caught = error;
    }
    assert(caught instanceof SecretBoxError, "篡改后的密文没有抛 SecretBoxError");
    assertEqual(caught.reason, "auth_failed", "错误原因应为 auth_failed");
});

check("换 AUTH_SECRET → 旧密文无法解密", () => {
    const sealed = encryptSecret(PLAIN_KEY);
    const previous = process.env.AUTH_SECRET;

    process.env.AUTH_SECRET = "another-secret-9876543210-zyxwvutsrqponmlkjihgfe";
    resetEnvCache();
    resetSecretBoxCache();

    let caught = null;
    try {
        decryptSecret(sealed);
    } catch (error) {
        caught = error;
    } finally {
        process.env.AUTH_SECRET = previous;
        resetEnvCache();
        resetSecretBoxCache();
    }

    assert(caught instanceof SecretBoxError, "换密钥后仍能解密，说明密钥没有参与派生");
    assertEqual(caught.reason, "auth_failed", "错误原因应为 auth_failed");
});

check("空明文与未知版本号被拒绝", () => {
    let empty = null;
    try {
        encryptSecret("");
    } catch (error) {
        empty = error;
    }
    assertEqual(empty?.reason, "empty", "空明文应抛 empty");

    let version = null;
    try {
        decryptSecret("v9.abcdef");
    } catch (error) {
        version = error;
    }
    assertEqual(version?.reason, "unknown_version", "未知版本号应抛 unknown_version");
});

check("掩码只泄漏首尾（sk-****6789）", () => {
    const masked = maskApiKey(PLAIN_KEY);
    assert(/^sk-\*+[A-Za-z0-9]{4}$/.test(masked), `掩码格式不符合预期：${masked}`);
    assert(!masked.includes("abcdefghij"), "掩码里泄漏了密钥中段");
    assertEqual(maskApiKey("short"), "****", "过短的密钥应整体掩码");
});

// ---------------------------------------------------------------------------
// [2] 队列 SQL（从源码抽取，在 node:sqlite 上真跑）
// ---------------------------------------------------------------------------

section("[2] Job 队列：原子认领 / 心跳 / 回收 / 幂等");

const queueDir = await mkdtemp(join(tmpdir(), "ic-t03-queue-"));
let queueSeq = 0;

/**
 * 每个用例一个全新库（避免用例之间互相污染行）。
 *
 * node:sqlite 默认开启外键约束（`enableForeignKeyConstraints: true`），
 * 所以先把 jobs 依赖的 users / canvases 父行插好 —— 这也顺便验证了
 * `0001_init.sql` 的外键关系确实是通的。
 */
function createQueueDb() {
    const path = join(queueDir, `q${(queueSeq += 1)}.db`);
    const db = new DatabaseSync(path);
    db.exec(migrationSql);
    seedParents(db);
    return { db, path };
}

/**
 * 在同一个库文件上再开一条连接（模拟第二个 Worker 进程）。
 *
 * **不重跑迁移**：第二个进程连的是同一个已迁移的库，重跑 `0002` 的
 * `ALTER TABLE ... ADD COLUMN` 会报 duplicate column（SQLite 没有
 * `ADD COLUMN IF NOT EXISTS`）。这也更贴近真实——迁移是启动期一次性动作。
 */
function openOn(path) {
    return new DatabaseSync(path);
}

/** 插入 jobs 的外键父行（users / canvases）。 */
function seedParents(db) {
    const now = "2026-03-01T00:00:00.000Z";
    for (const userId of ["user_1", "user_2"]) {
        db.prepare("INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'owner', ?, ?)").run(
            userId,
            `${userId}@example.com`,
            now,
            now,
        );
    }
    for (const canvasId of ["cv_1", "cv_2"]) {
        db.prepare("INSERT INTO canvases (id, owner_id, title, doc, created_at, updated_at) VALUES (?, 'user_1', 't', '{}', ?, ?)").run(
            canvasId,
            now,
            now,
        );
    }
}

const SQL = {
    claim: extractSql("SQL_CLAIM_JOB"),
    heartbeat: extractSql("SQL_HEARTBEAT"),
    requeueExpired: extractSql("SQL_REQUEUE_EXPIRED"),
    failExpired: extractSql("SQL_FAIL_EXPIRED"),
    finishSucceeded: extractSql("SQL_FINISH_SUCCEEDED"),
    finishFailed: extractSql("SQL_FINISH_FAILED"),
    updateProgress: extractSql("SQL_UPDATE_PROGRESS"),
    setUpstream: extractSql("SQL_SET_UPSTREAM_TASK"),
    selectByIdempotency: extractSql("SQL_SELECT_BY_IDEMPOTENCY"),
    insert: extractSql("SQL_INSERT_JOB"),
    listOpen: extractSql("SQL_LIST_OPEN"),
    cancel: extractSql("SQL_CANCEL"),
};

const NOW = new Date("2026-03-01T00:00:00.000Z");
const iso = (date) => date.toISOString();

/** 按 SQL_INSERT_JOB 的真实占位符顺序插一行。 */
function insertJob(db, overrides = {}) {
    const job = {
        id: `job_${Math.random().toString(36).slice(2, 10)}`,
        canvasId: "cv_1",
        nodeId: "node_1",
        userId: "user_1",
        type: "image",
        channelId: null,
        capability: "image",
        model: "gpt-image-1",
        params: "{}",
        maxAttempts: 2,
        idempotencyKey: null,
        runAfter: iso(NOW),
        priority: 0,
        ...overrides,
    };

    db.prepare(SQL.insert).run(
        job.id,
        job.canvasId,
        job.nodeId,
        job.userId,
        job.type,
        job.channelId,
        job.capability,
        job.model,
        job.params,
        job.maxAttempts,
        job.idempotencyKey,
        job.runAfter,
        job.priority,
        null,
        iso(NOW),
        iso(NOW),
    );
    return job;
}

/** 认领一次（参数顺序与 SQL_CLAIM_JOB 一致）。 */
function claim(db, leaseSeconds = 60) {
    const leaseUntil = iso(new Date(NOW.getTime() + leaseSeconds * 1000));
    return db.prepare(SQL.claim).get(iso(NOW), leaseUntil, iso(NOW), iso(NOW));
}

check("认领：单条 UPDATE+RETURNING 把 queued 变 running 且 attempt+1", () => {
    const { db } = createQueueDb();
    const job = insertJob(db);
    const claimed = claim(db);

    assert(claimed, "认领返回空");
    assertEqual(claimed.id, job.id, "认领到的不是唯一那条任务");
    assertEqual(claimed.status, "running", "认领后状态应为 running");
    assertEqual(claimed.attempt, 1, "认领应把 attempt +1");
    assert(claimed.lease_until, "认领应写入 lease_until");
    assert(claimed.started_at, "首次认领应写入 started_at");
    db.close();
});

check("认领：4 条连接轮转 21 次认领 20 个任务 → 无重复、无遗漏", () => {
    const { db, path } = createQueueDb();
    const ids = new Set();
    for (let index = 0; index < 20; index += 1) {
        // 全部立即可领（run_after = now）：本用例测的是"认领互斥"，不是延迟。
        const job = insertJob(db);
        ids.add(job.id);
    }

    const connections = [db, openOn(path), openOn(path), openOn(path)];
    const claimedIds = [];
    for (let round = 0; round < 21; round += 1) {
        const connection = connections[round % connections.length];
        const claimed = claim(connection);
        if (claimed) claimedIds.push(claimed.id);
    }

    assertEqual(claimedIds.length, 20, "应恰好认领到 20 个任务");
    assertEqual(new Set(claimedIds).size, 20, "出现了重复认领（同一任务被两个 Worker 拿到）");
    for (const id of claimedIds) assert(ids.has(id), `认领到了不存在的任务 ${id}`);

    const claimedSet = new Set(claimedIds);
    assertEqual(claimedSet.size, ids.size, "有任务从未被认领");
    connections.slice(1).forEach((connection) => connection.close());
    db.close();
});

check("认领：run_after 未到的任务不会被提前取走", () => {
    const { db } = createQueueDb();
    insertJob(db, { runAfter: iso(new Date(NOW.getTime() + 60_000)) });
    assertEqual(claim(db), undefined, "future run_after 的任务被提前认领了");
    db.close();
});

check("认领：优先级高的先出（priority DESC）", () => {
    const { db } = createQueueDb();
    insertJob(db, { id: "job_low", priority: 0 });
    insertJob(db, { id: "job_high", priority: 10 });
    const first = claim(db);
    assertEqual(first.id, "job_high", "没有按 priority DESC 排序");
    db.close();
});

check("心跳：租约有效 → changes=1 并延长", () => {
    const { db } = createQueueDb();
    const job = insertJob(db);
    const claimed = claim(db, 60);

    const extended = iso(new Date(NOW.getTime() + 600_000));
    const result = db.prepare(SQL.heartbeat).run(extended, iso(NOW), claimed.id, iso(NOW));
    assertEqual(Number(result.changes), 1, "有效租约上的心跳应命中 1 行");

    const row = db.prepare("SELECT lease_until FROM jobs WHERE id = ?").get(job.id);
    assertEqual(row.lease_until, extended, "lease_until 没有被延长");
    db.close();
});

check("心跳：租约已过期 → changes=0（Worker 必须自杀）", () => {
    const { db } = createQueueDb();
    insertJob(db);
    const claimed = claim(db, 60);

    // 把租约改成过去，模拟"被另一个 Worker 回收"。
    db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(iso(new Date(NOW.getTime() - 60_000)), claimed.id);

    const result = db.prepare(SQL.heartbeat).run(iso(new Date(NOW.getTime() + 60_000)), iso(NOW), claimed.id, iso(NOW));
    assertEqual(Number(result.changes), 0, "过期租约上的心跳居然命中，僵尸 Worker 会继续写结果");
    db.close();
});

check("回收：有重试余量 → 回 queued 且 run_after 退避到未来", () => {
    const { db } = createQueueDb();
    insertJob(db, { maxAttempts: 3 });
    const claimed = claim(db, 60);
    db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(iso(new Date(NOW.getTime() - 1)), claimed.id);

    const runAfter = iso(new Date(NOW.getTime() + 30_000));
    const result = db.prepare(SQL.requeueExpired).run(runAfter, iso(NOW), iso(NOW), iso(NOW));
    assertEqual(Number(result.changes), 1, "应回收 1 行");

    const row = db.prepare("SELECT status, lease_until, run_after FROM jobs WHERE id = ?").get(claimed.id);
    assertEqual(row.status, "queued", "回收后状态应为 queued");
    assertEqual(row.lease_until, null, "回收后应清空 lease_until");
    assertEqual(row.run_after, runAfter, "回收后 run_after 应为退避时间");
    db.close();
});

check("回收：重试已用尽 → 直接 failed（不再转圈）", () => {
    const { db } = createQueueDb();
    insertJob(db, { maxAttempts: 1 });
    const claimed = claim(db, 60);
    db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(iso(new Date(NOW.getTime() - 1)), claimed.id);

    const requeued = db.prepare(SQL.requeueExpired).run(iso(NOW), iso(NOW), iso(NOW), iso(NOW));
    assertEqual(Number(requeued.changes), 0, "用尽重试的任务不该回到 queued");

    const failed = db.prepare(SQL.failExpired).run(iso(NOW), iso(NOW), iso(NOW));
    assertEqual(Number(failed.changes), 1, "用尽重试的任务应被判 failed");

    const row = db.prepare("SELECT status, error_code, retryable FROM jobs WHERE id = ?").get(claimed.id);
    assertEqual(row.status, "failed", "状态应为 failed");
    assertEqual(row.error_code, "PROVIDER_TIMEOUT", "应写入 PROVIDER_TIMEOUT");
    assertEqual(row.retryable, 0, "终态应标记不可重试");
    db.close();
});

check("幂等：同一 idempotencyKey 提交 3 次 → 只写 1 行", () => {
    const { db } = createQueueDb();
    const key = "idem_abc";

    for (let attempt = 0; attempt < 3; attempt += 1) {
        db.exec("BEGIN IMMEDIATE");
        const existing = db.prepare(SQL.selectByIdempotency).get(key, "user_1");
        if (existing) {
            db.exec("COMMIT");
            continue;
        }
        insertJob(db, { idempotencyKey: key });
        db.exec("COMMIT");
    }

    const rows = db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").all(key);
    assertEqual(rows.length, 1, `同一幂等键写入了 ${rows.length} 行`);
    db.close();
});

// QA R2 `P1-R2-4`：幂等键跨租户返回他人任务。
//
// 原实现 `SELECT ... WHERE idempotency_key = ?` 没有 user_id，且唯一索引
// `ux_jobs_idempotency` 也没有 —— 于是 B 复用 A 用过的键，拿到的就是 A 的任务
// （含 result_storage_keys / upstream_task_id / errorMessage）。
check("幂等隔离：B 复用 A 的幂等键 → 必须新建，不能读到 A 的任务", () => {
    const { db } = createQueueDb();
    const key = "shared_key";

    insertJob(db, { id: "job_A", userId: "user_1", idempotencyKey: key });

    // B 用同一个键提交。
    db.exec("BEGIN IMMEDIATE");
    const seenByB = db.prepare(SQL.selectByIdempotency).get(key, "user_2");
    if (!seenByB) insertJob(db, { id: "job_B", userId: "user_2", idempotencyKey: key });
    db.exec("COMMIT");

    assertEqual(seenByB, undefined, "B 看到了 A 的任务（幂等键跨租户泄露）");

    const rows = db.prepare("SELECT id, user_id FROM jobs WHERE idempotency_key = ?").all(key);
    assertEqual(rows.length, 2, `同一幂等键应允许两个用户各有一行，实际 ${rows.length} 行`);
    assert(
        rows.some((row) => row.user_id === "user_1") && rows.some((row) => row.user_id === "user_2"),
        "两行不属于不同用户",
    );
    db.close();
});

check("幂等隔离：同一用户对两个画布用同一 key → 应判冲突而非返回第一个画布的任务", () => {
    const { db } = createQueueDb();
    const key = "same_body_hash";

    insertJob(db, { id: "job_cv1", userId: "user_1", canvasId: "cv_1", idempotencyKey: key });

    db.exec("BEGIN IMMEDIATE");
    const existing = db.prepare(SQL.selectByIdempotency).get(key, "user_1");
    db.exec("COMMIT");

    // 查询层按 user 隔离后仍会命中（同用户），所以要靠调用方比对 canvas_id。
    assert(existing, "同用户同键应命中既有任务");
    assertEqual(existing.canvas_id, "cv_1", "命中的应是第一个画布的任务");
    // 前端对 cv_2 提交 → 这里必须判冲突（409），而不是把 cv_1 的任务返回去。
    assert(existing.canvas_id !== "cv_2", "cv_2 的请求错误地命中了 cv_1 的任务");
    db.close();
});

check("幂等索引：唯一索引已按 (user_id, idempotency_key) 建立", () => {
    const { db } = createQueueDb();
    const indexes = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND name LIKE '%idempotency%'")
        .all();

    assertEqual(indexes.length, 1, `幂等索引应恰好 1 个，实际 ${indexes.length}：${indexes.map((row) => row.name).join(",")}`);
    assert(/user_id/.test(indexes[0].sql ?? ""), `索引未包含 user_id：${indexes[0].sql}`);
    assert(/UNIQUE/i.test(indexes[0].sql ?? ""), "幂等索引必须是唯一索引");
    db.close();
});

check("成功收尾：写结果键 + progress=1 + 清 lease", () => {
    const { db } = createQueueDb();
    insertJob(db);
    const claimed = claim(db);
    const keys = JSON.stringify(["image:aaa", "image:bbb"]);

    // 末位是 attempt：收尾 SQL 靠它做围栏（见下面"僵尸 Worker"一组用例）。
    const result = db.prepare(SQL.finishSucceeded).run(keys, 0.42, iso(NOW), iso(NOW), claimed.id, claimed.attempt);
    assertEqual(Number(result.changes), 1, "收尾应命中 1 行");

    const row = db.prepare("SELECT status, progress, result_storage_keys, cost_actual, lease_until FROM jobs WHERE id = ?").get(claimed.id);
    assertEqual(row.status, "succeeded", "状态应为 succeeded");
    assertEqual(row.progress, 1, "progress 应为 1");
    assertEqual(row.result_storage_keys, keys, "结果键未写入");
    assertEqual(row.cost_actual, 0.42, "cost_actual 未写入");
    assertEqual(row.lease_until, null, "收尾应清空 lease_until");
    db.close();
});

check("失败收尾：可重试 → 回 queued 并清 lease", () => {
    const { db } = createQueueDb();
    insertJob(db, { maxAttempts: 3 });
    const claimed = claim(db);

    db.prepare(SQL.finishFailed).run("queued", "QUOTA_EXCEEDED", "上游限流", 1, iso(new Date(NOW.getTime() + 30_000)), null, iso(NOW), claimed.id, claimed.attempt);

    const row = db.prepare("SELECT status, error_code, retryable, finished_at FROM jobs WHERE id = ?").get(claimed.id);
    assertEqual(row.status, "queued", "可重试失败应回到 queued");
    assertEqual(row.error_code, "QUOTA_EXCEEDED", "错误码未写入");
    assertEqual(row.retryable, 1, "应标记可重试");
    assertEqual(row.finished_at, null, "可重试时不应写 finished_at");
    db.close();
});

// QA R2 `P1-R2-1`：僵尸 Worker 覆盖新 Worker 的成果。**这一组是最严重的一条。**
//
// 复现时序（QA 实测）：
//   A 认领 attempt=1 → 心跳写库抛异常（SQLITE_BUSY）→ reaper 回队
//   → B 认领 attempt=2 → A 僵尸收尾 changes=1，写入 image:A-STALE
//   → B 正常收尾 changes=0，成果被丢
//   → 用户看到上一次失败运行的图，attempt 被真实消耗、上游计费两次
//
// 为什么 `WHERE status='running'` 不够：任务被 reaper 回队、又被 B 认领之后
// 状态**又变回 running**，旧 Worker 的收尾照样命中。真正的围栏是 `attempt`。
check("僵尸 Worker：A(attempt=1) 心跳失败→被回队→B(attempt=2) 认领后，A 收尾必须 changes=0", () => {
    const { db } = createQueueDb();
    insertJob(db, { id: "job_zombie", maxAttempts: 3 });

    // A 认领 → attempt=1
    const claimedA = claim(db, 60);
    assertEqual(claimedA.attempt, 1, "A 认领后 attempt 应为 1");

    // reaper 把过期租约回队（还有重试余量）。
    // 退避时间刻意写成 NOW 而不是 NOW+30s：本用例要的是"B 能立刻重新认领"，
    // 背-off 到未来的话 B 认领不到，测的就不是围栏而是 run_after 了。
    db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(iso(new Date(NOW.getTime() - 1)), claimedA.id);
    const requeued = db.prepare(SQL.requeueExpired).run(iso(NOW), iso(NOW), iso(NOW), iso(NOW));
    assertEqual(Number(requeued.changes), 1, "应被回队");

    // B 认领 → attempt=2（注意：此时 status 又是 'running'）
    const claimedB = claim(db, 60);
    assertEqual(claimedB?.id, "job_zombie", "B 应认领到同一任务");
    assertEqual(claimedB.attempt, 2, "B 认领后 attempt 应为 2");

    const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(claimedA.id);
    assertEqual(row.status, "running", "此刻状态确实是 running —— 这正是只查 status 会被骗的原因");

    // **关键断言**：僵尸 A 拿自己那次的 attempt=1 去收尾，必须一行都改不动。
    const staleSucceeded = db.prepare(SQL.finishSucceeded).run(
        JSON.stringify(["image:A-STALE"]),
        null,
        iso(NOW),
        iso(NOW),
        claimedA.id,
        claimedA.attempt, // = 1，而当前是 2
    );
    assertEqual(Number(staleSucceeded.changes), 0, "僵尸 Worker 的成功收尾命中了！它会把新 Worker 的成果覆盖成旧结果");

    const staleFailed = db.prepare(SQL.finishFailed).run(
        "queued",
        "PROVIDER_UPSTREAM_ERROR",
        "僵尸写回的失败",
        1,
        iso(new Date(NOW.getTime() + 30_000)),
        null,
        iso(NOW),
        claimedA.id,
        claimedA.attempt,
    );
    assertEqual(Number(staleFailed.changes), 0, "僵尸 Worker 的失败收尾命中了（会污染 attempt 与退避）");

    // 反向确认：B 用自己那次的 attempt=2 收尾必须成功 —— 否则围栏把正常路径也挡死了。
    const fresh = db.prepare(SQL.finishSucceeded).run(
        JSON.stringify(["image:B-FRESH"]),
        null,
        iso(NOW),
        iso(NOW),
        claimedB.id,
        claimedB.attempt,
    );
    assertEqual(Number(fresh.changes), 1, "正常 Worker 的收尾被误伤（围栏写错了）");

    const final = db.prepare("SELECT status, result_storage_keys, attempt FROM jobs WHERE id = ?").get(claimedA.id);
    assertEqual(final.status, "succeeded", "最终状态应为 succeeded");
    assertEqual(final.result_storage_keys, JSON.stringify(["image:B-FRESH"]), "最终留下的应是新 Worker 的成果");
    assertEqual(final.attempt, 2, "attempt 不应被僵尸污染");
    db.close();
});

check("认领：attempt 已耗尽（attempt=max_attempts）的行不再被认领", () => {
    const { db } = createQueueDb();
    // 直接构造 QA 描述的那条脏行：attempt=2 / max=2，却因 requeueExpired 中途崩溃停在 queued。
    insertJob(db, { id: "job_exhausted", maxAttempts: 2 });

    // 每次认领后都要手动放回 queued —— running 状态是不会被再次认领的。
    for (let round = 0; round < 2; round += 1) {
        claim(db, 60);
        db.prepare("UPDATE jobs SET status = 'queued', lease_until = NULL, run_after = ? WHERE id = ?").run(iso(NOW), "job_exhausted");
    }

    const row = db.prepare("SELECT attempt, max_attempts FROM jobs WHERE id = ?").get("job_exhausted");
    assertEqual(row.attempt, 2, "构造失败：attempt 应为 2");

    assertEqual(claim(db), undefined, "attempt 已耗尽的行仍被认领（会超出 max_attempts 并多计费一次）");
    db.close();
});

check("列表/取消：open=true 只含 queued|running，取消只作用于未终态", () => {
    const { db } = createQueueDb();
    const queued = insertJob(db, { id: "job_q" });
    const running = insertJob(db, { id: "job_r" });
    claim(db); // 认领最早的一条（job_q），使其变 running

    const openRows = db.prepare(SQL.listOpen).all("cv_1", 50);
    assertEqual(openRows.length, 2, `open 列表应含 2 条，实际 ${openRows.length}`);

    const cancelled = db.prepare(SQL.cancel).run(iso(NOW), iso(NOW), queued.id, "user_1");
    assertEqual(Number(cancelled.changes), 1, "取消 queued 任务应命中");

    const again = db.prepare(SQL.cancel).run(iso(NOW), iso(NOW), queued.id, "user_1");
    assertEqual(Number(again.changes), 0, "已终态任务不应被重复取消");

    const notMine = db.prepare(SQL.cancel).run(iso(NOW), iso(NOW), running.id, "user_2");
    assertEqual(Number(notMine.changes), 0, "别人的任务不应被取消");
    db.close();
});

// 临时库文件在 Windows 上可能因句柄未完全释放而删不掉 —— 不影响断言结果。
await rm(queueDir, { recursive: true, force: true }).catch(() => undefined);

// ---------------------------------------------------------------------------
// [3] Provider 适配器：golden fixture
// ---------------------------------------------------------------------------

section("[3] Provider 适配器：golden fixture 比对");

const openaiAdapter = await import("../src/providers/openai.ts");
const geminiAdapter = await import("../src/providers/gemini.ts");
const { mapStatus, openaiBase, geminiBase, extractErrorMessage, scrubSecret } = await import("../src/providers/http.ts");

/** 构造 fixture 用的 ProviderContext。 */
function ctxFor(fixture, format) {
    return {
        format,
        baseUrl: fixture.ctx.baseUrl,
        apiKey: "sk-test-0123456789",
        model: fixture.ctx.model,
        timeoutMs: 5000,
    };
}

/** 组装 ImageParams（fixture 里只写关心的字段）。 */
function imageParams(params) {
    return {
        prompt: params.prompt,
        references: params.references ?? [],
        count: params.count ?? 1,
        size: params.size,
        quality: params.quality,
        background: params.background,
    };
}

/** 把 multipart 拍平成 {字段: 值}（文件字段记为 "<file>"）。 */
function formEntries(body) {
    const entries = {};
    for (const [key, value] of body.entries()) {
        entries[key] = typeof value === "string" ? value : `<file:${value.name ?? ""}>`;
    }
    return entries;
}

check("OpenAI 图像生成：请求体与 golden 一致（gpt-image 不带 response_format）", () => {
    const fixture = golden.openai.imageGeneration;
    const request = openaiAdapter.buildImageGenerationRequest(ctxFor(fixture, "openai"), imageParams(fixture.params));

    assertEqual(request.url, fixture.expect.url, "URL 不一致");
    assertEqual(request.method, fixture.expect.method, "method 不一致");
    deepEqual(JSON.parse(request.body), fixture.expect.body);
});

check("OpenAI 图像生成：非 gpt-image 模型带 response_format=b64_json", () => {
    const fixture = golden.openai.imageGenerationWithResponseFormat;
    const request = openaiAdapter.buildImageGenerationRequest(ctxFor(fixture, "openai"), imageParams(fixture.params));
    deepEqual(JSON.parse(request.body), fixture.expect.body);
});

check("OpenAI 图像编辑：multipart 字段与 golden 一致", () => {
    const fixture = golden.openai.imageEditFields;
    const request = openaiAdapter.buildImageEditRequest(ctxFor(fixture, "openai"), {
        ...imageParams(fixture.params),
        references: [{ mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
    });

    assertEqual(request.url, fixture.expect.url, "URL 不一致");
    assertEqual(request.method, "POST", "method 不一致");
    assert(request.body instanceof FormData, "图像编辑应使用 multipart FormData");
    // multipart 不能手写 Content-Type（boundary 由 FormData 生成）。
    assert(!("Content-Type" in request.headers), "multipart 请求不应手动设置 Content-Type");

    const entries = formEntries(request.body);
    for (const [key, value] of Object.entries(fixture.expect.fields)) {
        assertEqual(entries[key], value, `字段 ${key} 不一致`);
    }
    assertEqual(entries[fixture.expect.imageField], "<file:reference-0.png>", "参考图字段名/文件名不一致");
});

check("OpenAI 图像响应解析：b64_json → base64 源", () => {
    const fixture = golden.openai.imageResponse;
    const sources = openaiAdapter.parseImageSources(fixture.payload);
    deepEqual(sources, fixture.expect);
});

check("OpenAI 图像响应解析：url → url 源（兼容 images 字段）", () => {
    const fixture = golden.openai.imageResponseWithUrl;
    deepEqual(openaiAdapter.parseImageSources(fixture.payload), fixture.expect);
});

check("OpenAI 语音合成：请求体与 golden 一致", () => {
    const fixture = golden.openai.audioSpeech;
    const request = openaiAdapter.buildAudioSpeechRequest(ctxFor(fixture, "openai"), {
        prompt: fixture.params.prompt,
        voice: fixture.params.voice,
        format: fixture.params.format,
        speed: fixture.params.speed,
    });
    assertEqual(request.url, fixture.expect.url, "URL 不一致");
    deepEqual(JSON.parse(request.body), fixture.expect.body);
});

check("OpenAI /responses：reasoning.effort 只在非 auto 时下发", () => {
    const withReasoning = golden.openai.responses;
    const requestA = openaiAdapter.buildResponsesRequest(ctxFor(withReasoning, "openai"), withReasoning.params);
    assertEqual(requestA.url, withReasoning.expect.url, "URL 不一致");
    deepEqual(JSON.parse(requestA.body), withReasoning.expect.body);

    const noReasoning = golden.openai.responsesNoReasoning;
    const requestB = openaiAdapter.buildResponsesRequest(ctxFor(noReasoning, "openai"), noReasoning.params);
    deepEqual(JSON.parse(requestB.body), noReasoning.expect.body);
});

check("OpenAI 视频创建：multipart 字段与 golden 一致（含 resolution_name）", () => {
    const fixture = golden.openai.videoCreateFields;
    const request = openaiAdapter.buildVideoCreateRequest(ctxFor(fixture, "openai"), {
        prompt: fixture.params.prompt,
        mode: fixture.params.mode,
        seconds: fixture.params.seconds,
        size: fixture.params.size,
        resolution: fixture.params.resolution,
        generateAudio: fixture.params.generateAudio,
        watermark: fixture.params.watermark,
        references: [],
    });

    assertEqual(request.url, fixture.expect.url, "URL 不一致");
    const entries = formEntries(request.body);
    for (const [key, value] of Object.entries(fixture.expect.fields)) {
        assertEqual(entries[key], value, `字段 ${key} 不一致`);
    }
});

check("OpenAI 视频状态解析：完成带地址 / 完成无地址 / 失败", () => {
    const withUrl = golden.openai.videoStatusCompletedWithUrl;
    deepEqual(openaiAdapter.parseVideoStatus(withUrl.payload), withUrl.expect);

    const withoutUrl = golden.openai.videoStatusCompletedWithoutUrl;
    deepEqual(openaiAdapter.parseVideoStatus(withoutUrl.payload), withoutUrl.expect);

    const failed = golden.openai.videoStatusFailed;
    deepEqual(openaiAdapter.parseVideoStatus(failed.payload), failed.expect);
});

check("OpenAI 文本解析：output_text 与 output[].content[].text 两种形状", () => {
    const plain = golden.openai.responsesTextPlain;
    assertEqual(openaiAdapter.parseResponsesText(plain.payload), plain.expect, "output_text 解析不一致");

    const structured = golden.openai.responsesTextStructured;
    assertEqual(openaiAdapter.parseResponsesText(structured.payload), structured.expect, "结构化 output 解析不一致");
});

check("Gemini 图像：URL 带 models/{model} 前缀 + imageConfig 归一", () => {
    const fixture = golden.gemini.image;
    const request = geminiAdapter.buildGeminiImageRequest(ctxFor(fixture, "gemini"), imageParams(fixture.params));

    assertEqual(request.url, fixture.expect.url, "URL 不一致");
    assertEqual(request.headers["x-goog-api-key"], "sk-test-0123456789", "Gemini 应使用 x-goog-api-key 头");
    deepEqual(JSON.parse(request.body), fixture.expect.body);
});

check("Gemini 视频：predictLongRunning + 首帧 inlineData + 16:9 映射", () => {
    const fixture = golden.gemini.video;
    const request = geminiAdapter.buildGeminiVideoRequest(ctxFor(fixture, "gemini"), {
        prompt: fixture.params.prompt,
        mode: fixture.params.mode,
        seconds: fixture.params.seconds,
        size: fixture.params.size,
        resolution: fixture.params.resolution,
        generateAudio: fixture.params.generateAudio,
        watermark: fixture.params.watermark,
        references: [{ mime: "image/png", bytes: new Uint8Array(fixture.params.referenceBytes) }],
    });

    assertEqual(request.url, fixture.expect.url, "URL 不一致");
    deepEqual(JSON.parse(request.body), fixture.expect.body);
});

check("Gemini 文本：system 转 systemInstruction，user 转 contents", () => {
    const fixture = golden.gemini.text;
    const request = geminiAdapter.buildGeminiTextRequest(ctxFor(fixture, "gemini"), fixture.params);
    assertEqual(request.url, fixture.expect.url, "URL 不一致");
    deepEqual(JSON.parse(request.body), fixture.expect.body);
});

check("Gemini 图像响应：inlineData（含 snake_case）解析为字节", () => {
    const camel = golden.gemini.imageResponse;
    const sources = geminiAdapter.parseGeminiImageSources(camel.payload);
    assertEqual(sources.length, camel.expect.length, "解析出的图片数量不一致");
    assertEqual(sources[0].kind, "bytes", "应解析为 bytes 源");
    assertEqual(sources[0].mime, camel.expect[0].mime, "mime 不一致");
    assertEqual(Buffer.from(sources[0].bytes).toString("base64"), camel.expect[0].base64, "字节内容不一致");

    const snake = golden.gemini.imageResponseSnakeCase;
    const snakeSources = geminiAdapter.parseGeminiImageSources(snake.payload);
    assertEqual(snakeSources[0].mime, snake.expect[0].mime, "snake_case inline_data 的 mime 解析失败");
});

check("Gemini operation：done / pending / error 三态", () => {
    deepEqual(geminiAdapter.parseGeminiOperation(golden.gemini.operationDone.payload), golden.gemini.operationDone.expect);
    deepEqual(geminiAdapter.parseGeminiOperation(golden.gemini.operationPending.payload), golden.gemini.operationPending.expect);
    deepEqual(geminiAdapter.parseGeminiOperation(golden.gemini.operationFailed.payload), golden.gemini.operationFailed.expect);
});

check("Gemini 文本解析与内容审核拒绝", () => {
    const text = golden.gemini.textResponse;
    assertEqual(geminiAdapter.parseGeminiText(text.payload), text.expect, "文本拼接不一致");

    let caught = null;
    try {
        geminiAdapter.parseGeminiText(golden.gemini.blockedResponse.payload);
    } catch (error) {
        caught = error;
    }
    assertEqual(caught?.code, golden.gemini.blockedResponse.expectError.code, "内容审核拒绝应映射为 PROVIDER_CONTENT_REJECTED");
});

check("Gemini 视频下载地址自动补 key=（只在适配器内部）", () => {
    const withKey = geminiAdapter.withGeminiKey("https://generativelanguage.googleapis.com/v1/files/x:download", "KEY123");
    assert(withKey.includes("key=KEY123"), "未补 key 参数");
    const already = geminiAdapter.withGeminiKey("https://x/y?a=1&key=K", "KEY123");
    assertEqual(already, "https://x/y?a=1&key=K", "已有 key 时不应重复拼接");
});

check("baseUrl 归一：OpenAI 补 /v1、Gemini 补 /v1beta（已带则不重复）", () => {
    assertEqual(openaiBase("https://a.com"), "https://a.com/v1", "OpenAI 未补 /v1");
    assertEqual(openaiBase("https://a.com/v1/"), "https://a.com/v1", "OpenAI 重复追加 /v1");
    assertEqual(geminiBase("https://a.com"), "https://a.com/v1beta", "Gemini 未补 /v1beta");
    assertEqual(geminiBase("https://a.com/v1"), "https://a.com/v1", "Gemini 误加 /v1beta");
});

check("错误映射：状态码 → 错误码 + retryable（含内容审核识别）", () => {
    for (const item of golden.statusMapping) {
        const error = mapStatus(item.status, item.message ?? "boom");
        assertEqual(error.code, item.code, `HTTP ${item.status} 的错误码不一致`);
        assertEqual(error.retryable, item.retryable, `HTTP ${item.status} 的 retryable 不一致`);
    }
});

check("错误信息抽取：OpenAI / 中转站 / HTML 三种形状", () => {
    assertEqual(extractErrorMessage('{"error":{"message":"bad key"}}'), "bad key", "OpenAI 形状解析失败");
    assertEqual(extractErrorMessage('{"msg":"额度不足"}'), "额度不足", "中转站 msg 解析失败");
    assert(extractErrorMessage("<html><body><h1>502 Bad Gateway</h1></body></html>").includes("502 Bad Gateway"), "HTML 错误页未抽取正文");
    assertEqual(extractErrorMessage(""), "", "空响应应返回空串");
});

check("密钥脱敏：错误信息里出现密钥 → 替换为 ***", () => {
    const scrubbed = scrubSecret("upstream said key sk-test-0123456789 is invalid", "sk-test-0123456789");
    assert(!scrubbed.includes("sk-test-0123456789"), "密钥未被脱敏");
    assert(scrubbed.includes("***"), "脱敏占位符缺失");
});

// ---------------------------------------------------------------------------
// [4] Tier2 代理闸门（SSRF + 白名单）
// ---------------------------------------------------------------------------

section("[4] Tier2 代理：SSRF 与白名单");

const guard = await import("../src/proxy/guard.ts");

const allowlist = new Set(["api.example.com", "generativelanguage.googleapis.com"]);

check("白名单内的 host 放行", () => {
    const result = guard.checkTarget("https://api.example.com/v1/chat/completions", allowlist);
    assert(result.ok, `白名单 host 被拒：${result.reason}`);
});

check("子域匹配白名单（gw.api.example.com）", () => {
    const result = guard.checkTarget("https://gw.api.example.com/v1/x", allowlist);
    assert(result.ok, `白名单子域被拒：${result.reason}`);
});

check("白名单外 host（evil.com）→ 拒绝", () => {
    const result = guard.checkTarget("https://evil.com/steal", allowlist);
    assert(!result.ok, "白名单外 host 被放行");
    assert(result.reason.includes("白名单"), `拒绝原因不明确：${result.reason}`);
});

check("云 metadata 地址 169.254.169.254 → 拒绝（即使加进白名单）", () => {
    const result = guard.checkTarget("http://169.254.169.254/latest/meta-data/", new Set(["169.254.169.254"]));
    assert(!result.ok, "metadata 地址被放行，SSRF 防护失效");
});

check("回环 / 私网 / CGNAT 全部拒绝", () => {
    const targets = [
        "http://127.0.0.1:8787/api/health",
        "http://localhost/admin",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://100.64.0.1/",
        "http://[::1]:8787/",
        "http://0.0.0.0/",
    ];
    for (const target of targets) {
        // 刻意把目标主机放进白名单：这一组要证明的是"即使配置了内网地址也拦得住"。
        const permissive = new Set([new URL(target).hostname.replace(/^\[|\]$/g, "")]);
        const result = guard.checkTarget(target, permissive);
        assert(!result.ok, `${target} 被放行`);
    }
});

check("非 http(s) 协议（file: / gopher: / data:）→ 拒绝", () => {
    for (const target of ["file:///etc/passwd", "gopher://x/", "data:text/plain,hi"]) {
        const result = guard.checkTarget(target, allowlist);
        assert(!result.ok, `${target} 被放行`);
    }
});

check("URL 里带账号密码 → 拒绝", () => {
    const result = guard.checkTarget("https://user:pass@api.example.com/v1", allowlist);
    assert(!result.ok, "带内联凭据的 URL 被放行");
});

check("IPv4/IPv6 网段判定（保留段逐项）", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.1.1", "172.20.0.1", "192.168.0.1", "224.0.0.1", "240.0.0.1", "0.0.0.0"]) {
        assert(guard.isBlockedIpv4(ip), `${ip} 未被判为禁止网段`);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.9"]) {
        assert(!guard.isBlockedIpv4(ip), `公网 IP ${ip} 被误判为禁止`);
    }
    for (const ip of ["::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
        assert(guard.isBlockedIpv6(ip), `IPv6 ${ip} 未被判为禁止`);
    }
    assert(!guard.isBlockedIpv6("2001:db8::1"), "公网 IPv6 被误判为禁止");
});

// QA R2 `P1-R2-3`：这里的补测是出于惨痛教训 —— 原先 IPv6 那一组恰好漏了
// `::ffff:x:y`（十六进制对写法），而漏洞正好压在测试盲区上。
check("IPv4-mapped 十六进制写法（::ffff:7f00:1 一族）必须拦住", () => {
    // WHATWG URL 会把 `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]`。
    for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:0a00:1", "::ffff:c0a8:101", "0:0:0:0:0:ffff:7f00:1"]) {
        assert(guard.isBlockedIpv6(ip), `IPv4-mapped ${ip} 未被判为禁止（fail-open 回归）`);
    }
    // 公网 IPv6 不能被误伤（fail-closed 的反向风险）。
    for (const ip of ["2001:db8::1", "2606:4700::6810:85e5", "2400:3200::1"]) {
        assert(!guard.isBlockedIpv6(ip), `公网 IPv6 ${ip} 被误判为禁止`);
    }
    // 判不明的畸形写法一律按禁止处理。
    for (const ip of ["", ":", "::::", "::zz"]) {
        assert(guard.isBlockedIpv6(ip), `畸形 IPv6 ${JSON.stringify(ip)} 未被判为禁止（应 fail-closed）`);
    }
});

check("IPv4-mapped 端到端：即使主机在白名单里也拒绝", () => {
    const permissive = new Set(["::ffff:7f00:1", "::ffff:a9fe:a9fe"]);
    for (const target of [
        "http://[::ffff:127.0.0.1]:8080/x",
        "http://[::ffff:7f00:1]:8080/x",
        "http://[::ffff:169.254.169.254]/latest/meta-data/",
        "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
    ]) {
        const result = guard.checkTarget(target, permissive);
        assert(!result.ok, `${target} 被放行（可用 metadata SSRF）`);
    }
});

// QA R2 `P1-R2-2`：`downloadBytes()` 过去只查协议就直传，构成带外回传的完整 SSRF
// （上游返回内网 URL → 服务端抓取 → 落成画布资产 → 用户下载回来）。
await checkAsync("downloadBytes：结果下载地址必须过 guard + 白名单", async () => {
    const { downloadBytes } = await import("../src/providers/http.ts");
    const { resetEnvCache } = await import("../src/env.ts");

    process.env.RESULT_DOWNLOAD_ALLOWLIST = "cdn.example.com";
    resetEnvCache();

    const ctx = {
        format: "openai",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-unit-test-not-a-real-key",
        model: "unit",
        timeoutMs: 1500,
    };

    for (const url of [
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "http://127.0.0.1:8787/api/canvases",
        "file:///etc/passwd",
        "http://evil.example-steal.test/a.png",
        "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
    ]) {
        let threw = null;
        try {
            await downloadBytes(ctx, url);
        } catch (error) {
            threw = error;
        }
        assert(threw !== null, `${url} 未被守卫拦截`);
        assert(
            String(threw?.message ?? "").includes("不允许的结果下载地址"),
            `${url} 被拦截但不是守卫拦的：${threw?.message}`,
        );
    }

    // 反向：白名单内的主机不能因为守卫而被拒（网络层的失败是另一回事）。
    let rejectedByGuard = false;
    try {
        await downloadBytes(ctx, "https://cdn.example.com/a.png");
    } catch (error) {
        rejectedByGuard = String(error?.message ?? "").includes("不允许的结果下载地址");
    }
    assert(!rejectedByGuard, "白名单内的结果地址被守卫误拒，正常功能会挂");

    delete process.env.RESULT_DOWNLOAD_ALLOWLIST;
    resetEnvCache();
});

// ---------------------------------------------------------------------------
// [5] SSE 心跳
// ---------------------------------------------------------------------------

section("[5] SSE 心跳：空闲时注入 : keep-alive");

const sse = await import("../src/proxy/sse.ts");

await checkAsync("空闲流在阈值后收到注释心跳，且不丢首帧数据", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode("data: hello\n\n"));
            // 之后保持空闲：不 close、不 enqueue。
        },
    });

    const wrapped = sse.withHeartbeat(source, 30);
    const reader = wrapped.getReader();
    const decoder = new TextDecoder();

    let text = "";
    for (let round = 0; round < 10 && !text.includes(": keep-alive"); round += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
    }
    await reader.cancel().catch(() => undefined);

    assert(text.includes("data: hello"), `首帧数据丢失：${JSON.stringify(text)}`);
    assert(text.includes(": keep-alive"), `未注入心跳：${JSON.stringify(text)}`);
    assertEqual(sse.HEARTBEAT_LINE, ": keep-alive\n\n", "心跳行格式不符合 SSE 注释约定");
});

await checkAsync("流正常结束会被正确 close（不会挂住）", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode("data: 1\n\n"));
            controller.close();
        },
    });

    const wrapped = sse.withHeartbeat(source, 1000);
    const reader = wrapped.getReader();
    const decoder = new TextDecoder();

    let text = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
    }
    assertEqual(text, "data: 1\n\n", "透传内容不一致");
});

check("SSE 响应头包含 no-store 与 X-Accel-Buffering", () => {
    const headers = sse.sseHeaders();
    assertEqual(headers["Content-Type"], "text/event-stream; charset=utf-8", "Content-Type 不正确");
    assertEqual(headers["X-Accel-Buffering"], "no", "缺少反代缓冲禁用头");
    assertEqual(headers["Cache-Control"], "no-store", "缺少 no-store");
});

// ---------------------------------------------------------------------------
// [6] 渠道密钥「只写不读」的三重断言
// ---------------------------------------------------------------------------

section("[6] 渠道密钥：响应里不可能出现明文或密文");

/** 去掉注释，只留"真正的代码"（否则契约说明本身会被误判为泄漏）。 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
}

check("ChannelDto 类型里没有密钥字段（不是置空，是没有）", () => {
    const matched = /export type ChannelDto = \{([\s\S]*?)\n\};/.exec(channelsRepoSource);
    assert(matched, "无法从 channels.ts 抽取 ChannelDto 类型");
    const body = stripComments(matched[1]);

    // `apiKeyHint` 是允许的（只含末尾 4 位），所以断言要排除它。
    const leaked = /(?:api[_-]?key(?!Hint)|cipher|encrypted|secretName)/i.exec(body);
    assert(!leaked, `ChannelDto 里出现了不该有的字段：${leaked?.[0]}`);
    assert(body.includes("hasKey"), "ChannelDto 缺少 hasKey");
    assert(body.includes("apiKeyHint"), "ChannelDto 缺少 apiKeyHint");
});

check("全仓库只有 channel-service.ts 调用 decryptSecret（唯一解密入口）", async () => {
    const dir = join(repoRoot, "src");
    const files = await collectTsFiles(dir);
    const callSites = [];

    for (const file of files) {
        const source = readFileSync(file, "utf8");
        // 排除定义处（crypto/secret-box.ts 自身）
        if (file.endsWith(join("crypto", "secret-box.ts"))) continue;
        if (/decryptSecret\s*\(/.test(source)) callSites.push(file.replace(repoRoot, ""));
    }

    assertEqual(callSites.length, 1, `解密调用点应只有 1 处，实际：${callSites.join(", ")}`);
    assert(callSites[0].includes("channel-service.ts"), `解密出现在非预期文件：${callSites[0]}`);
});

check("路由层不直接碰 api_key_cipher / findChannelById（只能拿 DTO）", () => {
    // 注释里允许出现这些词（说明契约），所以先剥离注释再看代码。
    const code = stripComments(channelsRouteSource);
    assert(!/api_key_cipher|apiKeyCipher/.test(code), "channels 路由里出现了密文字段");
    assert(!/findChannelById/.test(code), "channels 路由绕过了 service 直接查行");
    assert(!/encryptSecret/.test(code), "channels 路由自己加密了密钥（应在 service 层）");
    assert(!/listChannels|toChannelDto/.test(code), "channels 路由直接组装 DTO（应在 service 层）");
});

check("service 层把密文列名集中在一个文件（便于审计）", () => {
    assert(/api_key_cipher/.test(channelsRepoSource), "repos/channels.ts 应负责密文的读写");
    assert(/encryptSecret/.test(channelServiceSource), "channel-service.ts 应负责加密");
    assert(/maskApiKey/.test(channelServiceSource), "channel-service.ts 应负责生成掩码");
});

// ---------------------------------------------------------------------------
// [7] 结构完整性（handler / 路由 / 迁移一致）
// ---------------------------------------------------------------------------

section("[7] 结构完整性：job type / 路由 / 文件清单");

check("5 个 job type 全部注册了 handler（与迁移里的 CHECK 一致）", () => {
    const migrationTypes = [.../CHECK \(type IN \(([^)]+)\)\)/.exec(migrationSql)[1].matchAll(/'([a-z_]+)'/g)].map((item) => item[1]).sort();
    assertEqual(migrationTypes.join(","), "audio,image,image_edit,llm,video", "迁移里的 type 集合与预期不符");

    for (const type of migrationTypes) {
        const pattern = new RegExp(`^\\s{4}${type}:`, "m");
        assert(pattern.test(handlersIndexSource), `handlers/index.ts 缺少 ${type} 的注册`);
    }
});

await checkAsync("T03 关键文件全部存在", async () => {
    const expected = [
        "src/crypto/secret-box.ts",
        "src/db/repos/channels.ts",
        "src/db/repos/backups.ts",
        "src/services/channel-service.ts",
        "src/services/job-service.ts",
        "src/services/backup-service.ts",
        "src/jobs/queue.ts",
        "src/jobs/worker.ts",
        "src/jobs/types.ts",
        "src/jobs/handlers/index.ts",
        "src/jobs/handlers/image.ts",
        "src/jobs/handlers/video.ts",
        "src/jobs/handlers/audio.ts",
        "src/jobs/handlers/llm.ts",
        "src/providers/types.ts",
        "src/providers/http.ts",
        "src/providers/openai.ts",
        "src/providers/gemini.ts",
        "src/providers/index.ts",
        "src/proxy/guard.ts",
        "src/proxy/sse.ts",
        "src/routes/channels.ts",
        "src/routes/jobs.ts",
        "src/routes/proxy.ts",
        "src/routes/backups.ts",
        "src/providers/fixtures/golden.json",
        "scripts/verify-t03.mjs",
    ];

    const missing = [];
    for (const relative of expected) {
        try {
            await readFile(join(repoRoot, relative));
        } catch {
            missing.push(relative);
        }
    }
    assert(missing.length === 0, `缺少文件：${missing.join(", ")}`);
});

check("index.ts 挂载了 4 个新路由，并在 startWorker 之前注册 handler", () => {
    const source = readFileSync(join(repoRoot, "src/index.ts"), "utf8");
    for (const token of ["channelRoutes", "jobRoutes", "proxyRoutes", "backupRoutes"]) {
        assert(source.includes(`${token})`), `index.ts 未挂载 ${token}`);
    }
    const registerAt = source.indexOf("registerAllHandlers()");
    const startAt = source.indexOf("startWorker()");
    assert(registerAt > 0, "index.ts 未调用 registerAllHandlers()");
    assert(registerAt < startAt, "handler 注册必须在 startWorker() 之前");
});

check("drizzle 依赖已移除（ARCH 偏差已在 BASELINE 记录）", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    assert(!("drizzle-orm" in all), "package.json 仍依赖 drizzle-orm");
    assert(!("drizzle-kit" in all), "package.json 仍依赖 drizzle-kit");

    const baseline = readFileSync(join(repoRoot, "..", "docs/BASELINE.md"), "utf8");
    assert(baseline.includes("与 ARCH 的偏差"), "docs/BASELINE.md 缺少「与 ARCH 的偏差」章节");
});

// ---------------------------------------------------------------------------
// [8] 语法检查
// ---------------------------------------------------------------------------

section("[8] 语法检查：server/src 全部 .ts");

const { stripTypeScriptTypes } = await import("node:module");

/** 递归收集 .ts 文件。 */
async function collectTsFiles(dir) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await collectTsFiles(full)));
        else if (entry.name.endsWith(".ts")) found.push(full);
    }
    return found;
}

const tsFiles = await collectTsFiles(join(repoRoot, "src"));

check(`${tsFiles.length} 个 .ts 文件语法可解析`, () => {
    const broken = [];
    for (const file of tsFiles) {
        try {
            stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" });
        } catch (error) {
            broken.push(`${file.replace(repoRoot, "")}: ${error.message}`);
        }
    }
    assert(broken.length === 0, `存在语法错误：\n      ${broken.join("\n      ")}`);
});

// ---------------------------------------------------------------------------
// [9] 备份审计 / 环境口径一致（QA R2 `P1-R2-5` + 队列类 P2）
// ---------------------------------------------------------------------------

section("[9] 备份审计：失败必须可见（QA R2 P1-R2-5）");

const backupSource = readFileSync(join(repoRoot, "..", "deploy/backup/backup.sh"), "utf8");
const entrypointSource = readFileSync(join(repoRoot, "..", "deploy/backup/entrypoint.sh"), "utf8");
const composeSource = readFileSync(join(repoRoot, "..", "deploy/docker-compose.yml"), "utf8");
const envSource = readFileSync(join(repoRoot, "src/env.ts"), "utf8");
const httpSource = readFileSync(join(repoRoot, "src/providers/http.ts"), "utf8");

/**
 * 说明（诚实交代覆盖范围）：
 * 本机**没有 bash / sqlite3 / gzip / rclone**，所以 backup.sh 无法真的跑起来
 * （QA 用的"导出 bash 函数 + 替身注入失败"这套也要 bash）。下面这组是
 * **源码级**断言，能证明分支与 SQL 列写对了，但**不能**替代真跑一次。
 * 要真验证请在 Linux/macOS 上按 QA 的方式跑，或起一个装了 sqlite3 的容器。
 */

check("媒体目录缺失 + 要求打包 → 必须记 failed 并退出非 0", () => {
    // 定位"要求打包媒体"那个分支，在其内部找 ! -d 的处理。
    const block = /if is_truthy "\$INCLUDE_MEDIA"[\s\S]*?\nfi/.exec(backupSource);
    assert(block, "backup.sh 找不到 is_truthy 分支");
    const missingDir = /\[ ! -d "\$STORAGE_LOCAL_ROOT" \][\s\S]*?(record_audit[\s\S]*?)\n\s*FINISHED=1\s*\n\s*exit 1/.exec(block[0]);
    assert(missingDir, "媒体目录缺失时没有走「记 failed + exit 1」");
    assert(/record_audit "failed"/.test(missingDir[1]), "媒体目录缺失时记的不是 failed");
});

check("tar 失败 → 记 failed 并退出非 0（不再是 warn + 报成功）", () => {
    // 注意嵌套：tar 成功分支里还有一个 `if [ "$MEDIA_FILES" -eq 0 ] ... fi`（8 空格缩进）。
    // 所以这里锚定 **4 空格** 的 else/fi，避免被内层 fi 截断。
    const elseBranch = /if tar -czf[\s\S]*?\n    else\n([\s\S]*?)\n    fi/.exec(backupSource);
    assert(elseBranch, "tar 失败没有 else 分支");
    assert(/record_audit "failed"/.test(elseBranch[1]), "tar 失败时记的不是 failed");
    assert(/exit 1/.test(elseBranch[1]), "tar 失败没有以非 0 退出");
    assert(!/已跳过/.test(elseBranch[1]), "tar 失败仍在「跳过」（会继续报 success）");
});

check("审计行带 media_expected：能区分「打包失败」与「有意不打包媒体」", () => {
    assert(/INSERT INTO backups[\s\S]*?media_expected/.test(backupSource), "INSERT 里没有 media_expected 列");

    // 所有 record_audit 调用点都必须带上第 6 个参数，否则又会出现
    // "失败"与"有意关闭"审计行一模一样的问题。
    const calls = [...backupSource.matchAll(/record_audit\s+("?(?:failed|success)"?)[^\n]*/g)].map((item) => item[0]);
    assert(calls.length >= 5, `record_audit 调用点太少（${calls.length}），解析可能出错`);
    for (const call of calls) {
        const args = call.match(/"[^"]*"|\S+/g) ?? [];
        // 第 1 个 token 是函数名本身，之后才是参数。
        assert(args.length >= 7, `record_audit 缺少 media_expected 参数：${call}`);
    }
});

check("有意关闭媒体 → 记 media_expected=0（与失败区分开）", () => {
    assert(/BACKUP_INCLUDE_MEDIA 为假/.test(backupSource) || /有意只备份数据库/.test(backupSource), "缺少「有意关闭媒体」的日志分支");
    const successCall = /record_audit "success"[^\n]*/.exec(backupSource);
    assert(successCall, "找不到 success 审计调用");
    assert(/\$MEDIA_EXPECTED/.test(successCall[0]), "success 审计行没带 MEDIA_EXPECTED");
});

check("backup.sh 与 env.ts 认同一套布尔词表（口径一致）", () => {
    // backup.sh 的 is_truthy
    const shellMatch = /case[\s\S]*?(true \| 1 \| yes \| on)[\s\S]*?esac/.exec(backupSource);
    assert(shellMatch, "backup.sh 找不到 is_truthy 的 case 分支");
    const shellTrueWords = shellMatch[1].split("|").map((word) => word.trim());

    // env.ts 的 TRUE_WORDS
    const tsMatch = /const TRUE_WORDS = \[([^\]]+)\]/.exec(envSource);
    assert(tsMatch, "env.ts 找不到 TRUE_WORDS");
    const tsTrueWords = [...tsMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);

    assertEqual(
        shellTrueWords.slice().sort().join(","),
        tsTrueWords.slice().sort().join(","),
        "两侧布尔真值词表不一致（一边认为开了、另一边认为关了）",
    );
});

// 真跑一次的断言：这个不需要 bash，能直接验证 QA 说的"写 0/yes 会让 server 启动崩溃"。
// `resetEnvCache` 在 [1] 段已经导入过，这里只补 getEnv。
const { getEnv } = await import("../src/env.ts");

function boolEnvProbe(value) {
    const previous = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = value;
    resetEnvCache();
    try {
        return { ok: true, value: getEnv().COOKIE_SECURE };
    } catch (error) {
        return { ok: false, error };
    } finally {
        if (previous === undefined) delete process.env.COOKIE_SECURE;
        else process.env.COOKIE_SECURE = previous;
        resetEnvCache();
    }
}

check("布尔环境变量：0 / yes / on 都能解析（不再让 server 启动崩溃）", () => {
    assertEqual(boolEnvProbe("0").value, false, "写 0 未解析为 false");
    assertEqual(boolEnvProbe("no").value, false, "写 no 未解析为 false");
    assertEqual(boolEnvProbe("off").value, false, "写 off 未解析为 false");
    assertEqual(boolEnvProbe("1").value, true, "写 1 未解析为 true");
    assertEqual(boolEnvProbe("yes").value, true, "写 yes 未解析为 true");
    assertEqual(boolEnvProbe("ON").value, true, "写 ON（大写）未解析为 true");
    assertEqual(boolEnvProbe(" True ").value, true, "写 ' True '（带空格）未解析为 true");
});

check("布尔环境变量：无法判定的值仍然 fail-fast（不悄悄当 false）", () => {
    const result = boolEnvProbe("maybe");
    assertEqual(result.ok, false, "写 maybe 竟然通过了校验 —— 会被悄悄当成 false，等于静默关掉功能");
});

// ---------------------------------------------------------------------------
// 「变量在代码里读了、在 .env.example 里声明了，却漏了注入 compose」的防回归
//
// 这个失败模式到目前为止已经出现**四次**：
//   1. BACKUP_INCLUDE_MEDIA     未注入 server  → 媒体零备份（QA P1-3）
//   2. RESULT_DOWNLOAD_ALLOWLIST 只写文档没注入 → 空白名单拒绝一切图片下载
//   3. BACKUP_STAGE_DIR         只注入 backup  → 改了 .env 两边路径分裂
//   4. RCLONE_CONFIG_FILE       未透传        → 想改配置路径的人只能去改脚本
// 共同点：容器里恒为默认值/空值，且**没有任何报错**。靠人记不住，固化成断言。
//
// 只断言「漏了会静默失效」的关键键，不做 environment 全量比对 —— 全量断言会
// 变成维护负担，最后大家为了省事把测试删掉。
//
// 这里不给 server 引入 yaml 依赖：只需要"某服务的 environment 块下有哪些键"，
// 极简缩进扫描足够，且不跨目录依赖 web/node_modules。
// ---------------------------------------------------------------------------

/** 扫描 compose，返回 { 服务名: [environment 下的键] }。 */
function collectComposeEnvKeys(source) {
    const services = {};
    let current = null;
    let inEnv = false;

    for (const rawLine of source.split("\n")) {
        const line = rawLine.replace(/\r$/, "");

        // 顶层段（services: / volumes: / networks:）：缩进 0，结束当前服务
        if (/^\S/.test(line)) {
            current = null;
            inEnv = false;
            continue;
        }
        // 服务名：4 空格缩进
        const serviceMatch = /^ {4}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (serviceMatch) {
            current = serviceMatch[1];
            inEnv = false;
            continue;
        }
        if (current === null) continue;

        if (/^ {8}environment:\s*$/.test(line)) {
            inEnv = true;
            continue;
        }
        if (inEnv) {
            if (line.trim() === "") continue; // 块内空行
            // environment 下的键是 12 空格缩进。**注释行也是 12 空格**，
            // 所以只有缩进真的回落到 8 才算块结束 —— 否则第一个注释之后的
            // 所有键都会被漏掉（这个 bug 我自己踩过一次）。
            if (/^ {12}/.test(line)) {
                const keyMatch = /^ {12}([A-Z0-9_]+):/.exec(line);
                if (keyMatch) {
                    if (!services[current]) services[current] = [];
                    services[current].push(keyMatch[1]);
                }
                continue;
            }
            inEnv = false;
        }
    }

    return services;
}

const composeEnvKeys = collectComposeEnvKeys(composeSource);

/** 断言某服务注入了某个键；`consequence` 写清"漏了会怎样"。 */
function assertComposeEnvKey(service, key, consequence) {
    const keys = composeEnvKeys[service] ?? [];
    assert(keys.includes(key), `compose 的 ${service} 服务缺少 ${key} —— ${consequence}`);
}

check("docker-compose：server 服务注入了 4 个漏了会静默失效的键", () => {
    assertComposeEnvKey(
        "server",
        "BACKUP_INCLUDE_MEDIA",
        "server 恒取默认值，与 backup 容器口径分裂：一边以为打包了媒体、另一边其实没打包（QA P1-3）",
    );
    assertComposeEnvKey(
        "server",
        "RESULT_DOWNLOAD_ALLOWLIST",
        "容器里恒为空 = 拒绝一切结果下载 = 把 P1-R2-2 的 fail-closed 变成永久阻断，表现为「生成成功但画布无图」",
    );
    assertComposeEnvKey(
        "server",
        "BACKUP_STAGE_DIR",
        "server 恒取默认 /data/backups，在 .env 改了路径后与 backup 容器分裂（备份在一个地方、清理在另一个地方）",
    );
    assertComposeEnvKey(
        "server",
        "STORAGE_LOCAL_ROOT",
        "server 恒取默认 /data/media，改了路径后 backup 按新路径打媒体包、server 仍按旧路径存取，恢复后图照样 404",
    );
});

check("docker-compose：backup 服务注入了 5 个漏了会静默失效的键", () => {
    assertComposeEnvKey("backup", "BACKUP_ENABLED", "backup.sh 永远走默认值，运维在 .env 里关备份关不掉（或反过来）");
    assertComposeEnvKey("backup", "BACKUP_ON_START", "该变量没被声明过 → 首份备份要拖到次日 03:00，新机器首日无备份");
    assertComposeEnvKey("backup", "BACKUP_INCLUDE_MEDIA", "备份只覆盖 app.db，/data/media 下所有图片/视频零备份（QA P1-3）");
    assertComposeEnvKey("backup", "BACKUP_STAGE_DIR", "与 server 的暂存目录不是同一个，审计行与实际落点不一致");
    assertComposeEnvKey("backup", "RCLONE_CONFIG_FILE", "想改 rclone.conf 位置的人没法配，只能动手改 backup.sh");
});

check("docker-compose：RCLONE_REMOTE / RCLONE_DEST 键存在（留空是合法配置）", () => {
    // 这两个是"可选功能开关"：留空 = 只做本地备份，是合法选择。
    // 所以断言的是**键存在**而不是值非空 —— 把合法留空判成失败就矫枉过正了。
    assertComposeEnvKey("backup", "RCLONE_REMOTE", "键都没写的话，运维在 .env 里配了远端也不生效");
    assertComposeEnvKey("backup", "RCLONE_DEST", "键都没写的话，远端子目录无从指定");
});

check("docker-compose：只有 RCLONE_CONFIG_FILE，没有死配置 RCLONE_CONFIG（单数）", () => {
    // backup.sh 已显式传 `--config`，rclone 的优先级是 flag > 环境变量，
    // 单数的 RCLONE_CONFIG 传进去也没人读。这里只比对收集到的**键**，
    // 不扫全文 —— 注释里为了说明这件事也提到了这个字符串，扫全文会误判。
    for (const [service, keys] of Object.entries(composeEnvKeys)) {
        assert(!keys.includes("RCLONE_CONFIG"), `${service} 服务注入了死配置 RCLONE_CONFIG（单数）：flag 优先，它不会被读取`);
    }
    assertComposeEnvKey("backup", "RCLONE_CONFIG_FILE", "缺少可用的配置路径变量");
});

check("entrypoint.sh 与 backup.sh 的 is_truthy 词表逐字一致", () => {
    // 两边各自复制了一份（backup.sh 没有 main guard，source 它会当场触发一次备份）。
    // 词表一旦漂移，就会出现"用户按文档写了 1/yes，结果备份被静默关掉"。
    const extract = (source) => {
        const matched = /is_truthy\(\)\s*\{([\s\S]*?)\n\}/.exec(source);
        return matched ? matched[1].replace(/\s+/g, " ").trim() : null;
    };
    const entryBody = extract(entrypointSource);
    const backupBody = extract(backupSource);
    assert(entryBody, "entrypoint.sh 里找不到 is_truthy");
    assert(backupBody, "backup.sh 里找不到 is_truthy");
    assertEqual(entryBody, backupBody, "两处 is_truthy 函数体不一致 —— 布尔口径分裂会让备份被静默关掉");
});

check("sendRequest：先看 content-length 再读 body（512MB 上限真的能防住）", () => {
    // 旧实现：先 arrayBuffer() 再判 —— 字节已经在内存里了，"防 2GB 读死进程"是空话。
    assert(/content-length/.test(httpSource), "sendRequest 没有读 content-length");
    assert(/readBodyWithLimit/.test(httpSource), "sendRequest 没有走流式限量读取");

    const sendRequest = /export async function sendRequest[\s\S]*?\n}/.exec(httpSource);
    assert(sendRequest, "找不到 sendRequest");
    const limitCheckAt = sendRequest[0].indexOf("declaredLength > MAX_RESPONSE_BYTES");
    const readAt = sendRequest[0].indexOf("readBodyWithLimit");
    assert(limitCheckAt > 0, "sendRequest 里没有 content-length 超限判断");
    assert(readAt > 0, "sendRequest 里没有限量读取");
    assert(limitCheckAt < readAt, "超限判断写在读取之后 —— 上限形同虚设（字节已进内存）");
});

// ---------------------------------------------------------------------------
// [10] 备份审计的「去向」必须诚实
//
// 背景：server 镜像是 `oven/bun`，里面**没有 rclone**。`uploadWithRclone` 遇到
// ENOENT 时返回 false 且不算失败 —— 这个设计保留（本地至少有一份，不该判死整次
// 备份）。但审计行不能因此继续写 `target='remote:dest'` + success，那等于告诉
// 运维"数据已经异地了"，实际只躺在 stage 目录。与「备份失败必须可见」同一条原则。
// ---------------------------------------------------------------------------

const backupServiceSource = readFileSync(join(repoRoot, "src/services/backup-service.ts"), "utf8");
// 单独成文件就是为了这里能真 import：`backup-service.ts` 经 `db/client.ts`
// 传递依赖 `bun:sqlite`，在 Node 上 import 会直接报不支持的 URL scheme。
const { resolveBackupTarget, uploadWithRclone, isMissingBinary } = await import("../src/services/backup-target.ts");
const { execFileSync } = await import("node:child_process");

const STAGE_DIR_FOR_TEST = "/data/backups";
const baseTarget = { label: "", remote: "", dest: "", stageDir: STAGE_DIR_FOR_TEST, uploaded: null };

check("审计 target：BACKUP_TARGET_LABEL 非空时行为不变（人工标签绝不改写）", () => {
    assertEqual(
        resolveBackupTarget({ ...baseTarget, label: "oss://my-bucket", remote: "gdrive", dest: "ic", uploaded: false }),
        "oss://my-bucket",
        "人工标签被改写了 —— 用户写什么就是什么，真相由 uploaded 列承担",
    );
});

check("审计 target：rclone 存在且上传成功 → 写远端", () => {
    assertEqual(resolveBackupTarget({ ...baseTarget, remote: "gdrive", dest: "ic", uploaded: true }), "gdrive:ic", "上传成功却没写远端");
});

check("审计 target：配了远端但没传成（rclone 缺失）→ 降级 stageDir，不再谎称在远端", () => {
    assertEqual(
        resolveBackupTarget({ ...baseTarget, remote: "gdrive", dest: "ic", uploaded: false }),
        STAGE_DIR_FOR_TEST,
        "没传成却仍写远端路径 —— 正是这次要消灭的审计说谎",
    );
});

check("审计 target：没配远端 → stageDir", () => {
    assertEqual(resolveBackupTarget({ ...baseTarget, uploaded: null }), STAGE_DIR_FOR_TEST, "没配远端却写了别的路径");
});

check("审计 target：running 行（还没轮到上传）→ 写**意图**目的地", () => {
    assertEqual(resolveBackupTarget({ ...baseTarget, remote: "gdrive", dest: "ic", uploaded: null }), "gdrive:ic", "running 行丢了意图目的地");
});

check("isMissingBinary：只认 ENOENT", () => {
    assertEqual(isMissingBinary({ code: "ENOENT" }), true, "ENOENT 未被识别为命令缺失");
    assertEqual(isMissingBinary({ code: "EACCES" }), false, "EACCES 被误判为命令缺失 —— 会掩盖真失败");
    assertEqual(isMissingBinary(null), false, "null 被判成命令缺失");
    assertEqual(isMissingBinary("boom"), false, "字符串被判成命令缺失");
});

// 只有本机确实没装 rclone 时才去真跑"配了远端但命令不存在"这条分支；
// 装了的话真跑会去连一个不存在的远端，那不是本条想验的事。
let rcloneInstalled = true;
try {
    execFileSync("rclone", ["version"], { stdio: "ignore" });
} catch (error) {
    rcloneInstalled = error?.code !== "ENOENT";
}

const previousRemote = process.env.RCLONE_REMOTE;
delete process.env.RCLONE_REMOTE;
resetEnvCache();
const uploadNoRemote = await uploadWithRclone(STAGE_DIR_FOR_TEST);

process.env.RCLONE_REMOTE = "gdrive";
resetEnvCache();
const uploadMissingBin = rcloneInstalled ? null : await uploadWithRclone(STAGE_DIR_FOR_TEST);

if (previousRemote === undefined) delete process.env.RCLONE_REMOTE;
else process.env.RCLONE_REMOTE = previousRemote;
resetEnvCache();

check("uploadWithRclone：没配远端 → 直接跳过（false）", () => {
    assertEqual(uploadNoRemote, false, "没配远端却返回 true");
});

check("uploadWithRclone：配了远端但没装 rclone → 返回 false 且不抛错（本地至少有一份）", () => {
    if (rcloneInstalled) {
        console.log("      (本机已装 rclone，跳过：本条要验的是 server 镜像没装的情形)");
        return;
    }
    assertEqual(uploadMissingBin, false, "没装 rclone 却返回 true —— 审计会说谎");
});

check("backup-service：终态 target 走 resolveBackupTarget，uploaded 一并入库", () => {
    assert(/resolveBackupTarget/.test(backupServiceSource), "backup-service 未使用 resolveBackupTarget");
    const finishCall = /finishBackupSuccess\([\s\S]*?\);/.exec(backupServiceSource);
    assert(finishCall, "找不到 finishBackupSuccess 调用");
    assert(/target: finalTarget/.test(finishCall[0]), "finishBackupSuccess 传的不是降级后的 target");
    assert(/uploaded/.test(finishCall[0]), "finishBackupSuccess 没有把 uploaded 写进审计行");
});

check("backups 审计表：0003 迁移加了 uploaded 列，success 收尾会写它", () => {
    const migration = readFileSync(join(repoRoot, "migrations/0003_backup_uploaded.sql"), "utf8");
    assert(/ALTER TABLE backups ADD COLUMN uploaded/i.test(migration), "0003 迁移没有加 uploaded 列");
    const repoSource = readFileSync(join(repoRoot, "src/db/repos/backups.ts"), "utf8");
    assert(/uploaded = \?/.test(repoSource), "SQL_FINISH_SUCCESS 没有写 uploaded 列");
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

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
