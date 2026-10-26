-- 0002_job_fencing.sql
-- -----------------------------------------------------------------------------
-- 两处来自 QA 第二轮复审（docs/QA-REVIEW-R2-d935b95.md）的修复。
--
-- 为什么不改 0001：迁移执行器（src/db/client.ts）对每个文件做 sha256 checksum
-- 校验，已执行过的迁移内容一旦变化就**拒绝启动**。所以修 schema 只能新增迁移。
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 1. 幂等键按用户隔离（QA R2 `P1-R2-4`：幂等键跨租户返回他人任务）
--
-- 0001 建的是 `UNIQUE(idempotency_key) WHERE idempotency_key IS NOT NULL`：
-- 索引里没有 user_id，SELECT 也没有 —— 于是 B 只要复用 A 用过的幂等键，
-- 就能拿到 A 的任务详情（含 result_storage_keys / upstream_task_id /
-- error_message），等于一个"猜键就能读别人结果"的信息泄露口。
--
-- 改法：索引与查询两边一起加 user_id。
--   索引是**独立**的 `CREATE UNIQUE INDEX`（不是表级 CONSTRAINT），
--   所以直接 DROP + CREATE 即可，不需要 SQLite 那套"建新表 + 搬数据 + rename"。
-- -----------------------------------------------------------------------------

DROP INDEX IF EXISTS ux_jobs_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_idempotency_user
    ON jobs (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. 备份审计行区分「媒体打包失败」与「有意不备份媒体」（QA R2 `P1-R2-5`）
--
-- 原表只有 media_files / media_bytes 两个数字。于是：
--   - tar 失败            → status=success, media_files=0
--   - 媒体目录不存在       → status=success, 且零日志
--   - 真的把 INCLUDE_MEDIA 关掉 → status=success, media_files=0
-- 三种情况产生的审计行**一模一样**，运维从设置页完全看不出"媒体其实没备份"。
-- 这正是 P1-3 想消灭的失败模式：媒体零备份但系统全绿，等恢复时才发现图全 404。
--
-- 加一列 media_expected：1 = 本次本来就该打包媒体（失败时 media_files=0 才是异常），
-- 0 = 有意只备份数据库。这样审计行自解释，不需要去翻 docker logs。
-- -----------------------------------------------------------------------------

ALTER TABLE backups ADD COLUMN media_expected INTEGER NOT NULL DEFAULT 0;
