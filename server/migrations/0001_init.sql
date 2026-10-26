-- =============================================================================
-- 0001_init.sql — Infinite Canvas 自托管后端初始 schema
--
-- 依据：ARCH Rev2 §3.2 表定义 + §R4 数据模型 delta
-- 约定：ARCH §9.2 —— 表名/列名 snake_case；时间一律 TEXT ISO8601 UTC；
--       布尔用 INTEGER 0/1；主键 TEXT（crypto.randomUUID() 或前端 nanoid）。
--
-- 9 张表：
--   users / sessions / canvases / canvas_revisions / channels / jobs / assets /
--   backups / app_settings
--
-- 注意：本文件必须是**幂等**的（全部 IF NOT EXISTS）。迁移执行器本身按
--       schema_migrations.version 去重，这里的 IF NOT EXISTS 是第二道保险。
-- 注意：本文件**不得**包含 BEGIN/COMMIT —— 迁移执行器负责事务边界。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. users — 账号
-- 来源：§3.2 users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    role          TEXT NOT NULL DEFAULT 'owner',
    is_disabled   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT,
    CHECK (role IN ('owner', 'member')),
    CHECK (is_disabled IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (email);

-- -----------------------------------------------------------------------------
-- 2. sessions — 不透明会话 token（存 sha256，不存原文）
-- 来源：§3.2 sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    device_label TEXT,
    user_agent   TEXT,
    ip           TEXT,
    remember     INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT,
    CHECK (remember IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id, expires_at);

-- -----------------------------------------------------------------------------
-- 3. channels — 模型渠道（服务端密钥，Key 只写不读）
-- 来源：§3.2 `providers` + §R5「/api/channels」对齐上游 ModelChannel
--       {id,name,baseUrl,apiFormat,models[]}
--
-- `api_key_cipher` 为 AES-256-GCM 密文，主密钥由 AUTH_SECRET 经 HKDF 派生；
-- `api_key_hint` 是唯一允许回传前端的字段（形如 sk-****abcd）。
-- `models` 存 JSON 数组：[{ "name": "...", "capability": "image|video|text|audio" }]
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    base_url       TEXT NOT NULL,
    api_format     TEXT NOT NULL DEFAULT 'openai',
    models         TEXT NOT NULL DEFAULT '[]',
    api_key_cipher TEXT NOT NULL,
    api_key_hint   TEXT NOT NULL,
    extra          TEXT,
    is_default     INTEGER NOT NULL DEFAULT 0,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    CHECK (api_format IN ('openai', 'gemini')),
    CHECK (is_default IN (0, 1)),
    CHECK (enabled IN (0, 1))
);

CREATE INDEX IF NOT EXISTS ix_channels_owner ON channels (owner_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS ux_channels_owner_name ON channels (owner_id, name);

-- -----------------------------------------------------------------------------
-- 4. canvases — 画布文档（核心同步单元）
-- 来源：§3.2 canvases + §R4.1
--
-- id 直接使用前端 CanvasProject.id（nanoid）——前端 createProject() 生成后立即
-- 跳转 /canvas/{id}，服务端再发 id 会导致跳转后 404。
-- doc 存 CanvasProject 整体 JSON，不拆表。
-- revision 服务端维护，从 1 开始；新建时前端传 baseRevision=0。
--
-- 注意：thumbnail_asset_id 引用 assets(id)，而 assets 在第 7 段才创建。
--       SQLite 的外键是「延迟解析」的，建表时可前向引用，插入时该表已存在，安全。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canvases (
    id                 TEXT PRIMARY KEY,
    owner_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title              TEXT NOT NULL DEFAULT '未命名画布',
    doc                TEXT NOT NULL,
    revision           INTEGER NOT NULL DEFAULT 1,
    node_count         INTEGER NOT NULL DEFAULT 0,
    thumbnail_asset_id TEXT REFERENCES assets (id) ON DELETE SET NULL,
    updated_by_device  TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    deleted_at         TEXT,
    archived_at        TEXT,
    CHECK (revision >= 1),
    CHECK (node_count >= 0)
);

CREATE INDEX IF NOT EXISTS ix_canvases_owner_updated
    ON canvases (owner_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_canvases_owner_deleted
    ON canvases (owner_id, deleted_at);

-- -----------------------------------------------------------------------------
-- 5. canvas_revisions — 历史快照
-- 来源：§3.2 canvas_revisions
-- 策略：每 10 个 revision 存 1 份（revision % 10 == 0），保留最近 50 份。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canvas_revisions (
    id         TEXT PRIMARY KEY,
    canvas_id  TEXT NOT NULL REFERENCES canvases (id) ON DELETE CASCADE,
    revision   INTEGER NOT NULL,
    doc        TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_canvas_revisions ON canvas_revisions (canvas_id, revision);

-- -----------------------------------------------------------------------------
-- 6. jobs — 异步任务（租约 + 幂等 + 可恢复）
-- 来源：§3.2 jobs + §R4.3 delta
--
-- R4.3 相对 §3.2 的变更：
--   + channel_id        取代 provider_id/provider（R5: 「body 用 channelId 取代 provider」）
--   + capability        image | video | audio | text（对齐上游 ModelCapability）
--   + upstream_task_id  video 类 provider 侧 taskId（对应上游 metadata.videoTaskId）
--   ~ result_storage_keys 取代 result_asset_ids，元素形如 "image:xxx"
--
-- params 必须是可序列化 JSON，**禁止包含 apiKey / 参考图 base64**（参考图用 storage_key 引用）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    id                  TEXT PRIMARY KEY,
    canvas_id           TEXT NOT NULL REFERENCES canvases (id) ON DELETE CASCADE,
    node_id             TEXT NOT NULL,
    user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type                TEXT NOT NULL,
    channel_id          TEXT REFERENCES channels (id) ON DELETE SET NULL,
    capability          TEXT NOT NULL,
    model               TEXT NOT NULL,
    params              TEXT NOT NULL DEFAULT '{}',
    status              TEXT NOT NULL DEFAULT 'queued',
    progress            REAL NOT NULL DEFAULT 0,
    stage               TEXT,
    result_storage_keys TEXT,
    upstream_task_id    TEXT,
    error_code          TEXT,
    error_message       TEXT,
    retryable           INTEGER NOT NULL DEFAULT 0,
    attempt             INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 2,
    idempotency_key     TEXT,
    lease_until         TEXT,
    run_after           TEXT NOT NULL,
    priority            INTEGER NOT NULL DEFAULT 0,
    cost_estimate       REAL,
    cost_actual         REAL,
    created_at          TEXT NOT NULL,
    started_at          TEXT,
    finished_at         TEXT,
    updated_at          TEXT NOT NULL,
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
    CHECK (type IN ('image', 'image_edit', 'video', 'audio', 'llm')),
    CHECK (capability IN ('image', 'video', 'audio', 'text')),
    CHECK (progress >= 0 AND progress <= 1),
    CHECK (retryable IN (0, 1)),
    CHECK (attempt >= 0),
    CHECK (max_attempts >= 1)
);

-- 轮询 ?open=true 的主查询
CREATE INDEX IF NOT EXISTS ix_jobs_canvas_status ON jobs (canvas_id, status);
-- worker claim 的主查询
CREATE INDEX IF NOT EXISTS ix_jobs_queue ON jobs (status, run_after, priority DESC, created_at);
-- 幂等/防重复计费（可空，故用部分唯一索引而非列级 UNIQUE）
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_idempotency
    ON jobs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_jobs_user_created ON jobs (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 7. assets — 资产元数据
-- 来源：§3.2 assets + §R4.2
--
-- 【关键设计】storage_key **直接复用上游 storageKey 格式**：
--     image:{nanoid}  video:{nanoid}  audio:{nanoid}  file:{nanoid}
--     video-reference:{...}  audio-reference:{...}
-- 这样 doc 里所有 metadata.storageKey / metadata.images[].storageKey /
-- chatSessions[].messages[].references[].storageKey 一个字符都不用改。
--
-- uri/落盘路径：/data/media/{kind}/{nanoid 前 2 位}/{nanoid}（不含前缀冒号）。
-- id 用独立 UUID，避免 ":" 作主键带来的 URL/JSON 转义争议。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    canvas_id      TEXT REFERENCES canvases (id) ON DELETE SET NULL,
    job_id         TEXT REFERENCES jobs (id) ON DELETE SET NULL,
    kind           TEXT NOT NULL,
    storage_driver TEXT NOT NULL DEFAULT 'local',
    storage_key    TEXT NOT NULL,
    mime           TEXT NOT NULL,
    bytes          INTEGER NOT NULL,
    width          INTEGER,
    height         INTEGER,
    duration_ms    INTEGER,
    sha256         TEXT NOT NULL,
    prompt         TEXT,
    model          TEXT,
    meta           TEXT,
    created_at     TEXT NOT NULL,
    CHECK (kind IN ('image', 'video', 'audio', 'file')),
    CHECK (storage_driver IN ('local', 'cos', 'oss', 'minio')),
    CHECK (bytes >= 0)
);

CREATE INDEX IF NOT EXISTS ix_assets_canvas_kind ON assets (canvas_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS ux_assets_storage_key ON assets (storage_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_assets_sha256_driver ON assets (sha256, storage_driver);
CREATE INDEX IF NOT EXISTS ix_assets_job ON assets (job_id);
CREATE INDEX IF NOT EXISTS ix_assets_owner_created ON assets (owner_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 8. backups — 备份记录
-- 来源：§3.2 backups
-- 由 backup 容器写入（best-effort），供设置页展示。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backups (
    id            TEXT PRIMARY KEY,
    trigger       TEXT NOT NULL DEFAULT 'cron',
    status        TEXT NOT NULL DEFAULT 'running',
    db_bytes      INTEGER,
    media_files   INTEGER,
    media_bytes   INTEGER,
    target        TEXT,
    error_message TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    CHECK (trigger IN ('cron', 'manual')),
    CHECK (status IN ('running', 'success', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_backups_started ON backups (started_at DESC);

-- -----------------------------------------------------------------------------
-- 9. app_settings — KV 配置
-- 来源：§3.2 app_settings
-- 用途：默认模型分组、月度预算阈值、是否启用 TOTP 等。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
