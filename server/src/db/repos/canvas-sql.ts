/**
 * 画布相关 SQL 常量。
 *
 * 为什么单独成文件：
 * 1. **乐观锁的正确性只取决于这一条 UPDATE 的 WHERE 子句**，把它单独拎出来，
 *    使 `scripts/verify-t02.mjs` 能够用正则从源码里**原样抽取**该 SQL 并在
 *    `node:sqlite` 上真跑并发断言 —— 而不是在测试里抄一份 SQL（抄一份就等于没测）。
 * 2. 参数顺序用位置占位符 `?`（bun:sqlite 与 node:sqlite 都 100% 兼容），
 *    因此每个常量上方必须写清参数顺序，改 SQL 时同步改注释。
 *
 * 约定：所有 SQL 都是**单条语句**。多语句事务由调用方（repo）组织，
 * 这样每条语句都能被单独 bind/run，也便于断言 `changes`。
 */

// =============================================================================
// canvases
// =============================================================================

/**
 * 新建画布。
 *
 * `revision` 硬编码为 1（`CHECK (revision >= 1)`），前端 `baseRevision=0` 即走这里。
 *
 * 参数顺序：
 * 1. id  2. owner_id  3. title  4. doc  5. node_count
 * 6. updated_by_device  7. created_at  8. updated_at
 */
export const SQL_INSERT_CANVAS = `
INSERT INTO canvases (id, owner_id, title, doc, revision, node_count, updated_by_device, created_at, updated_at)
VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
`;

/**
 * **乐观锁核心语句**（T02 验收点 3）。
 *
 * 关键点：
 * - `AND revision = ?`：只有客户端读到的那个版本还能写成功；
 * - `revision = revision + 1`：在**同一条语句**里自增，不存在"先读后写"的竞态窗口；
 * - `AND deleted_at IS NULL`：已软删的画布不能被并发复活；
 * - `RETURNING revision, updated_at`：写入成功时直接拿到新版本号，
 *   返回 0 行即代表 `changes = 0` → 上层返回 409 `REVISION_CONFLICT`。
 *
 * 因为是**单条 SQL**，SQLite 的写锁保证 20 个并发 PUT 里只有 1 个能命中 WHERE，
 * 其余必然 0 行 —— 这正是验收要求的"仅 1 个成功"。
 *
 * 参数顺序：
 * 1. doc  2. node_count  3. title  4. updated_by_device  5. updated_at
 * 6. id  7. owner_id  8. base_revision（客户端提交的 baseRevision）
 */
export const SQL_UPDATE_CANVAS_CAS = `
UPDATE canvases
   SET doc = ?,
       revision = revision + 1,
       node_count = ?,
       title = ?,
       updated_by_device = ?,
       updated_at = ?
 WHERE id = ?
   AND owner_id = ?
   AND revision = ?
   AND deleted_at IS NULL
RETURNING revision, updated_at
`;

/**
 * 软删（`deleted_at` 置时间戳），幂等：重复删返回 0 行。
 *
 * 参数顺序：1. deleted_at  2. updated_at  3. id  4. owner_id
 */
export const SQL_SOFT_DELETE_CANVAS = `
UPDATE canvases
   SET deleted_at = ?,
       updated_at = ?
 WHERE id = ?
   AND owner_id = ?
   AND deleted_at IS NULL
`;

/**
 * 读完整画布（含 doc）。**只有详情接口**用它；revision 探针不能读 doc。
 *
 * 参数顺序：1. id  2. owner_id
 */
export const SQL_SELECT_CANVAS_DETAIL = `
SELECT id, owner_id, title, doc, revision, node_count, thumbnail_asset_id,
       updated_by_device, created_at, updated_at, deleted_at
  FROM canvases
 WHERE id = ?
   AND owner_id = ?
`;

/**
 * 轻量版本探针（不读 doc —— doc 可能有 8MB，探针必须廉价）。
 *
 * 参数顺序：1. id  2. owner_id
 */
export const SQL_SELECT_CANVAS_REVISION = `
SELECT revision, updated_at
  FROM canvases
 WHERE id = ?
   AND owner_id = ?
   AND deleted_at IS NULL
`;

/**
 * 列表（不含 doc），带 openJobCount。
 *
 * `open_job_count` 用相关子查询算，而不是 "先查画布再 N 次查任务"：
 * `ix_jobs_canvas_status (canvas_id, status)` 正好覆盖，成本近似常数。
 * T02 阶段 jobs 表为空 → 恒为 0，等价于验收要求的"占位 0"，
 * 但 T03 落地后无需改这条 SQL 就已经是对的。
 *
 * 参数顺序：1. owner_id  2. limit  3. offset
 */
export const SQL_SELECT_CANVAS_LIST = `
SELECT c.id, c.title, c.revision, c.node_count, c.thumbnail_asset_id,
       c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM jobs j WHERE j.canvas_id = c.id AND j.status IN ('queued', 'running')) AS open_job_count
  FROM canvases c
 WHERE c.owner_id = ?
   AND c.deleted_at IS NULL
 ORDER BY c.updated_at DESC
 LIMIT ? OFFSET ?
`;

// =============================================================================
// jobs（T02 只读，写入在 T03）
// =============================================================================

/**
 * 某画布当前未完成的任务（详情接口一次性返回，避免前端二次往返）。
 *
 * 参数顺序：1. canvas_id
 */
export const SQL_SELECT_OPEN_JOBS = `
SELECT id, node_id, type, capability, model, status, progress, stage,
       error_code, error_message, created_at, started_at, updated_at
  FROM jobs
 WHERE canvas_id = ?
   AND status IN ('queued', 'running')
 ORDER BY created_at ASC
`;

// =============================================================================
// users
// =============================================================================

/** 用户总数（判断"是否需要初始化"）。无参数。 */
export const SQL_COUNT_USERS = `SELECT COUNT(*) AS total FROM users`;

/** 按邮箱查用户。参数：1. email（调用方负责 lowercase） */
export const SQL_SELECT_USER_BY_EMAIL = `
SELECT id, email, password_hash, display_name, role, is_disabled, created_at, updated_at, last_login_at
  FROM users
 WHERE email = ?
`;

/** 按 id 查用户。参数：1. id */
export const SQL_SELECT_USER_BY_ID = `
SELECT id, email, password_hash, display_name, role, is_disabled, created_at, updated_at, last_login_at
  FROM users
 WHERE id = ?
`;

/**
 * 建用户。参数顺序：1. id 2. email 3. password_hash 4. display_name 5. role 6. created_at 7. updated_at
 */
export const SQL_INSERT_USER = `
INSERT INTO users (id, email, password_hash, display_name, role, is_disabled, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, 0, ?, ?)
`;

/** 更新最后登录时间。参数：1. last_login_at 2. updated_at 3. id */
export const SQL_TOUCH_USER_LOGIN = `
UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?
`;

// =============================================================================
// sessions
// =============================================================================

/**
 * 建会话（DB 只存 token 的 sha256，不存原文）。
 *
 * 参数顺序：1. id 2. user_id 3. token_hash 4. device_label 5. user_agent 6. ip
 * 7. remember 8. created_at 9. last_seen_at 10. expires_at
 */
export const SQL_INSERT_SESSION = `
INSERT INTO sessions (id, user_id, token_hash, device_label, user_agent, ip, remember, created_at, last_seen_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * 校验会话并带出用户（一次 JOIN 搞定，避免两次查询）。
 *
 * 参数顺序：1. token_hash  2. now（ISO8601，用于 expires_at 比较）
 */
export const SQL_SELECT_SESSION_WITH_USER = `
SELECT s.id            AS session_id,
       s.user_id       AS user_id,
       s.expires_at    AS expires_at,
       s.revoked_at    AS revoked_at,
       u.email         AS email,
       u.display_name  AS display_name,
       u.role          AS role,
       u.is_disabled   AS is_disabled
  FROM sessions s
  JOIN users u ON u.id = s.user_id
 WHERE s.token_hash = ?
   AND s.revoked_at IS NULL
   AND s.expires_at > ?
`;

/**
 * 吊销会话（logout）。参数：1. revoked_at 2. token_hash
 */
export const SQL_REVOKE_SESSION = `
UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
`;

/** 刷新 last_seen_at（节流由调用方控制）。参数：1. last_seen_at 2. id */
export const SQL_TOUCH_SESSION = `UPDATE sessions SET last_seen_at = ? WHERE id = ?`;

/** 清理过期/已吊销会话。参数：1. now */
export const SQL_PURGE_SESSIONS = `
DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)
`;
