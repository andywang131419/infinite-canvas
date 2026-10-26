# RUNBOOK —— 备份 / 恢复 / 排障（T03）

> 适用版本：`0.20.0-fork.1`（T01 骨架 + T02 数据层 + T03 任务系统）
> 读者：部署这套自托管实例的人（大概率就是你自己，半年后的某一天）。
> 目标：**在磁盘炸了、容器删了、或者自己被半夜叫醒时，不需要重新读代码就能恢复数据。**

---

## 1. 备份体系一览

这套系统有**两条**备份路径，产物格式一致（`app-<UTC时间戳>.sqlite.gz`），互不冲突：

| 触发方式 | 执行者 | 时机 | 快照手段 | 媒体打包 | 写 `backups` 审计行 |
|---|---|---|---|---|---|
| 定时（cron） | `deploy/backup` 容器（`backup.sh`） | `BACKUP_CRON`（默认每天 03:00） | `sqlite3 .backup` | `BACKUP_INCLUDE_MEDIA=true` 时 tar | 是（`trigger='cron'`） |
| 手动 | 服务端进程（`POST /api/backups/run`） | 你在设置页点一下 / curl | `VACUUM INTO` | ✗（只统计，不打包） | 是（`trigger='manual'`） |

为什么手动备份不直接调 `backup.sh`：服务端镜像里**没有** `sqlite3` CLI（只有 Bun 运行时）。
`VACUUM INTO` 是 SQLite 官方的在线快照能力（3.27+），在 WAL 模式下同样能拿到一致快照。

**媒体文件（`/data/media`）只有 cron 容器会打包。** 手动备份只统计文件数与字节数，
写进审计行便于估算体量 —— 如果你只用手动备份，恢复时图片/视频会全部变成 404（数据库里
有元数据、磁盘上没文件）。**务必保证 cron 容器的 `BACKUP_INCLUDE_MEDIA=true`。**

产物位置：

```
/data/backups/app-20260301T030000Z.sqlite.gz     # 数据库快照（压缩后）
/data/backups/media-20260301T030000Z.tar.gz      # 媒体（仅 cron + INCLUDE_MEDIA）
<rclone 远端>:<RCLONE_DEST>/                      # 若配置了 RCLONE_REMOTE
```

---

## 2. 手动备份：怎么点、怎么看

```bash
# 触发（需要 owner 会话 Cookie）
curl -X POST https://your.domain/api/backups/run \
     -H 'Content-Type: application/json' --cookie 'ic_session=<...>'
```

响应（201）关键字段：

```json
{
  "ok": true,
  "data": {
    "backup": { "id": "bk_...", "status": "success", "dbBytes": 5242880, "target": "/data/backups" },
    "file": "/data/backups/app-20260301T031500Z.sqlite.gz",
    "bytes": 5242880,
    "uploaded": false,
    "prunedFiles": 0
  }
}
```

判读要点：

- `uploaded: false` 且 `RCLONE_REMOTE` 为空 → **正常**，只有本地备份。
- `uploaded: false` 但日志里出现 `未找到 rclone 命令` → 部署漏装 rclone，**本地备份仍有效**，远端缺失。
- HTTP 409 `IDEMPOTENCY_DUPLICATE` → 上一次手动备份还没结束（进程内互斥），等几秒再试。
- HTTP 500 `BACKUP_FAILED` → 看服务端日志里的 `[backup] 手动备份失败：...`，
  最常见的两个原因：`/data/backups` 不可写（卷权限）、磁盘满（`VACUUM INTO` 需要约等于库大小的空余空间）。

审计行查询：

```bash
sqlite3 /data/app.db "SELECT status, db_bytes, target, started_at, finished_at, error_message
                      FROM backups ORDER BY started_at DESC LIMIT 10;"
```

或者 `GET /api/backups?limit=20`（返回 `items` 与 `latest`）。

---

## 3. 恢复演练（每季度做一次，别等真出事才第一次跑）

> 原则：**永远恢复到一个新目录、用新端口验证，不覆盖线上正在跑的实例。**
> 演练全程不要动 `/data/app.db`。

### 3.1 数据库恢复

```bash
# 0) 准备（演练用独立目录）
mkdir -p /tmp/drill && cd /tmp/drill

# 1) 取最新快照（本地或远端）
ls -lt /data/backups/app-*.sqlite.gz | head -3
rclone copy r2:ic-backup /tmp/drill --include 'app-*.sqlite.gz'   # 若用远端

# 2) 解压（注意保留原文件名，便于核对）
gunzip -c /tmp/drill/app-20260301T030000Z.sqlite.gz > /tmp/drill/restored.db

# 3) 完整性校验 —— 这一步不能跳
sqlite3 /tmp/drill/restored.db "PRAGMA integrity_check;"          # 必须输出 ok
sqlite3 /tmp/drill/restored.db "SELECT MAX(version) FROM schema_migrations;"  # 应为 1
sqlite3 /tmp/drill/restored.db "SELECT COUNT(*) FROM canvases WHERE deleted_at IS NULL;"
sqlite3 /tmp/drill/restored.db "SELECT COUNT(*), status FROM jobs GROUP BY status;"

# 4) 起一个隔离实例验证（不要用 8787，避免和线上抢）
docker run --rm -p 18787:8787 \
  -e DATABASE_PATH=/data/app.db \
  -e AUTH_SECRET='<与线上相同或不同的测试值>' \
  -e COOKIE_SECURE=false \
  -v /tmp/drill:/data \
  -v /data/media:/data/media:ro \
  ghcr.io/your/infinite-canvas-server:0.20.0-fork.1

# 5) 冒烟：登录 → 打开一张画布 → 看节点是否齐全、图片是否能显示
curl -s http://127.0.0.1:18787/api/health | head -c 400
```

### 3.2 媒体恢复

```bash
mkdir -p /tmp/drill/media
tar -xzf /data/backups/media-20260301T030000Z.tar.gz -C /tmp/drill
ls /tmp/drill/media | head
# 目录结构应为 media/<yyyy>/<mm>/<sha256>.<ext>（内容寻址，与文件名无关）
```

把解压出的 `media` 目录挂到演练实例的 `/data/media`（去掉 `:ro`），再检查任意一张图：
节点里的 `storageKey`（如 `image:V1StGXR8_Z5jdHi6B-myT`）能否返回 200。

### 3.3 恢复后的三条硬校验

| 检查 | 命令 | 期望 |
|---|---|---|
| schema 版本 | `SELECT MAX(version) FROM schema_migrations` | `1`（多一个迁移就应更大，不能更小） |
| 悬空资产 | `SELECT COUNT(*) FROM assets WHERE sha256 NOT IN (SELECT sha256 FROM assets)` | `0`（无意义，仅证明能查） |
| 未完成任务 | `SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')` | 恢复后可能 >0；**下一次启动时 Worker 会把过期租约重新排队或判失败** |

> 恢复后第一次启动会看到日志 `[worker] 启动回收过期租约：重新排队 N 个，判失败 M 个`，这是预期行为。

---

## 4. 演练记录表（复制一份，每次填）

| 日期 | 快照文件 | integrity_check | 画布数 | 登录 | 图片 | 耗时 | 执行人 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 2026-03-01 | app-20260301T030000Z | ok | 12 | ✓ | ✓ | 6min |  | 首次演练 |

---

## 5. 密钥与 `AUTH_SECRET`

- 渠道 API Key 用 **AES-256-GCM** 加密后存 `channels.api_key_cipher`，
  主密钥由 `AUTH_SECRET` 经 HKDF 派生（详见 `server/src/crypto/secret-box.ts`）。
- **换 `AUTH_SECRET` = 所有已存渠道密钥全部解不开**。表现：任务失败、错误码
  `PROVIDER_KEY_MISSING`，消息 "渠道密钥无法解密（AUTH_SECRET 可能已更换，请重新填写密钥）"。
  处理：到设置页把每个渠道的 Key 重新填一遍（只需填一次，不需要重建渠道）。
- 换 `AUTH_SECRET` 不需要重新登录之外的动作：会话 token 是不透明随机串 + 哈希存储，
  与 AUTH_SECRET 无关（见 `auth/session.ts`）。**但所有已发出会话仍然有效**，
  想强制全体下线就删 `sessions` 表里的行。
- 备份文件里含 `channels.api_key_cipher`，因此**备份包本身要当密文对待**：
  远端 bucket 必须私有，不要放公开链接。

---

## 6. 任务队列排障

### 6.1 任务一直 `queued` 不动

按顺序查：

```sql
-- ① 是不是 run_after 被退避到了未来？
SELECT id, type, attempt, max_attempts, run_after, created_at FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 10;

-- ② Worker 起来了吗？
SELECT key, value FROM app_settings WHERE key LIKE 'worker%';   -- 仅展示用；真实状态看 /api/health
```

```bash
curl -s http://127.0.0.1:8787/api/health | jq '.data.worker'
# { "enabled": true, "state": "idle", "registeredTypes": 5, "inFlight": 0, ... }
```

- `enabled: false` → `WORKER_ENABLED=false`（API-only 模式），改回 `true` 并重启。
- `registeredTypes: 0` → handler 注册失败，启动日志里应有异常（重复注册会直接抛错）。
- `state: "stopped"` 但 `enabled: true` → 进程刚起或正在停机，看日志。

### 6.2 任务卡在 `running`

租约到期后会被自动回收（启动时 + 每 15 个 tick）。手动加速：

```sql
-- 立刻把所有过期租约回收（等价于 Worker 启动时做的事）
UPDATE jobs SET status='queued', lease_until=NULL, run_after=datetime('now'),
                updated_at=datetime('now')
 WHERE status='running' AND lease_until < datetime('now') AND attempt < max_attempts;
```

**不要**直接 `UPDATE jobs SET status='failed'`：那会让"前端节点永久 loading"变成
"前端节点永久报错"，而重试本来可能成功。

### 6.3 担心重复计费

- `jobs.idempotency_key` 有部分唯一索引，同键重复提交只会得到**同一个** job
  （响应里 `created: false`，状态码 200 而不是 202）。
- 视频任务若进程在轮询中被 kill，重启后会重新提交上游任务 —— 这是已知的
  "可能多花一次钱"场景；`jobs.upstream_task_id` 里留着上一轮的 taskId，
  可以去上游后台核对并手动下载成品。

### 6.4 前端节点一直 loading

`GET /api/jobs?canvasId=<id>&open=true` 应返回该任务。若为空但节点仍 loading：
说明前端本地状态里留了一条"幽灵任务"（服务端已终态），刷新画布即可。
若返回的任务 `status='running'` 且 `updated_at` 十几分钟不动 —— 见 6.2。

---

## 7. 代理（Tier2）排障

`POST /api/proxy` 返回 403 时，`message` 会明确说是哪一道闸：

| message 片段 | 含义 | 处理 |
|---|---|---|
| `只允许 http/https` | 协议不对 | 用完整绝对 URL |
| `url 不得包含账号密码` | URL 里带 `user:pass@` | 凭据走渠道配置，不要写进 URL |
| `属于内网/保留地址` | 命中 SSRF 拦截（回环/私网/metadata） | 这是**故意**的；要访问自建内网网关，请改 `UPSTREAM_HOST_ALLOWLIST` 并理解风险 |
| `解析到内网地址` | 域名解析后指向内网（如 `127.0.0.1.nip.io`） | 同上 |
| `不在渠道白名单内` | host 不属于任何启用渠道的 baseUrl 主机 | 在设置页添加/启用对应渠道，或加到 `UPSTREAM_HOST_ALLOWLIST` |

流式回答"答到一半断"：检查是否有反代在缓冲。已加 `X-Accel-Buffering: no` 与
15s 一次的 `: keep-alive` 心跳；若仍断，请确认反代（Caddy/Nginx）没有额外的
`proxy_buffering on` 或更短的 `read_timeout`（T01 约定是 15m）。

---

## 8. 迁移与回滚

- 迁移只有前进方向：`server/migrations/0001_init.sql`、后续 `0002_*.sql`……
  执行器以 `schema_migrations.version` + `checksum` 双重校验，**已发布的迁移文件不可修改**
  （改了会因 checksum 不匹配而拒绝启动）。
- 回滚 = 恢复上一份备份的数据库文件 + 回退镜像 tag。**不要**手写 `DROP COLUMN`。
- 升级前请先手动备份一次（`POST /api/backups/run`），并在升级后核对
  `SELECT MAX(version) FROM schema_migrations;` 是否等于新镜像里的迁移数。

---

## 9. 磁盘水位

| 目录 | 内容 | 增长来源 | 清理方式 |
|---|---|---|---|
| `/data/app.db`（+ `-wal`） | 全部业务数据 | 画布 doc、任务参数 | 无自动清理；`backups` 审计行按 `BACKUP_DB_KEEP_DAYS` 裁剪 |
| `/data/media` | 图片/视频/音频（内容寻址，自动去重） | 生成结果、参考图 | 删节点不删文件；孤儿清理是 T05 任务 |
| `/data/backups` | 本地快照 | 每次备份 | `backup.sh` 按 `BACKUP_DB_KEEP_DAYS` 自动删；手动备份也会触发同样的清理 |

经验值：`VACUUM INTO` 需要**约等于数据库大小**的空余空间；`/data` 卷长期保持
≥ 20% 空闲，否则备份会以 `BACKUP_FAILED` 失败（这比静默产生半份快照好）。
