# QA 独立复审报告 —— T01 (26bc9eb) + T02 (af8c666)

- 复审人：QA（严过关）
- 复审方式：**只读静态复审** + `node`（22.22.2）纯逻辑实测；本机无 bun / docker，涉运行时项标「待运行验证」
- 复审范围：`server/src/**`、`server/migrations/0001_init.sql`、`server/Dockerfile`、`deploy/**`
- 基线：分支 `stable`，HEAD `af8c666`，工作区干净
- 工程师自检脚本 `node scripts/verify-t02.mjs` 复审时实跑：**66 项全绿**（下文 P0-1 / P1-1 均为该脚本未覆盖的盲区）

---

## 0. 结论摘要

| 项目 | 数量 |
| --- | --- |
| P0（阻断） | **2** |
| P1（应修） | **5** |
| P2（建议） | **15** |

**是否放行进入 T04：不建议直接放行。**
必须先修 **P0-1（首次保存丢图，主流程数据丢失）** 与 **P0-2（资产 MIME 无白名单，同源直出 → 存储型 XSS）**，并建议同批修掉 **P1-1（doc 清洗可被绕过）**。这三项合计改动量很小（约 40 行），修完即可叠 T03/T04。P1-2 可随 T03 的 assets 逻辑一起定案。

---

## P0 —— 阻断

### P0-1　首次保存画布时，内联图片 100% 被丢弃（外键先于主表插入）

- **文件**：`server/src/services/canvas-service.ts:257-258`、`:275-291`；`server/src/services/asset-service.ts:103-105`、`:86-97`；`server/migrations/0001_init.sql:219`；`server/src/db/client.ts:111`
- **问题**：
  `putCanvas` 的执行顺序是「先清洗（会落盘并写 `assets` 行）→ 后 `insertCanvas`」。
  清洗时的 ingest 回调由 `createDocIngest(user.id, id)` 构造，会把 **`canvasId = 目标画布 id`** 写进 `assets.canvas_id`：

  ```ts
  // canvas-service.ts:257
  const ingest = createDocIngest(user.id, id);      // canvasId = 尚未存在的画布 id
  const { doc: cleaned, stats } = await sanitizeCanvasDoc(input.doc, ingest);
  ...
  if (input.baseRevision === 0) { insertCanvas({ id, ... }); }   // :275 才开始插画布
  ```

  而 `assets.canvas_id TEXT REFERENCES canvases (id)`（`0001_init.sql:219`）是**立即生效**的外键（`PRAGMA foreign_keys = ON`，`client.ts:111`），SQLite 在插入 `assets` 时就要能查到对应 `canvases` 行。于是：

  - `baseRevision = 0`（**新建画布**）→ `INSERT INTO assets ... canvas_id='cvNEW'` → `FOREIGN KEY constraint failed`
  - 该异常被 `doc-sanitizer.ts:298-306` 的 `tryIngest` 的 `catch` **吞掉** → `stats.dropped += 1` → 该 `content` 被置为 `""`，且**不会补 `storageKey`**
  - 结果：`insertCanvas` 成功、HTTP 返回 201，但**画布里那张图没了**

  实测（`node:sqlite` + 真实 `0001_init.sql`）：

  ```
  --- 场景 A：先写资产（canvas 尚不存在）---
  资产写入失败 → FOREIGN KEY constraint failed
  --- 场景 B：canvas_id = NULL ---
  资产写入成功（canvas_id=NULL 可用）
  ```

- **影响面**：正是「粘贴/导入带内联 base64 的画布」这一清洗模块存在的**唯一理由**场景，首次保存必丢。后续（`baseRevision>=1`）保存正常，所以表现为「第一次存就少图，存第二次又好了」——极难排查。
- **可见性**：非完全静默——响应体 `data.sanitize.dropped` / `warnings` 与响应头 `x-doc-dropped` 会有值（`canvas-service.ts:100-102`），但前端若未消费就等同于静默。
- **修法（择一，推荐 ①）**：
  1. **新建时 ingest 不绑定画布**：`const ingest = createDocIngest(user.id, input.baseRevision === 0 ? null : id);`（一行）。`assets.canvas_id` 允许 NULL，且它只是「按画布列举」的便利字段，不是一致性依据。
  2. 或把 `insertCanvas` 提到清洗之前（先插一条空 doc 的画布占位），清洗后再 CAS 写入 doc。逻辑更重，且要为失败补回滚。
  3. 或把 `assets.canvas_id` 改成 `REFERENCES canvases(id) DEFERRABLE INITIALLY DEFERRED`（SQLite 支持，但需要额外 `PRAGMA defer_foreign_keys` 配合，不推荐）。
- **回归测试**：`verify-t02.mjs` 的 ingest 用的是 `fakeIngest`，从不触碰 DB，因此完全没覆盖这条路径。**建议补充**：用真实 `upsertAsset` + 真实 schema，在 `baseRevision=0` 下跑一次 `putCanvas` 等价流程，断言 `assets.canvas_id` 可写入且 `stats.dropped === 0`。

---

### P0-2　资产 MIME 完全由请求头决定并被同源直出 → 存储型 XSS

- **文件**：`server/src/services/asset-service.ts:136`、`:285-293`；`server/src/routes/assets.ts:83`、`:124`、`:129`；`server/src/storage/key.ts:222-231`
- **问题**：
  1. `PUT /api/assets` 取 `Content-Type` 头原样当 MIME：`const declaredMime = c.req.header("content-type") ?? "application/octet-stream"`（`assets.ts:83`）；
  2. `normalizeMime` 只要不是空/`octet-stream` 就**原样保留**（`asset-service.ts:287`）——`text/html`、`image/svg+xml`、`application/xhtml+xml` 全部放行，且**不校验与 `storageKey` 前缀是否匹配**；
  3. `extensionFromMime("text/html")` → `"html"`（`key.ts:228-230`），落盘为 `{yyyy}/{mm}/<sha>.html`；
  4. 读取时 `Content-Type: opened.row.mime || "application/octet-stream"`（`assets.ts:124`）直接回写 `text/html`；`nosniff` 已设但**无效**（我们自己声明了 `text/html`）；
  5. 资产与 SPA **同源**（`deploy/Caddyfile:31-48`，`/api` 与静态页同域），因此该 HTML 里的 `<script>` 以**本站 Origin** 执行，`ic_session`（HttpOnly，但同源 `fetch` 会自动携带）可被用来调任意 API。

  实测 `decodeDataUrl` 侧同样不设防（内联 base64 也走这条路）：

  ```
  G html mime accepted => {"mime":"text/html","n":25,"head":"<script>alert(1)</script>"}
  ```

- **为什么按 P0 计**：T02 单体看，唯一的写入方是「已登录的 owner」→ 属 self-XSS，可利用性低。但 `ingestAssetBytes` 是 T03 生成结果落库的**唯一通道**（`asset-service.ts:64-100`，注释明写「供 doc 清洗与 T03 的上游生成结果复用」），T03 一旦按上游响应的 `Content-Type` 落库，恶意/被劫持的上游即可写入 `text/html` —— 届时就是**远程存储型 XSS → 会话内越权 → 画布与渠道密钥全泄露**。本复审的判定口径就是「能否在 T02 之上叠 T03」，故列 P0。
- **修法**：
  1. `asset-service.ts` 增加 MIME 白名单，非白名单一律归一为 `application/octet-stream`（并强制 `kind=file`）：
     ```ts
     const ALLOWED_ASSET_MIME = /^(image\/(png|jpeg|webp|gif|avif|bmp|tiff)|video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|ogg|aac|flac|webm)|application\/octet-stream|application\/pdf)$/;
     ```
     **明确剔除 `image/svg+xml`**（SVG 可内嵌脚本，同源直出同样致命）。
  2. `routes/assets.ts` 输出侧再加一道：`Content-Disposition: inline; filename="<sha>"` + `Content-Security-Policy: default-src 'none'; sandbox`（对 `application/octet-stream` 用 `attachment`）。
  3. `Caddyfile` 的 `/api/*` 块补 `header X-Content-Type-Options nosniff` 与站点级 CSP（见 P2-14）。
  4. `doc-sanitizer.decodeDataUrl` 同样收紧 mime（见 P2-4）。

---

## P1 —— 应修

### P1-1　doc 清洗可被两种方式绕过，「DB 里绝不出现 `data:`」的验收底线不成立

- **文件**：`server/src/services/doc-sanitizer.ts:170-174`（深度截断）、`:205-210`（`storageKey` 透传）
- **问题 A（深度绕过，已实测）**：`walk` 在 `depth > 64` 时**原样返回整个子树**：

  ```ts
  if (depth > MAX_DEPTH) { pushWarning(...); return value; }   // :171-174
  ```

  把 base64 埋到第 65 层即可原样入库。实测：

  ```
  DEPTH_BYPASS_RESULT= "data:image/png;base64,iVBORw0KGgo="
  stats= {"extracted":0,"blobCleared":0,"dropped":0,"warnings":["doc 嵌套层级超过 64，已截断"]}
  ```

  注意 `dropped` 仍为 0，所以 `x-doc-dropped` 也不会提示。
- **问题 B（`storageKey` 不过滤）**：`key === "storageKey"` 直接 `output[key] = raw`（`:207-210`），若该字段本身就是 `data:...;base64,...` 则原样保留。实测：

  ```
  A storageKey passthrough => {"nodes":[{"metadata":{"storageKey":"data:image/png;base64,AAAAAAAA","content":""}}]}
  ```

- **影响**：文件头注释（`:152-157`）与 `verify-t02.mjs:291-296` 断言的「返回的 doc 中任何位置都不再出现 `data:*;base64,`」被证伪。虽因 `canvas-service.ts:261-269` 的 8MB 落库闸门仍在，不会把 DB 撑到无限大，但**脏数据能进库**，且 T05 的孤儿清理会基于错误前提工作。
- **修法**：
  - 深度超限时**抛错**（`ApiError.validation("doc 嵌套层级过深")`）或返回 `null`/`""` 而不是返回原值；最省事的是把 `MAX_DEPTH` 命中改为「整棵子树替换为 `null` 并计入 `dropped`」。
  - `storageKey` 字段加形状校验：不匹配 `STORAGE_KEY_PATTERN` 且是 data/blob URL 时置 `""` 并计 `dropped`。

### P1-2　跨用户内容去重把 `storageKey` 判给首个上传者；引用计数分支不可达

- **文件**：`server/src/services/asset-service.ts:73-76`、`:148-153`、`:196-198`；`server/src/db/repos/assets.ts:145-147`、`:173-178`；`server/migrations/0001_init.sql:241`
- **问题**：`ux_assets_sha256_driver ON (sha256, storage_driver)` 是**全局**唯一（无 `owner_id`），`findAssetBySha` 也不按 owner 过滤。于是第二个用户上传**相同字节**时，`putAsset` 会把**第一个用户的行**（含其 `storage_key`）当作结果返回；但 `openAsset` 又用 `row.owner_id !== ownerId → 404` 做租户隔离 —— 两边自相矛盾。实测：

  ```
  uB 的去重命中行 = {"owner_id":"uA","storage_key":"image:KA"} → 返回给 uB 的 storageKey = image:KA
  INSERT 被拒绝 → UNIQUE constraint failed: assets.sha256, assets.storage_driver
  uB GET image:KA → 404（图片在 uB 的画布里失效）
  ```

  同一路径 `ingestAssetBytes`（`:73-76`）也被 doc 清洗与 T03 复用，所以「两个用户粘贴同一张网图」= 后者画布图裂。
  另：因为该唯一索引保证同内容**永远只有一行**，`removeAsset:249` 的 `countAssetsBySha(...) === 0` **引用计数分支实际不可达**（永远为 0），注释里「同 sha 多引用时不要误删」的保护是失效的假象。
- **修法（择一）**：
  1. 唯一索引改为 `(sha256, storage_driver, owner_id)`，`findAssetBySha` 加 `AND owner_id = ?`，`countAssetsBySha` 也带 owner（**物理文件仍按 sha 全局共享，引用计数需跨 owner 统计**，两者要分开设计：DB 唯一性按 owner，物理文件回收按全局 sha）。
  2. 或保留全局唯一，但把 `openAsset` 的隔离改成「`storage_key` 全局可读、仅所有者可删/可列举」——即放弃按 owner 判 404，改为按「是否被该 owner 的 doc 引用」判定（成本高，不推荐）。
  3. 最短临时方案：`putAsset`/`ingestAssetBytes` 命中 `bySha` 时，为当前 owner **另建一行 **alias**（不同 `storage_key`、同 `sha256`）**——但需要先放开唯一索引，仍回到方案 1。
- **优先级说明**：当前 `ALLOW_REGISTRATION=false` 且 `/api/setup` 只允许第一个用户，单用户下不可触发，故列 P1 而非 P0；但它直接违反 T02 自己声明的「`owner_id` 是多租户隔离依据」，且 T03 的生成结果落库会高频复用该函数，建议与 P0-2 同批修。

### P1-3　媒体文件（用户真正的数据）从未被备份

- **文件**：`deploy/docker-compose.yml:143-168`；`deploy/.env.example:75-85`；`deploy/backup/backup.sh:27`、`:124-134`
- **问题**：`backup.sh` 支持 `BACKUP_INCLUDE_MEDIA=true`，但 **compose 的 `backup.environment` 与 `.env.example` 都没有这个变量**，`INCLUDE_MEDIA` 恒为 `false`。于是备份只覆盖 `app.db`（画布 JSON），**`/data/media` 下所有图片/视频零备份**。
  `docker-compose.yml:171` 的注释还写着「单卷策略：app.db + -wal + media + backups 全在 /data，便于整体打包迁移」，容易让人误以为媒体也在备份里。
- **修法**：compose 增 `BACKUP_INCLUDE_MEDIA: ${BACKUP_INCLUDE_MEDIA:-true}`，`.env.example` 补该键并写清「媒体是全量打包，大磁盘场景注意 tar 峰值」。若不打算备份媒体，则必须在文档与 `/api/health` 里显式声明，而不是留一个默认关闭的开关假装支持。

### P1-4　`server/` 无 lockfile，镜像构建不可复现

- **文件**：`server/Dockerfile:20-24`
- **问题**：仓库中不存在 `server/bun.lock`（已确认 MISSING），Dockerfile 只能 `RUN bun install --production`，依赖版本按 `^4.6.14` / `^3.24.1` 浮动解析。后果：同一 commit 两次构建可能装到不同版本的 `hono`/`zod`；也无法审计供应链。Dockerfile 注释自己承认了这点。
- **修法**：在任一有 bun 的环境 `bun install` 生成并提交 `server/bun.lock`，随后改 `RUN bun install --frozen-lockfile --production`。若本机始终无 bun，可用 `oven/bun` 容器一次性生成后提交。

### P1-5　`backup.sh` 压缩阶段失败不会写审计行 → 备份静默失败

- **文件**：`deploy/backup/backup.sh:115-117`（`gzip -c "$TMP_DB" > "$DB_OUT"`）
- **问题**：脚本的 `record_audit` 只在 **snapshot 连续失败**（`:108`）与 **rclone 失败/缺失**（`:148`/`:159`）三条路径被调用。`mkdir -p "$STAGE_DIR"`（`:69`）、`gzip`（`:115`）、以及磁盘写满导致的任何写入失败，都会在 `set -eu` 下**直接 `exit`，不写审计行**，`backups` 表里看不到这次失败。运维只能翻 `docker logs`。
  半截的 `.gz` 也不会被清理（只 `rm -f "$TMP_DB"`，`:87`），要靠 14 天后的 `-mtime` 才被扫掉。
- **修法**：入口即注册 `trap 'record_audit failed 0 0 0 "aborted at line $LINENO"' EXIT`（成功路径先置 `ok=1` 让 trap 跳过），并把 `rm -f "$DB_OUT"` 加进 cleanup，保证「要么有成品的审计行，要么有失败行」。

---

## P2 —— 建议（按影响排序）

| # | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| P2-1 | `server/src/routes/canvases.ts:56` | `total: items.length` —— 返回的是**本页条数**，不是总数。前端若用它做分页会永远只有 1 页 | 加一条 `SELECT COUNT(*) ... WHERE owner_id=? AND deleted_at IS NULL`，或用 `SQL_SELECT_CANVAS_LIST` 的窗口函数 `COUNT(*) OVER ()` |
| P2-2 | `server/src/services/canvas-service.ts:271`、`:318`；`canvas-sql.ts:50-63` | CAS 无条件 `title = ?`。客户端 PUT 不带 `title` 且 `doc.title` 缺失时会用 `"未命名画布"` **覆盖**已有标题（静默丢失用户命名） | `title` 缺省时用 `COALESCE(title, ?)` 或干脆不出现在 UPDATE 的 SET 里（用两条 SQL 按是否有 title 分派） |
| P2-3 | `server/src/services/doc-sanitizer.ts:212-227` + `:176-188` | `MEDIA_FIELD_NAMES` 含 `content`，而 `CanvasNodeMetadata.content` 是**文本节点正文**；且裸字符串（任意字段）都会被当媒体处理。实测 `{type:'text', metadata:{content:'blob:abc 是我的笔记正文'}}` → `content: ""`（正文被清空）。同理 `prompt` 里的 data URL 也被清空 | 正文类字段（`content` 出现于 `type==='text'` 时、`prompt`、`composerContent`、`errorDetails`）加白名单旁路；裸字符串只在「看起来像 `data:<mime>;base64,` 且长度 > 某阈值」时才处理 |
| P2-4 | `server/src/services/doc-sanitizer.ts:107-123` | `decodeDataUrl` 接受任意 mime（`text/html` 实测通过），与 P0-2 同根因 | 与 P0-2 共用同一份 mime 白名单，非白名单直接 `dropped` |
| P2-5 | `server/src/services/asset-service.ts:86-97`（`canvasId` 来自 `routes/assets.ts:82` query） | `canvasId` 未校验归属，也不校验存在性：① 传别人的画布 id → asset 行挂到别人画布（未来 `listAssetsByCanvas` 一暴露就是越权）；② 传不存在的 id → FK 报错 → **500 INTERNAL** 而不是 400/404 | 查 `canvases` 并断言 `owner_id === ownerId`，非法返回 400；把 FK 错误翻译成 4xx |
| P2-6 | `server/src/db/repos/assets.ts:168-170`、`canvas-sql.ts:135-142` | `listAssetsByCanvas` 与 `SQL_SELECT_OPEN_JOBS` **都不带 owner 过滤**。当前调用点安全（`listOpenJobs` 仅在 `getCanvasDetail` 的归属校验之后调用），但这是纯靠调用顺序维持的不变量，T03 一加路由就可能是 IDOR | SQL 层就带上 owner（`JOIN canvases c ON c.id = assets.canvas_id AND c.owner_id = ?`），别把安全交给调用顺序 |
| P2-7 | `server/src/services/canvas-service.ts:257-269` | 清洗（会真实落盘 + 写 assets 行）在体积闸门之前，8MB 闸门一旦 413，已写入的资产成为**孤儿文件** | 落盘前先估算清洗后体积，或失败时回滚本次 ingest（记录 key 列表并补偿删除） |
| P2-8 | `server/src/routes/assets.ts:132-135`；`asset-service.ts:204` | 416 响应未带 `Content-Range: bytes */<size>`（RFC 7233 §4.4 要求）；404 的 `details` 里回传了内部 `relPath`（`{yyyy}/{mm}/{sha}.ext`）与 `storageKey` | 416 用 `c.header("Content-Range", \`bytes */${size}\`)`；404 的 details 删掉 `relPath` |
| P2-9 | `deploy/backup/backup.sh:62-66` + `deploy/docker-compose.yml:160-163` | 备份容器以 **root** 直接 `sqlite3` 写生产库做审计 INSERT（compose 注释却写「只读 DB」）。若 checkpoint 后 `-wal`/`-shm` 被 root 重建，属主会变成 root，随后 `bun` 身份的服务端写入会失败 | 审计改为「先 `.backup`，再对**快照副本**写审计」或通过一个 `/api/internal/backup-report` 上报；至少把卷里的属主用 `chown bun:bun` 收尾 |
| P2-10 | `server/migrations/0001_init.sql:57` | `sessions` 只有 `(user_id, expires_at)` 索引，`SQL_PURGE_SESSIONS`（`expires_at <= ? OR revoked_at <= ?`）**全表扫**；且 `purgeSessions()` 只在 `index.ts:86` 启动时跑一次，长跑容器里 sessions 会持续膨胀 | 加 `CREATE INDEX ix_sessions_expires ON sessions (expires_at)`；把 purge 挂到一个低频定时器（如每小时） |
| P2-11 | `server/src/auth/rate-limit.ts:51` | key 只有 `ip|account`，**没有纯 IP 桶**：单 IP 可以对 N 个账号各试 5 次/分（密码喷洒/撞库不受限）。另 `routes/auth.ts:86` 的 `remember !== false` 让**默认**是 30 天持久 Cookie | 增加 `ip` 维度的兜底桶（如 30 次/分/IP）；`remember` 改为显式 `=== true` 才持久化 |
| P2-12 | `server/src/http/respond.ts:51-63` | `handleError` 只特判 `ApiError`，Hono 内部抛的 `HTTPException`（400/413/414 等）会被降级成 **500 INTERNAL**，日志里还会打成「未处理异常」 | 先判 `error instanceof HTTPException`，用其 `status` 映射到最近的 `ErrorCode` |
| P2-13 | `server/src/routes/setup.ts:92-109` | `db.exec("BEGIN IMMEDIATE")` 不在 try 内；`catch` 里的 `db.exec("ROLLBACK")` 若本身失败会**掩盖原始异常**（`set` 无事务状态检查） | `BEGIN` 放进 try；`ROLLBACK` 用 `try { } catch {}` 包裹，再 `throw error` |
| P2-14 | `deploy/Caddyfile:23-61` | 缺站点级安全响应头：无 CSP、无 `X-Frame-Options`、无 `Referrer-Policy`；`/api/*` 侧也没有 `X-Content-Type-Options`（只在 `assets.ts:129` 单点设了） | 站点块加 `header { -Server; X-Frame-Options DENY; Referrer-Policy no-referrer; X-Content-Type-Options nosniff; Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; frame-ancestors 'none'" }`。这是 P0-2 的纵深防御 |
| P2-15 | `deploy/Caddyfile:23`；`server/src/http/request.ts:29-33` | XFF 取**首段**。已核 Caddy 官方文档：未配置 `trusted_proxies` 时 Caddy **忽略**客户端传入的 `X-Forwarded-*` 并自行写入真实 IP，故当前 compose（只 caddy 暴露端口）**不可利用**。但一旦将来前面加 CDN 并配置 `trusted_proxies`，首段就变回客户端可控 → 限流可绕过 | 改取**最后一段**（`forwarded.split(",").at(-1)`），或在 Caddy 显式写 `servers { trusted_proxies private_ranges }` 并把该假设写进注释 |

补充两个小项（并入上表口径，不单列编号）：
- `server/Dockerfile` 未 `COPY scripts/`，但 `package.json:16` 暴露了 `user:create` → 容器内 `bun run user:create` 必然失败（`/api/setup` 已覆盖该场景，但文档/脚本存在性不一致）。
- `deploy/rclone/` 目录未入库，`docker-compose.yml:163` 的 `./rclone:/config/rclone:ro` 会由 Docker 自动建成 root 属主空目录；建议提交一个 `.gitkeep` + 注释。（后于 `ee47e8c` 迁移到 `/root/.config/rclone`，见 `docs/DEPLOY-VPS.md` 6.4）
- `server/src/routes/canvases.ts:95`：`readJsonBody` 在 `requireCanvasId` 之前，非法 id 也会先把 200MB body 读进来（Bun `maxRequestBodySize` 兜底，故仅浪费）。

---

## 已检查、未发现问题的模块（附依据）

| 模块 | 结论与依据 |
| --- | --- |
| `auth/password.ts` | argon2id + `m=19456, t=2`（OWASP 首选）✓；`verifyPassword` 对脏 hash 返回 `false` 不抛错（`:66-73`）✓；`isPasswordHash` 正则 `^\$argon2(id|i|d)\$` 可挡住明文误写 ✓。`PASSWORD_MAX_LENGTH=256` 顺带封住超长口令 DoS ✓ |
| `auth/tokens.ts` | `randomBytes(32)` = 256bit ✓；入库存 `sha256` hex 64 字符，与 `sessions.token_hash TEXT` + `ux_sessions_token_hash` 唯一索引对齐 ✓；`looksLikeSessionToken` 严格 43 字符 base64url（`32B → 43` 换算正确）✓；原文不出现在任何 DB/日志写入点（`grep createSessionToken` 仅 `issueSession` 一处）✓ |
| `auth/session.ts` | 单条 JOIN 同时判 `token_hash` + `revoked_at IS NULL` + `expires_at > now`（`canvas-sql.ts:198-212`）✓；`is_disabled=1` 直接视为无会话（`session.ts:109`）✓；`revokeCurrentSession` 真做 `UPDATE sessions SET revoked_at`（`:154`）→ 下次请求 JOIN 即失效 ✓；Cookie 四属性齐备 `HttpOnly/Path=//SameSite=Lax/secure(env)`（`:78-85`），`clearSessionCookie` 属性与原 Set 一致（否则删不掉）✓；`lastTouchedAt` 节流带 `delete`，不会无限泄漏 ✓ |
| `auth/middleware.ts` | `SETUP_REQUIRED`(403) vs `UNAUTHORIZED`(401) 分流正确 ✓；`currentUser/currentSessionId` 显式判空抛 INTERNAL ✓；`grep requireAuth` 审计：`canvases.ts:21`、`assets.ts:33` 全部受保护路由都已挂载，`auth/setup/health` 有意不挂 ✓ |
| `routes/auth.ts` | 哑 argon2 常量结构合法（salt 16B / hash 32B 的 base64 均已解码验证），`verifyPassword` 会真跑一次 KDF 而不是早退 → 时间侧信道对齐有效 ✓（**待运行验证**：Bun 版本是否接受该编码串）；用户不存在/密码错/被禁用统一 `INVALID_CREDENTIALS`(401) ✓；限流在 KDF **之前** ✓；`/logout` 幂等 204 ✓；`/me` 刻意 200+`user:null` 且不外泄 `password_hash`（`toSessionUserDto` 只取 4 字段）✓ |
| `rate-limit.ts` | 滑动窗口边界正确（`cutoff = now - 60_000`，`at > cutoff` 严格大于）✓；拒绝时**不累加**（避免攻击者给窗口续期）✓；`retryAfterSeconds` 至少 1 ✓；`pruneIfNeeded` 在 1024 桶后才清理，配合单实例部署可接受 ✓ |
| `canvas-sql.ts` / `canvases.ts` | CAS 是**单条** `UPDATE ... WHERE id=? AND owner_id=? AND revision=? AND deleted_at IS NULL RETURNING revision,updated_at`（`:50-63`）—— 参数顺序（doc,node_count,title,device,now,id,owner,base）与 repo 的 `.get(...)` 完全一致 ✓；软删带 `owner_id` + `deleted_at IS NULL` ✓；列表/详情/探针全部带 `owner_id` ✓ |
| 越权（IDOR）复核 | 逐个端点核过：`GET/PUT/DELETE /canvases/:id`、`GET /canvases`、`GET /:id/revision` 的每条 SQL 都含 `owner_id`；`openAsset`/`removeAsset` 都做 `row.owner_id !== ownerId → 404` ✓（`assets.canvas_id` 与 `listOpenJobs` 两处遗留见 P2-5/P2-6） |
| `storage/key.ts` | **用户 key 永不参与路径拼接**（只作 DB 条件）—— 这是全项目最关键的正确设计 ✓；`parseStorageKey` 5 层防御（`..` / 绝对路径 / 分隔符 / 控制字符 / 前缀白名单 / 字符白名单）✓；`isSafeRelPath` + `absolutePath` 的 `resolve` + `startsWith(root + sep)` 二次断言（`local-disk.ts:158-168`）✓；`extensionFromMime` 把任意 mime 清洗成 `[a-z0-9]{1,8}` 或 `bin`，**不存在扩展名注入** ✓ |
| Range 解析 | `parseRangeHeader` 语义与 `normalizeRange` 严格一致（内部统一**开区间**）：`bytes=0-0` → `{0,1}`、`bytes=-500` → `{size-500,size}`、`bytes=0-` → `{0}`、多区间 → `null`（按 RFC 允许忽略）✓；`local-disk.get` 正确把开区间转成 `createReadStream` 的闭区间（`end-1`）✓；`assets.ts:119-135` 的 `length = end-start` 与 `Content-Range: start-(end-1)/size` 互相自洽 ✓；`start >= size` / `end <= start` / 负值全部 416 ✓ |
| 原子写 / 并发 | `writeFile(.tmp-<rand>) → rename` 同目录原子替换 ✓，失败 `unlink` 补偿 ✓；并发写同 key 时第二次 `rename` 内容相同，无损坏 ✓；`stat` 先去重避免重复写 ✓（自检脚本已覆盖「无残留 .tmp」） |
| ETag / 304 | `ETag: "<sha256>"` 是内容寻址强 ETag，永不变 ✓；`matchesEtag` 处理 `*` / `W/` 前缀 / 逗号多值 ✓；304 不返回 body 且带 `Cache-Control: private` ✓ |
| `migrations/0001_init.sql` | 9 张表齐备；`CHECK` 覆盖 `role/is_disabled/remember/kind/storage_driver/status/type/capability/progress/retryable/attempt/max_attempts/revision/node_count/bytes/trigger` ✓；`ux_jobs_idempotency` 用**部分唯一索引** `WHERE idempotency_key IS NOT NULL` —— NULL 可重复、同值唯一，完全正确 ✓；`ix_canvases_owner_updated` 是 `(owner_id, updated_at DESC) WHERE deleted_at IS NULL` 部分索引，正好服务列表查询 ✓；`ix_jobs_queue (status, run_after, priority DESC, created_at)` 覆盖 T03 的 claim ✓；FK 级联方向正确（users→canvases→jobs 全 CASCADE，assets.canvas_id 与 canvases.thumbnail_asset_id 走 SET NULL 避免循环删除）✓；`canvases` 前向引用 `assets(id)` 在建表时不报错（SQLite 延迟解析），自检脚本已实证 ✓ |
| `http/errors.ts` / `respond.ts` | `ApiError` 的 `status` 由 `ERROR_CODES` 单一来源派生，**状态码与 code 不可能不一致** ✓；`INTERNAL` 只回 `traceId` + 「服务器内部错误」，堆栈只进服务端 `console.error`（`respond.ts:59-62`）✓；`handleNotFound` 只回显 method+path，`Content-Type: application/json`，无反射 XSS ✓；`RATE_LIMITED` 429 + `Retry-After` 头（`auth.ts:67`）✓ |
| `db/client.ts` 迁移执行器 | 以 `schema_migrations` 为唯一版本来源、逐文件校验 checksum（改过的已发布迁移直接拒绝启动）✓；单文件单事务 + 失败 ROLLBACK ✓；`journal_mode=WAL / synchronous=NORMAL / busy_timeout / foreign_keys=ON` 四个 pragma 都设了且 WAL 切换有实证校验 ✓ |
| `server/Dockerfile`（安全边界部分） | `USER bun` 非 root ✓；**无** python3/make/g++/node-gyp 等编译工具链 ✓（argon2 用 `Bun.password`、SQLite 用 `bun:sqlite`，零原生依赖，这个取舍是正确的）；HEALTHCHECK 打 `/api/health` 且 DB 不可用时该路由返回 503（`routes/health.ts:33-35`）→ 容器会被正确标记 unhealthy ✓；`/data` 预 `chown bun:bun` 让命名卷首次挂载继承属主 ✓ |
| `deploy/docker-compose.yml`（安全边界部分） | **只有 caddy 发布 80/443(+443/udp)**，server 用 `expose` 不 `ports` ✓；`AUTH_SECRET: ${AUTH_SECRET:?...}` 强制非空启动 ✓；`caddy`/`backup` 都 `depends_on: server: condition: service_healthy` ✓；`server.stop_grace_period: 30s` 给 Worker 优雅停机留时间 ✓；`ic` 网络故意是 bridge 而非 internal（必须出站访问 provider）且注释说明 ✓ |
| `deploy/Caddyfile` | `/api/*` 的 `handle` 块**没有** `encode`（gzip 会缓冲 SSE 帧）✓；`flush_interval -1` ✓；`read_timeout/write_timeout/response_header_timeout 15m` 覆盖 600s 视频任务 ✓；`request_body max_size 200MB` 与 server 的 `Bun.serve.maxRequestBodySize`（`index.ts:110`）**数值一致** ✓；`admin off` 减少攻击面 ✓；静态侧 `encode zstd gzip` 与 SPA fallback 交给 nginx，边界清晰 ✓ |
| `deploy/backup/backup.sh`（正确性部分） | 用 `sqlite3 .backup` 做在线快照而非 `cp`（WAL 下 `cp` 必然撕裂）—— 这点做对了 ✓；`set -eu` ✓；`.backup` 带 3 次退避重试 ✓；`sql_escape` 把 `'` 转成 `''`（SQLite 标准转义）✓；路径全部加引号、`find -maxdepth 1` 限定清理范围 ✓；`trap cleanup EXIT` 清临时快照 ✓；`crond -f` 作为 PID 1 前台运行、日志经 `/proc/1/fd/1` 进 `docker logs` ✓ |

---

## 待运行验证（本机无 bun/docker，未实测）

1. `oven/bun:1.3.13` 镜像 tag 是否存在（`apps.docker.com` 需联网确认）。
2. `Bun.password.verify` 是否原样接受 `DUMMY_ARGON2_HASH`（`routes/auth.ts:35`）—— 结构已静态验证合法（salt 16B / hash 32B），若 Bun 版本更严格而抛错，`verifyPassword` 的 catch 会**在跑 KDF 前**返回 `false`，时间侧信道防护失效。
3. `bun install --production` + `bun run src/index.ts` 在镜像内能否起来（`package.json` 只声明 `hono`/`zod`，无 lockfile）。
4. `deploy/docker-compose.yml` 的 `web` 服务用仓库根 `Dockerfile`（上游 nginx 产物）构建是否成功。
5. Caddy 的 `handle /api/*` 与 `handle` 块在真实流量下的 SSE 首字节延迟（`flush_interval -1` 是否足够）。
6. `PRAGMA foreign_keys=ON` 在 `bun:sqlite` 下的行为与 `node:sqlite` 一致（P0-1 的复现基于 `node:sqlite`，但两者语义应一致；建议在有 bun 的环境再跑一次 P0-1 的复现脚本）。

---

## 复现脚本（供工程师自测，不落仓）

```js
// 1) P0-1 复现：node --input-type=module
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync('migrations/0001_init.sql','utf8'));
const t='2026-10-05T00:00:00.000Z';
db.prepare("INSERT INTO users (id,email,password_hash,role,is_disabled,created_at,updated_at) VALUES ('u1','a@x','h','owner',0,?,?)").run(t,t);
// putCanvas(baseRevision=0) 的真实顺序：先 ingest(canvasId=cvNEW)，后 insertCanvas
db.prepare("INSERT INTO assets (id,owner_id,canvas_id,kind,storage_driver,storage_key,mime,bytes,sha256,created_at) VALUES ('a1','u1','cvNEW','image','local','image:K1','image/png',10,?,?)").run('a'.repeat(64),t);
// → 期望抛 FOREIGN KEY constraint failed

// 2) P1-1 复现：node --experimental-strip-types --input-type=module
const m = await import('./src/services/doc-sanitizer.ts');
let deep = { v: 'data:image/png;base64,iVBORw0KGgo=' };
for (let i = 0; i < 70; i++) deep = { child: deep };
console.log(JSON.stringify((await m.sanitizeCanvasDoc(deep, null)).doc).includes('base64')); // → true（本应为 false）
```

---

*本报告仅做只读复审，未修改任何源码，未产生任何 commit。*
