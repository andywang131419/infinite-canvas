/**
 * `bun:sqlite` 的 Node 垫片 —— **仅供自检脚本使用，不参与任何生产路径**。
 *
 * 为什么需要它：
 *   `server/src/db/client.ts` 写的是 `import { Database } from "bun:sqlite"`，
 *   而本机没有 Bun 运行时。`scripts/verify-fix-p01.mjs` 用
 *   `node:module` 的 `registerHooks()` 把 `bun:sqlite` 这个裸说明符重定向到本文件，
 *   于是 **真实的 `db/client.ts`、`db/repos/*.ts`、`services/*.ts` 可以原样跑在 Node 上**，
 *   而不是把 SQL 抄一份到测试里（抄一份就等于没测）。
 *
 * 兼容范围（只覆盖本项目实际用到的 API）：
 *   - `new Database(path)` / `db.query(sql)` / `db.prepare(sql)`
 *   - `stmt.run(...)` → `{ changes, lastInsertRowid }`
 *   - `stmt.get(...)` / `stmt.all(...)`
 *   - `db.exec(sql)` / `db.close()`
 *
 * 与 Bun 的差异（不影响本项目的用法）：
 *   - 每次 `query()` 都重新 prepare（Bun 内部有语句缓存，只影响性能）；
 *   - `changes` / `lastInsertRowid` 统一转成 `number`（node:sqlite 在 int64 场景返回 bigint）。
 */

import { DatabaseSync } from "node:sqlite";

/** `bun:sqlite` 的 Statement 最小实现。 */
class Statement {
    /** @param {import("node:sqlite").StatementSync} inner */
    constructor(inner) {
        this.inner = inner;
    }

    /** 执行写语句。 */
    run(...params) {
        const result = this.inner.run(...params);
        return {
            changes: Number(result?.changes ?? 0),
            lastInsertRowid: Number(result?.lastInsertRowid ?? 0),
        };
    }

    /** 取一行（无结果时返回 `undefined`，与 bun:sqlite 一致）。 */
    get(...params) {
        return this.inner.get(...params);
    }

    /** 取全部行。 */
    all(...params) {
        return this.inner.all(...params);
    }

    /** 释放语句（node:sqlite 无显式 API，留空以兼容调用方）。 */
    finalize() {
        /* no-op */
    }
}

/** `bun:sqlite` 的 Database 最小实现。 */
export class Database {
    /**
     * @param {string} path 数据库文件路径（或 `:memory:`）。
     * @param {object} [options] 兼容 bun 的 `{ create: true }`，node:sqlite 默认即会创建。
     */
    constructor(path, options = {}) {
        this.path = path;
        this.options = options;
        this.inner = new DatabaseSync(path);
    }

    /** 取（并缓存式地）拿到一条语句。 */
    query(sql) {
        return new Statement(this.inner.prepare(sql));
    }

    /** 同 {@link query}（bun:sqlite 两个名字都存在）。 */
    prepare(sql) {
        return new Statement(this.inner.prepare(sql));
    }

    /** 执行多语句脚本（迁移文件用）。 */
    exec(sql) {
        this.inner.exec(sql);
        return this;
    }

    /** 关闭连接。 */
    close() {
        this.inner.close();
    }
}

export default { Database };
