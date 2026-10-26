# 已知问题与暂缓处理项（KNOWN ISSUES）

本文件记录**已确认但本轮不修**的问题，来源是 `docs/QA-REVIEW-T01-T02.md`（QA 只读复审报告）。
每条都写清：现象、为什么可以暂缓、以及**将来修的时候必须怎么改**，
避免"下次看到时又要从头分析一遍"。

- 记录日期：2026-10-25
- 对应修复提交：`fix(T02-T03)` 一个 commit（P0-1 / P0-2 / P1-1 / P1-3 / P1-5 / P2-12 / P2-6 / P2-1 / P2-2 / P2-3 已修）
- 范围：`server/**`、`deploy/**`

---

## 1. P1-2 跨用户内容去重会把 storageKey 判给首个上传者（**放开注册前必须修**）

**位置**
- `server/migrations/0001_init.sql`：`ux_assets_sha256_driver ON (sha256, storage_driver)`（**全局**唯一，无 `owner_id`）
- `server/src/db/repos/assets.ts`：`findAssetBySha(sha256, storageDriver)` 不带 owner 过滤
- `server/src/services/asset-service.ts`：`ingestAssetBytes` / `putAsset` 的去重分支
- `server/src/services/asset-service.ts`：`openAsset` 用 `row.owner_id !== ownerId → 404` 做租户隔离

**现象**
用户 B 上传一份**与用户 A 完全相同字节**的图片时：

1. `findAssetBySha` 命中 A 的行（含 A 的 `storage_key`）；
2. 该行被当作"已有资产"返回给 B —— B 的画布 doc 里被写进了 **A 的 storageKey**；
3. 但 `openAsset` 要求 `row.owner_id === ownerId`，B 读自己的图 → **404**（图裂）。

即：两个用户粘贴同一张网图，后者画布里的图必然失效。

**为什么本轮不修**
当前 `ALLOW_REGISTRATION=false` 且 `/api/setup` 只允许第一个用户，
单用户部署下这条路径不可触发。但它直接违背 T02 自己声明的"`owner_id` 是多租户隔离依据"。

**将来修的时候必须注意（两点要分开设计，别混在一起）**
1. **DB 层唯一性按 owner**：索引改为 `(sha256, storage_driver, owner_id)`，
   `findAssetBySha` 加 `AND owner_id = ?`；
2. **物理文件回收按全局 sha**：磁盘是内容寻址（`{yyyy}/{mm}/{sha256}.{ext}`），
   同一份字节仍然只应占一份磁盘。所以 `countAssetsBySha` **不要**加 owner ——
   它回答的是"物理文件还有没有人引用"，与"这行属于谁"是两个问题。

> 顺带修一个"假保护"：因为当前唯一索引保证同内容永远只有一行，
> `removeAsset` 里 `countAssetsBySha(...) === 0` 的引用计数分支实际**不可达**，
> 注释里说的"同 sha 多引用时不要误删"目前是失效的保护。

---

## 2. P1-4 `server/` 没有 lockfile，镜像构建不可复现

**位置**：`server/Dockerfile`（`RUN bun install --production`）
**现象**：仓库里不存在 `server/bun.lock`，`hono@^4.6.14` / `zod@^3.24.1` 按 `^` 浮动解析。
同一 commit 两次构建可能装到不同版本，也无法审计供应链。

**为什么本轮不修**：本机无 bun（无 `bun install` 能力），生成 lockfile 必须在有 bun 的环境做。

**将来修**：
```bash
# 任一有 bun 的环境（或 oven/bun 容器）里执行
cd server && bun install          # 生成 bun.lock
git add bun.lock
# 然后把 Dockerfile 改成：
RUN bun install --frozen-lockfile --production
```

---

## 3. P2-5 `canvasId` 未校验归属与存在性

**位置**：`server/src/routes/assets.ts`（`?canvasId=`）→ `server/src/services/asset-service.ts`
**现象**
- 传别人的画布 id → asset 行挂到**别人的画布**（一旦 `listAssetsByCanvas` 暴露就是越权读）；
- 传不存在的 id → 外键失败 → **500 INTERNAL**（而不是 400/404）。

**为什么本轮不修**：`listAssetsByCanvas` 目前没有任何 HTTP 路由暴露（仅 repo 层函数），
且已在本轮补上 owner 过滤（P2-6），所以暂无可利用面；改它要连带设计"资产归属校验"的完整语义。

**将来修**：落库前查 `canvases`，断言 `owner_id === ownerId` 且 `deleted_at IS NULL`，
非法返回 400 `VALIDATION_FAILED`；并把外键错误翻译成 4xx 而不是 500。

---

## 4. P2-7 清洗落盘发生在体积闸门之前，413 时会留下孤儿文件

**位置**：`server/src/services/canvas-service.ts`（`putCanvas`）
**现象**：`sanitizeCanvasDoc` 已经真实写盘并写了 `assets` 行，
之后才量 `MAX_DOC_JSON_MB`，一旦 413，这些资产就成了孤儿（DB 有行、无人引用）。

**为什么本轮不修**：孤儿清理本来就是 T05 的既定任务（`auditStorageKeys` 已预留钩子），
且 8MB 闸门只对"节点极多"的画布触发，不是常见路径。

**将来修**：要么落盘前估算清洗后体积，要么在 ingest 过程中记录本次写出的 key 列表，
413 时做补偿删除（注意：只删本次新增的行，别删到内容去重命中的既有行）。

---

## 5. P2-8 416 缺 `Content-Range`，404 details 泄漏内部路径

**位置**：`server/src/routes/assets.ts`（416 响应）、`server/src/services/asset-service.ts`（404 details）
**现象**
- 416 未带 `Content-Range: bytes */<size>`（RFC 7233 §4.4 要求）；
- 404 的 `details` 里回传了 `relPath`（`{yyyy}/{mm}/{sha}.ext`）与 `storageKey`。

**为什么本轮不修**：纯规范/信息暴露的小问题，不影响功能；`relPath` 只回给**已登录的 owner 本人**。

**将来修**：416 加 `c.header("Content-Range", \`bytes */${size}\`)`；404 details 删掉 `relPath`。

---

## 6. P2-9 备份容器以 root 直接写生产库做审计 INSERT

**位置**：`deploy/backup/backup.sh`、`deploy/docker-compose.yml`
**现象**：compose 注释写"只读 DB"，实际 `record_audit` 用 root 身份 `sqlite3` 对**生产库**做 INSERT。
若 checkpoint 后 `-wal`/`-shm` 被 root 重建，属主会变成 root，随后以 `bun` 身份运行的服务端写入会失败。

**为什么本轮不修**：需要新增一个"审计上报"接口或改动备份流程，属于结构性调整。

**将来修**（二选一）：
1. 备份侧只写**快照副本**，再由服务端启动时把快照里的审计行合并回来；
2. 或给服务端加 `POST /api/internal/backup-report`（仅容器网络可达），备份侧只投递 JSON。
   临时缓解：容器退出前对被重建的 `-wal`/`-shm` 做 `chown bun:bun`。

---

## 7. P2-10 `sessions` 清理是全表扫，且只在上线时跑一次

**位置**：`server/migrations/0001_init.sql`（只有 `(user_id, expires_at)` 索引）、
`server/src/index.ts`（启动时 `purgeSessions()` 一次）
**现象**：`SQL_PURGE_SESSIONS` 的条件是 `expires_at <= ? OR revoked_at <= ?`，
没有可用索引 → 全表扫；长跑容器里 sessions 会持续膨胀。

**为什么本轮不修**：需要**新增迁移**（`0002_*.sql`）加索引 —— 本轮刻意不改已发布的
`0001_init.sql`（迁移执行器会做 checksum 校验，改了就启动失败）。

**将来修**：`0002_sessions_index.sql`：
```sql
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS ix_sessions_revoked ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;
```
并把 purge 挂到一个低频定时器（如每小时一次）。

---

## 8. P2-11 登录限流缺纯 IP 桶；`remember` 默认持久化

**位置**：`server/src/auth/rate-limit.ts`、`server/src/routes/auth.ts`
**现象**
- 限流 key 只有 `ip|account`，没有纯 IP 桶：单个 IP 可以对 N 个账号各试 5 次/分（密码喷洒）；
- `remember !== false` 让**默认**就是 30 天持久 Cookie。

**为什么本轮不修**：会改变登录语义（默认会话时长），需要与产品确认；限流加桶要调参数。

**将来修**：加 `30 次/分/IP` 的兜底桶（key 只含 IP，先于 KDF 判定）；
`remember` 改成显式 `=== true` 才持久化。

---

## 9. P2-13 `setup` 的事务边界不严谨

**位置**：`server/src/routes/setup.ts`
**现象**：`db.exec("BEGIN IMMEDIATE")` 不在 `try` 内；`catch` 里的 `ROLLBACK` 若本身失败会掩盖原始异常。

**为什么本轮不修**：只影响"首次初始化失败"这一个瞬时场景的错误信息质量。

**将来修**：`BEGIN` 放进 `try`；`ROLLBACK` 用 `try { } catch {}` 包裹，再 `throw error`。

---

## 10. P2-15 `X-Forwarded-For` 取首段

**位置**：`server/src/http/request.ts`、`deploy/Caddyfile`
**现象**：取 XFF **首段**。当前部署（只有 caddy 暴露端口、未配 `trusted_proxies`）**不可利用** ——
Caddy 会忽略客户端自带的 `X-Forwarded-*` 并写入真实 IP。但将来前面加 CDN 并配置
`trusted_proxies` 后，首段会变回客户端可控 → 限流可绕过。

**将来修**：改取**最后一段**（`forwarded.split(",").at(-1)`），或在 Caddy 显式写
`servers { trusted_proxies private_ranges }` 并把该假设写进注释。

---

## 11. 视频生成转队列后，参考视频 / 参考音频参数无处可传

**位置**
- 前端：`web/src/pages/canvas/project.tsx` 的 `runVideoJobForNode`（T04-B 阶段 2）
- 服务端：`server/src/jobs/handlers/video.ts` 的 `videoHandler`

**现象**
浏览器直连路径 `createVideoGenerationTask(config, prompt, images, { signal, videos, audios })`
支持传参考视频（`options.videos`）和参考音频（`options.audios`），
但服务端 `videoHandler` 的 params **只认 `references`（图片 storageKey）**，
没有 `videos` / `audios` 两个字段。视频生成改走服务端队列后，
这两个参数在提交时没有落点，本轮按"不传"实现。

**影响面有限**：浏览器侧真正消费 `videos` / `audios` 的只有 **plugin 分支**
（`services/api/video.ts` 的 `createPluginVideoTask`），openai / gemini 分支本来就不用。

**为什么本轮不修**
补它要同时动服务端 handler 与 provider（新增参数解析、落盘、传给上游），
是独立工作量；T04-B 本轮的目标是"接队列 + 刷新可恢复"，不是补齐上游能力。

**将来修的时候必须注意**
1. 服务端 `videoHandler` 增加 `videos` / `audios` 参数，同样只接受 **storageKey** ——
   不能是 `data:` 内联，`job-service.ts` 的 `normalizeParams` 会直接拒；
2. 前端 `runVideoJobForNode` 里把 `generationContext.referenceVideos/referenceAudios`
   先落库成 storageKey 再传过去，与图片参考图共用 `resolveReferenceStorageKeys`；
3. **别只改前端**：服务端不认识的 params 键会被静默忽略，只改前端等于参数继续丢失，
   而且没有任何报错。

---

## 12. 其它小项

| 项 | 位置 | 说明 | 将来怎么办 |
| --- | --- | --- | --- |
| `user:create` 脚本不在镜像里 | `server/Dockerfile`、`server/package.json` | Dockerfile 未 `COPY scripts/`，容器内 `bun run user:create` 必然失败（`/api/setup` 已覆盖该场景，只是文档与文件不一致） | Dockerfile 增 `COPY scripts ./scripts`，或从 `package.json` 移除该 script |
| `deploy/rclone/` 未入库 | `deploy/docker-compose.yml` | 该目录被 `.gitignore` 整目录排除（内含 rclone 远端密钥，不能入库），所以全新克隆时它不存在、由 Docker 建成空目录。**已不再是静默失效**：挂载点已改到 `/root/.config/rclone`（Alpine 官方 rclone 的默认位置），且 `backup.sh` 在 `RCLONE_REMOTE` 非空却找不到 `rclone.conf` 时记 failed 审计行并 exit 1 | 无需再建 `.gitkeep`（会被 ignore）；把用法写进 `deploy/.env.example` 即可（已完成） |
| 先读 body 再校验 id | `server/src/routes/canvases.ts` | `readJsonBody` 在 `requireCanvasId` 之前，非法 id 也会先把最大 200MB 的 body 读进来（Bun 的 `maxRequestBodySize` 兜底，仅浪费） | 把 `requireCanvasId` 提到读 body 之前 |
| 单用户分支不承载多租户语义 | 全局 | `ALLOW_REGISTRATION=false` + `/api/setup` 单用户，是当前所有"单用户下不可触发"判定的前提 | **放开注册之前**，必须把本文件第 1、3、8 条一起修完 |
| antd 6 Modal `styles` 类型不接受 `content` | `web/src/components/layout/model-script-editor.tsx:58` | `Modal` 的 `styles` 只接受 `root/header/body/...`，传 `content` 报 TS2353。**基线自带，非 T04-A 引入**（`git diff HEAD -- <该文件>` 为空，文件从未被改动） | T05 统一处理：改用 `classNames` 或把 `content` 挪到 `body` 上 |
| Caddyfile CSP 仍是 `unsafe-inline` + `unsafe-eval` | `deploy/Caddyfile:97` | `index.html` 内联主题脚本需要。hash 化（外置脚本改用 nonce/hash）本轮未做 | T05 做 CSP hash 化 |
