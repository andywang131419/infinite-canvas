# 续跑清单 —— 接手前先读这一份

> 用途：这份文档刻意写成**自包含**的。任何人（或下一个会话）接手时不需要读历史对话，
> 按本文的执行顺序和精确位置做即可。写完/改完后请更新本文末尾的「进度」。
> 状态记录时间：2026-10-26 15:50

---

## 0. 环境事实（别用错工具）

| 事实 | 值 |
|---|---|
| 仓库路径 | `C:\Users\Administrator\WorkBuddy\2026-10-25-16-13-31\ic-user2` |
| 分支 | `stable` |
| 当前 HEAD | `486557e` |
| Node（托管版，用这个） | `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe` |
| Bash 工具 | **本机 Git Bash 的 PATH 坏了**（`ls`/`cat`/`head` 全 command not found），所有命令走 PowerShell |
| PowerShell 输出 | stdout 经常为空，统一「写文件再 Read」的套路（如 `Out-File -Encoding utf8`） |

### 三个已踩过的坑（重要）

1. **git 没有配置 user.email / user.name**（local 和 global 都没有）。
   提交必须显式指定，且与前序提交保持一致：
   ```bash
   git -c user.name='infinite-canvas-fork' -c user.email='fork@localhost' commit -m "..."
   ```
2. **`web/node_modules/typescript` 安装不完整** —— `lib/lib.dom.d.ts`、`lib.esnext.d.ts` 等缺失，
   所以 `web/` 的类型检查在这台机器上**跑不了**（会报 TS6053 / TS2318，那是环境问题不是代码问题）。
   修 `web/` 时**无法**用 typecheck 自证，因此不要在没验证的前提下提交。
3. **`npm.cmd run typecheck` 找不到 `tsc`**（PATH 不含本地 `.bin`）。
   请直接这样跑：
   ```powershell
   & $node "<repo>\server\node_modules\typescript\bin\tsc" --noEmit    # 在 server 目录下
   ```
   注意：不要误用 `web/node_modules` 那个坏的 tsc。

### 验证命令（改动后必须全跑）

在 `ic-user2/server` 目录下：

```powershell
$node = 'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
Push-Location <repo>\server
& $node "node_modules/typescript/bin/tsc" --noEmit          # 期望 EXIT=0 且无输出
& $node "scripts/verify-t02.mjs"       # 期望 EXIT=0，66 组
& $node "scripts/verify-t03.mjs"       # 期望 EXIT=0，63 组
& $node "scripts/verify-fix-p01.mjs"   # 期望 EXIT=0，27 组
Pop-Location
```

---

## 1. 已经做完的（不要再重做）

| 提交 | 内容 |
|---|---|
| `26bc9eb` | T01 前后端双骨架 + 部署链路 |
| `af8c666` | T02 数据层与鉴权 + 画布 API + 资产存储 |
| `46f5133` | T03 任务队列 + Provider 适配器 + Tier2 代理 + 备份 |
| `b2cfd0f` | QA 第二轮复审报告 |
| `d935b95` | 修复批次：首次保存丢图 / 资产 MIME 白名单 / doc 清洗绕过 / 文本正文被清空 / 媒体备份 / 备份审计等 |
| `eeeb882` | **安全修复**：SSRF 两处 + 补完 `proxyBytes` + nosniff |
| `486557e` | `.env.example` 补 `RESULT_DOWNLOAD_ALLOWLIST` |
| `673f3f8` | T04-A1 服务端 API 客户端 + AI 调用收口 |
| `56ad859` | T04-A2 画布与资产双写同步 |
| `e5709a9` | T04-A3 密钥只写 + 登录门 + 同步状态 UI |
| `36ba044` | 任务收尾加 `attempt` 围栏 + 幂等键隔离（迁移 `0002`） |
| `997435f` | 备份失败必须可见 + 统一布尔环境变量口径 |

验收实测：server `tsc --noEmit` 0 error；`verify-t02` 66 组、`verify-t03` **68 组**、`verify-fix-p01` 27 组，全部 EXIT=0。

**剩余**：web 侧 `tsc --noEmit` 有 15 处错误（缺 import 11 条 / 符号名写错 1 条 / store action 当自由函数调用 1 条 / 基线自带 1 条），工程师正在修。

---

## 2. 当前任务状态

### 2.1 T04-A（前端接线）—— 写了一半，**一个 commit 都没有**

已改/新增但未提交的 27 个文件：

```
 M web/src/components/layout/app-config-modal.tsx
 M web/src/components/layout/app-top-nav.tsx
 M web/src/components/layout/auth-gate.tsx
 M web/src/components/layout/channel-editor-drawer.tsx
 M web/src/components/layout/client-root-init.tsx
 M web/src/components/layout/config-local-proxy.tsx
 M web/src/components/layout/model-select-modal.tsx
 M web/src/i18n/locales/en-US.ts
 M web/src/i18n/locales/zh-CN.ts
 M web/src/lib/canvas/canvas-export.ts
 M web/src/services/api/audio.ts
 M web/src/services/api/image.ts
 M web/src/services/api/model-plugin.ts
 M web/src/services/api/prompt-source-runtime.ts
 M web/src/services/api/video.ts
 M web/src/services/file-storage.ts
 M web/src/services/image-storage.ts
 M web/src/stores/use-config-store.ts
?? web/src/components/canvas/canvas-sync-status.tsx
?? web/src/services/asset-bridge.ts
?? web/src/services/canvas-server-sync.ts
?? web/src/services/channel-secrets.ts
?? web/src/services/server-api.ts
?? web/src/services/server-fetch.ts
?? web/tests/canvas-server-sync.test.ts
```

**接手第一步**：逐个读完这些文件，判断哪些是半成品，先把它们补到逻辑自洽，再统一提交。
不要新增更多文件，先把这 27 个收口。

### 2.2 T04-A 的原始目标（未变）

1. `server-api.ts` —— 统一 `/api` 客户端，信封解包、错误归一、超时（普通 30s；上传按体积算）、
   401 → 派发 `app:auth-required`、403 `SETUP_REQUIRED` → 派发 `app:setup-required`
2. `server-fetch.ts` —— AI 调用收口。**不改 `image.ts`/`video.ts`/`audio.ts` 的对外签名**，
   只在底层把 `fetch` 换成 `serverFetch`：`/api/` 前缀直发，绝对 URL → `POST /api/proxy`。
   目的是让 `project.tsx` 上百处调用点零改动
3. `image-storage.ts` / `file-storage.ts` —— Blob 改存服务端，`content` 从 `blob:` 变成
   `/api/assets/raw?key=<encoded>`；缺 storageKey 时保留旧兼容；做**懒迁移**（有 key 但服务端 404、
   本地还有 Blob 时后台补传），不要大爆炸式全量迁移
4. `canvas-server-sync.ts` —— 持久化双写。用**对象引用比对**判脏（`updateProject` 只对变化的
   project 建新对象），800ms 防抖，同画布串行 PUT，409 不自动覆盖而是弹窗，revision 落本地持久
5. `use-config-store.ts` —— Key 改只写（`partialize` 剔除 apiKey，老 key 迁移后擦掉）
6. 登录/初始化门接 `router.tsx`（`/login`、`/setup` 要白名单放行）
7. 同步状态 UI（顶栏 pill、画布卡片状态点、冲突弹窗），沿用现有 antd token + i18n，**不引入第三套设计语言**

#### 已确认的服务端契约（别再自己发明）

| 端点 | 契约 |
|---|---|
| `GET /api/canvases?limit&offset` | `{items:[{id,title,revision,nodeCount,updatedAt}], total}`（total 是全量数） |
| `GET /api/canvases/:id` | `{canvas, openJobs}`（canvas 含 doc + revision） |
| `GET /api/canvases/:id/revision` | 轻量版本探针，不读 doc |
| `PUT /api/canvases/:id` | body `{baseRevision, doc, title?, deviceLabel?}`；`baseRevision=0` 新建；`>=1` 走 CAS；冲突 → **409 `REVISION_CONFLICT`**，`details.latestDoc` |
| `DELETE /api/canvases/:id` | 204 软删，重复删 404 |
| `PUT /api/assets?key=&canvasId=` | body 为**原始字节**，`Content-Type` 决定 mime；返回 `{asset:{...}}`，`asset.url` 已拼好 |
| `GET /api/assets/raw?key=` | Range/206 + ETag + 304，Cookie 鉴权，可直接给 `<img src>` |
| `POST /api/proxy` | JSON `{url, method?, channelId?, headers?, body?}`；也支持 `?url=` + multipart/octet-stream 字节透传 |

**硬约束**：`web/src/pages/canvas/project.tsx`（198KB）**一行都不要动**。发现必须改就停下上报。
`canvas-agent/`、`canvas-proxy/` 也不动。

---

## 3. QA 第二轮剩余问题（来自 `docs/QA-REVIEW-R2-d935b95.md`）

### P1-R2-1　僵尸 Worker 覆盖新 Worker 的成果（阻断项）

- **位置**：`server/src/jobs/queue.ts:145-159`（`SQL_FINISH_SUCCEEDED`）、`:168-180`（`SQL_FINISH_FAILED`）、
  `server/src/jobs/worker.ts:239-249`、`:295-305`；心跳异常分支 `worker.ts:246-248`
- **根因**：两条收尾 SQL 的围栏只有 `WHERE id=? AND status='running'`，但 `status='running'` 不是
  fencing token —— 任务被 reaper 回队、又被另一个 Worker 认领后状态又变回 `running`，旧 Worker 的收尾照样命中。
  心跳异常时 `worker.ts:246-248` 只 `console.error`、**不置 `leaseLost`**，所以 `:295` 的 `if (leaseLost || aborted)` 拦不住
- **后果**（QA 已实测复现）：最终存的是**上一次失败运行**的图，且 attempt 被真实消耗、上游计费两次
- **修法**：两条收尾 SQL 加 `AND attempt = ?`；心跳 catch 里置 `leaseLost = true` 并 `controller.abort()`
- **验收**：按 QA 的时序写测试 —— A 认领 attempt=1 → 心跳抛异常 → reaper 回队 → B 认领 attempt=2 →
  **A 收尾必须 `changes=0`**

### P1-R2-4　幂等键跨租户返回他人任务

- **位置**：`server/migrations/0001_init.sql:198-200`（`UNIQUE(idempotency_key)` 无 `owner_id`）、
  `server/src/jobs/queue.ts:197-199`（SELECT 无 `user_id`）、`server/src/services/job-service.ts:162-176`
- **后果**：B 用 A 用过的幂等键 → 拿到 A 的任务详情（含 `resultStorageKeys`、`upstreamTaskId`、`errorMessage`）。
  还有纯功能 bug：同一用户对两个画布用同一 body，第二次拿到的是第一个画布的任务
- **修法**：**新建迁移 `0002`**（不能改 0001，checksum 校验会拒绝启动），
  索引改 `(user_id, idempotency_key)`，查询加 `AND user_id = ?`；命中后校验 `canvas_id`/`type` 一致，不一致报 409
- **验收**：B 用 A 的幂等键提交必须**新建**，不能返回 A 的任务

> 迁移执行器以 `schema_migrations` 为唯一版本来源并逐文件校验 checksum，改已发布迁移会直接拒绝启动。这是硬规则。

### P1-R2-5　媒体备份静默失败

- **位置**：`deploy/backup/backup.sh:162-172`
- **后果**（QA 8 用例里 2 个红）：tar 打包失败 → `status='success', media_files=0`；
  媒体目录不存在 → `status='success'` 且**零日志**。而且「失败」和「有意关闭」产生的审计行**一模一样无法区分**
- **修法（3 行）**：目录缺失且 `INCLUDE_MEDIA=true` → `record_audit failed` + `exit 1`；
  tar 失败记 `failed`；审计行加 `media_expected=1` 以区分「有意关闭」
- **注意**：本机没有 sqlite3/gzip/rclone，QA 是用「导出的 bash 函数替身注入失败」测的，照做即可

### P2（同批顺手修掉，不要单独开一轮）

| 编号 | 位置 | 问题 |
|---|---|---|
| P2-R2-1 | `queue.ts:69-84` | 认领缺 `AND attempt < max_attempts`；实测 attempt=2/max=2 的 queued 行仍被认领、attempt 加到 3 |
| P2-R2-2 | `queue.ts:298-323` | `markFailed` 不检查 `changes`，任务已取消时仍报"X 秒后重试"（`markSucceeded` 却返回 boolean，统一掉） |
| P2-R2-3 | `worker.ts:141-164` | 注释写"超时后强停"，**实际没有任何 abort** |
| P2-R2-4 | `providers/http.ts:211-221` | 512MB 上限是**先 `arrayBuffer()` 读进内存之后**才判的，注释说"防上游 2GB 读死进程"防不住 → 先看 `content-length` 再流式累计 |
| P2-R2-6 | `docker-compose.yml:159` + `env.ts` | `BACKUP_INCLUDE_MEDIA` **只注入了 backup 服务没注入 server**；`boolFromEnv` 只认 `"true"/"false"`，写 `0`/`yes` 会让 **server 启动崩溃** |
| P2-R2-7 | `queue.ts:401-404` | catch 里裸 `ROLLBACK`，COMMIT 失败会抛 "no transaction is active" 掩盖原始异常，用 `try{}catch{}` 包 |
| P2-R2-8 | `deploy/Caddyfile:97` | CSP 保留 `script-src 'unsafe-inline'`。建议把 `index.html` 的主题初始化脚本外置，改用 hash/nonce |

---

## 4. T04-B（下轮，不要现在做）

任务队列接管生成流程（生成中刷新可续）：`POST /api/jobs` + 轮询 `GET /api/jobs/:id`、
打开画布时用 `GET /api/jobs?canvasId=&open=true` 恢复未完成任务。
这需要动 `project.tsx` 的生成入口，风险高一个量级，**等 T04-A 验收完再上**。

---

## 5. 执行顺序（按这个来）

1. 先收口 T04-A 的 27 个未提交文件 → 补逻辑自洽 → 一个 commit
2. 再做 P1-R2-1 / P1-R2-4 / P1-R2-5 + P2 那一批 → 单独一个 `fix(T03): ...` commit
3. 每条 self-check：typecheck 0 error + 三套 verify 全绿
4. 完成后把这份文档的「进度」章节更新掉

---

## 6. 长期已知问题（写在 `docs/KNOWN-ISSUES.md`，不在这轮修）

- **P1-2 跨用户去重**：`ux_assets_sha256_driver` 是全局唯一（无 `owner_id`），单用户不可触发。
  但这是**放开注册前的阻断项** —— 届时唯一索引要改 `(sha256, storage_driver, owner_id)`，
  注意「DB 唯一性按 owner」和「物理文件回收按全局 sha」是两件事，要分开设计
- ~~**P1-4** 缺 `server/bun.lock`~~ ✅ **T05 已修**：本地 bun 跑 `bun install` 生成并提交 `server/bun.lock`，Dockerfile 改 `COPY package.json bun.lock ./` + `RUN bun install --frozen-lockfile --production`（详见 `docs/KNOWN-ISSUES.md` #2）。
- DNS rebinding TOCTOU：`resolveAndCheckHost` 查一次、`fetch` 自己再解析一次，未绑定。
  彻底修法是校验与连接共用同一份解析结果（把解析出的 IP 传给 fetch 的 `lookup`）

---

## 7. 进度

> 2026-10-27 核对：本章节此前停在 T04-B 之前（HEAD 还写着 `486557e`），已过期。
> 真实状态见下方「当前真实状态」。

- 2026-10-26 15:50　建立本文档。HEAD=`486557e`。两条 SSRF 已修（`eeeb882`）。
- 2026-10-26　T04-A（前端接线）收口、web 15 处真实类型错误修复、T04-B（生成队列接管 + 刷新可恢复）完整闭环，含 P0/P1/P2 多轮修复。
- 2026-10-26　git 网络打通（PAT + ghfast.top 镜像 + `pushnp/pullnp/fetchp` 别名），`stable` 推到 `origin/stable`。

### 当前真实状态（2026-10-27 体检后）

- **HEAD=`3787bdf`**，分支 `stable`，工作区干净，无未推送提交。
- **T01 → T04-B 全部完成并推送**。
- **自动化验证全绿**：
  - web `bun test`：**49 通过 / 0 失败**
  - server 类型检查（`tsc --noEmit`）：**0 错误**（server 无单测套件，验证靠下方三套脚本）
  - web 类型检查（用 server 完整版 tsc 跑，绕过本机缺 lib 的环境坑）：**仅 1 处** `model-script-editor.tsx:58` 的 antd 6 `Modal styles.content` 类型不兼容 —— **基线问题，文件从未被改动，非本项目引入**
  - web `vite build`：**成功**（`✓ built in ~23s`，dist 产物齐全；2 个动态/静态混合导入 warning、1 个 chunk 体积 warning，均不影响正确性）
  - 回归脚本：verify-t02（66 项）、verify-t03（92 项）、verify-fix-p01（27 项）**全部 EXIT=0**
- **代码审查结论**：`job-utils.ts` 纯逻辑（幂等键 / 写回落点 / 批量配对 / 视频比例）已单测覆盖且逻辑自洽；`project.tsx` 恢复链路（`resetInterruptedGeneration` → `attachOpenJobs` → 写回、`stopGenerationByRunningId` → `cancelJob`）接线完整；被删 `audio.ts` **无悬挂引用**；T04-B 三处 QA 结论落地。
- **已知未修项**（全部见 `docs/KNOWN-ISSUES.md`，均为单用户部署下不可触发的安全加固 / 构建可复现性 / 功能缺口，非功能 bug）：
  - 放开注册前必须修：#1 跨用户去重、#3 canvasId 归属校验、#8 sessions 索引等
  - #11 视频「参考视频/音频」参数未透传（功能缺口，非崩溃）
  - ~~#2 缺 `server/bun.lock`~~ ✅ **T05 已生成并提交**（本地 bun 跑 `bun install`，Dockerfile 改 `--frozen-lockfile`），镜像构建可复现。
  - antd 6 `Modal styles.content` 基线类型错误（#12）

### 当前待办（下一轮）

1. **T05 真机 VPS 部署验证**（进行中）：
   - ✅ 本机静态预检 + 加固已完成：`server/bun.lock` 生成并提交、根 `Dockerfile` 的 `COPY` 引用文件全部存在、`DEPLOY-VPS.md` 中 F2/F3/F5 的陈旧 🔴「未修」结论已翻正为 ✅（代码本就修好，手册曾严重过期）、`KNOWN-ISSUES #2` 关闭。
   - ⏳ 剩余：在真实 VPS 上按 `docs/T05-VERIFY.md` 跑「构建 → 健康检查 → 初始化 → 备份验证 → 恢复演练 → 功能回归」六阶段（本机无 Docker / VPS 凭证，无法代跑，需 owner 在 VPS 执行）。
2. 两条 T04-B 的 P2（已标 deferred，非阻断）：`runningNodeId` 单值全局；`createdAt` 并列退化数组顺序。
3. 桌面 108 个临时文件清理（AI 探针遗留，用户确认后收尾）。
4. 这条「进度」章节此前严重过期，本次已刷新。
