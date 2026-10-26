# 第二轮独立复审：`d935b95` 修复验收 + T03（`46f5133`）本体审查

- 复审人：QA（Edward）
- 复审对象：`d935b95`（fix(T02-T03) 8 项修复）+ `46f5133`（feat(T03) 本体，上轮未覆盖）
- 基线：`docs/QA-REVIEW-T01-T02.md`（第一轮）
- 复审方式：**只读**静态审查 + 独立实跑验证。除本文件外未修改任何仓库文件。
- 复审日期：2026-10-26
- 目标：证明"工程师**改对了**"，而不只是"改了"

---

## 0. 结论

### 0.1 结论表

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| **P0** | **0** | 上轮 2 条 P0 全部真实闭合，且已用"反向验证"证明测试不是摆设 |
| **P1** | **5** | 1 条数据正确性（队列僵尸覆盖）、3 条安全（SSRF 旁路 ×1、字面量拦截失效 ×1、跨租户任务泄露 ×1）、1 条备份静默失效 |
| **P2** | **8** | 见 §5 |
| 允许的偏差 | 3 | 全部**接受**，理由见 §3 |

### 0.2 是否放行 T04

**不放行（有条件阻断）。**

必须先修完以下 4 条，其余可与 T04 并行：

| 阻断项 | 一句话 |
| --- | --- |
| `P1-R2-2` | `downloadBytes()` 完全不过 `guard.ts`，上游可控 URL 直接打内网（真 SSRF） |
| `P1-R2-3` | `isBlockedIpv6` 对 `::ffff:x:y` 形式全线失效，第二道闸名存实亡 |
| `P1-R2-4` | 幂等键全局唯一 + 查询不带 owner → 跨租户返回他人任务 |
| `P1-R2-1` | 收尾 SQL 无 attempt 围栏，僵尸 Worker 会覆盖新 Worker 的结果 |

`P1-R2-5`（媒体备份静默失败）建议同批修，但不阻断 T04 启动。

> 关键判断：**`d935b95` 本身是质量很高的一次修复**（9/10 项声明完全属实，测试诚实度是我见过最好的一档）。不放行 T04 不是因为修复做坏了，而是因为 `46f5133`（T03 本体，6600 行）里存在 4 条此前无人审查过的真实缺陷。

### 0.3 修复质量总评

| 项 | 判定 |
| --- | --- |
| 声明的 10 项修复 | 9 项**完全属实**，1 项（P1-3）**部分属实** |
| 新增自检的诚实度 | **A 级**：`verify-fix-p01.mjs` 用真 `db/client.ts` + 真迁移 + 真磁盘，反向修改源码后确实变红 |
| 自检声明数字 | `verify-fix-p01 27/27` ✓ 实跑通过、`verify-t02 66/66` ✓ 实跑通过、`verify-t03 60/60` ✓ 实跑通过 |
| 代码可读性 / 注释质量 | 优秀（注释解释"为什么"，不只是"是什么"） |

---

## 1. 验证方法与可复现证据

本轮所有结论都来自**实跑**，不是读代码猜的。为便于复核，证据文件与脚本都留在本机：

| 编号 | 内容 | 证据文件 | 结果 |
| --- | --- | --- | --- |
| E1 | `verify-fix-p01.mjs` 正向跑 | `%TEMP%/qa_p01.txt` | **27/27 PASSED** |
| E2 | **反向验证**：把 P0-1 修复改回错误写法，再跑 E1 | `%TEMP%/qa_p01_revert.txt` | **5 项 FAILED，EXIT=1** |
| E3 | MIME 白名单 + doc-sanitizer 边界探针（自写 60+ 用例） | `%TEMP%/qa_probe1.txt` | 见 §2.2 / §2.4 |
| E4 | SSRF guard 绕过探针（`node --experimental-strip-types` 直接加载真 `guard.ts`） | `%TEMP%/qa_guard.mjs` / `qa_guard.txt` | 见 §2.3 |
| E5 | 队列并发/僵尸覆盖探针（`node:sqlite` + 从 `queue.ts` **原样抽取**的 SQL） | `%TEMP%/qa_queue.mjs` / `qa_queue.txt` | 见 §2.7 |
| E6 | `backup.sh` 控制流冒烟（7 + 1 个用例，脚本依赖全部用 bash 函数替身） | `%TEMP%/qa_bk_test.sh` / `qa_bk_result.txt` / `qa_bk_result2.txt` | 见 §2.6 |
| E7 | `verify-t03.mjs` / `verify-t02.mjs` 实跑 | `%TEMP%/qa_vt03.txt` / `qa_vt02.txt` | 60/60、66/66 |

> 环境说明：本机无 `bun` / `docker` / `sqlite3` / `gzip` / `rclone`，且 `bash` 的 PATH 残缺（`mkdir`/`date`/`sed`/`grep` 均不可用）。因此：
> - `bun:sqlite` 相关测试用 `node:sqlite` + 仓库自带的 `bun-sqlite-shim.mjs` 跑；
> - `backup.sh` 用**导出的 bash 函数替身**替换 `sqlite3/gzip/tar/rclone/mkdir/date/sed/wc/find`，只验证控制流（这正是 P1-5 的全部内容）；
> - 所有命令输出重定向到临时文件后用文件读取，避免 PATH 问题。

---

## 2. 逐项验收（按工程师的 7 个修复组）

### 2.1 组 1 — P0-1 首次保存丢图：**闭合，且测试诚实度已证伪式验证**

#### 验收 1：修复本身

`server/src/services/canvas-service.ts:276`：

```ts
const ingest = createDocIngest(user.id, input.baseRevision === 0 ? null : id);
```

新建阶段（`baseRevision === 0`）不绑定 `canvas_id`，绕开"assets.canvas_id 外键指向尚未插入的 canvas"这一因果链。**方向正确**。

#### 验收 2：测试诚实度（本项最关键）

工程师新增 `server/scripts/verify-fix-p01.mjs`（470 行）+ `bun-sqlite-shim.mjs`（90 行）。我做了三件事：

**(a) 审计垫片是否"放松"了约束**

通读 `bun-sqlite-shim.mjs`：用 `node:sqlite` 的 `DatabaseSync` 包装出 `Database`/`Statement` 接口，`run()` 返回 `{changes, lastInsertRowid}`。文档里自陈两处差异：
1. 每次 query 重新 prepare（无缓存）；
2. `bigint` → `number`。

两处都**不影响**外键、事务、`RETURNING`、唯一索引的语义。垫片**没有**关 `foreign_keys`、**没有**把异常吞掉。判定：**等价，不是"假测试"**。

**(b) 审计被测对象是不是真的**

脚本用 `module.registerHooks()` 的 `resolve` 钩子把 `bun:sqlite` 重定向到垫片，然后 `import` **真实的** `db/client.ts`、`services/canvas-service.ts`、`services/asset-service.ts`、`services/doc-sanitizer.ts`、`db/repos/*.ts`，跑**真实的** `migrations/0001_init.sql`。断言"磁盘上真有文件"时读的是真的 `LocalDiskDriver` 产物。

判定：**测的是生产代码，不是复刻逻辑**。

**(c) 反向验证 —— 让测试变红**

这是判断"测试有没有用"的唯一硬标准。我把 `canvas-service.ts:276` 临时改成修复前的写法：

```ts
const ingest = createDocIngest(user.id, id);   // 退回 bug 版本
```

重跑 `verify-fix-p01.mjs`：

```
✗ [3] putCanvas(baseRevision=0) 新建画布：dropped 应为 0，实际 1
✗ [3] 首个资产行 canvas_id 应为 NULL
✗ [3] 节点 metadata.storageKey 应为非空
✗ [3] 磁盘上应存在该资产文件
✗ [5] ...
共 5 项失败，EXIT=1
```

看到结果后立即 `git checkout -- server/src/services/canvas-service.ts` 复原，并 `Read` 复核第 276 行已回到 `input.baseRevision === 0 ? null : id`；`git status --short` 为空。

**判定：测试是真的。修复也是真的。**

> 这条反向验证是本次复审最重要的产出：它同时证明了"修复有效"和"回归测试有效"，堵死了"改了一个地方、测试恰好覆盖不到"的侥幸。

---

### 2.2 组 2 — P0-2 MIME 白名单：**闭合（含输出侧二次收口）**

`server/src/services/mime-whitelist.ts` 的核心：

```ts
export const ALLOWED_ASSET_MIME_PATTERN =
  /^(?:image\/(?:png|jpeg|webp|gif|avif|bmp|tiff)|video\/(?:mp4|webm|quicktime)|audio\/(?:mpeg|wav|ogg|aac|flac|webm)|application\/(?:octet-stream|pdf))$/;
```

`^...$` **锚定**，这是关键。实测（E3）：

| 输入 MIME | `canonicalAssetMime` | 期望 | 结果 |
| --- | --- | --- | --- |
| `image/svg+xml` | `null` → 归一 `application/octet-stream` | 拦 | ✓ |
| `IMAGE/SVG+XML` | 同上 | 拦 | ✓ |
| `text/html` | `null` | 拦 | ✓ |
| `text/htmlfoo` | `null` | 拦 | ✓ |
| `TEXT/HTML` | `null` | 拦 | ✓ |
| `application/xhtml+xml` | `null` | 拦 | ✓ |
| `image/pngX` | `null` | 拦 | ✓ |
| `image/pn\0g` | `null` | 拦 | ✓ |
| `image/png; charset=utf-8` | `image/png` | 放 | ✓（参数正确剥离） |
| `image/png\n`（尾随换行） | `image/png` | 放 | ⚠️ 见 P2-R2-9（不可利用） |

`decodeDataUrl` 对 `data:image/svg+xml;base64,...`、`data:text/html;base64,...`、`data:application/xhtml+xml;base64,...` **全部返回 `null`**；`data:image/png;base64,...` 正常解出 `image/png`。

**输出侧**（这是很多人会漏的一层，工程师补了）：

- `server/src/routes/assets.ts`：媒体类 `Content-Disposition: inline`，`octet-stream` 强制 `attachment`；
- 所有资产响应加 `Content-Security-Policy: default-src 'none'; sandbox` + `X-Content-Type-Options: nosniff`；
- `deploy/Caddyfile:39-44` 站点级再补 `-Server / X-Frame-Options: DENY / nosniff / Referrer-Policy`。

**判定：闭合。** 存储型 XSS 的"内容侧 + 传输侧 + 策略侧"三层都堵上了。

---

### 2.3 组 3 — P1-1 深度绕过 + storageKey 透传：**闭合**；**但发现 guard.ts 的字面量拦截有同类漏洞**

#### P1-1 本身

`doc-sanitizer.ts`：`MAX_DEPTH = 64`，超限 `return null` 且 `stats.dropped += 1`（不再"原样返回子树"）。实测（E3）：

| 嵌套层数 | 结果 |
| --- | --- |
| 62 / 63 | 保留（未触顶） |
| **64 / 65 / 66** | **`null` + `dropped=1`** |

深度边界正确。

关于"62/63 层仍能看到 base64"：那是因为该用例的 dataUrl 是**短裸字符串**（< `BARE_DATA_URL_MIN_LENGTH=128`），走了"裸字符串长度阈值"分支被保留为文本，**不是**新的深度绕过。行为与设计一致。

`storageKey` 透传收口实测：

| storageKey 值 | 结果 | 判定 |
| --- | --- | --- |
| `data:image/png;base64,iVBOR...` | `""` + `dropped=1` | ✓ 已拦 |
| `blob:https://x/uuid` | `""` + `dropped=1` | ✓ 已拦 |
| `image:OTHERSUSERKEY1234`（形状合法、指向别人资产） | 保留 | ✓ 正确（读侧 `openAsset` owner 校验返回 404） |
| `javascript:alert(1)` | 保留 | ⚠️ 见 P2-R2-10（读侧必 404，无实际风险） |

#### 顺带在 `providers` 层发现同类问题（**新 P1**）

`guard.ts` 的字面量拦截在 IPv4 侧做得很扎实。实测（E4，直接 `import` 真 `guard.ts`）：

```
http://2130706433/          -> hostname=127.0.0.1   isBlockedHost=true   ✓
http://0x7f.0.0.1/          -> hostname=127.0.0.1   isBlockedHost=true   ✓
http://0177.0.0.1/          -> hostname=127.0.0.1   isBlockedHost=true   ✓
http://127.1/               -> hostname=127.0.0.1   isBlockedHost=true   ✓
http://[::1]/               -> isBlockedHost=true                        ✓
http://[::ffff:127.0.0.1]/  -> hostname=[::ffff:7f00:1]  isBlockedHost=false  ✗
http://[::ffff:169.254.169.254]/ -> hostname=[::ffff:a9fe:a9fe] isBlockedHost=false ✗
```

WHATWG URL 会把 `::ffff:127.0.0.1` **规范化成十六进制压缩形式 `::ffff:7f00:1`**，而 `isBlockedIpv6` 只处理带点的形式 → 漏判。详见 **P1-R2-3**。

---

### 2.4 组 4 — P2-3 文本正文被清空：**闭合，且没有引入新的过度清洗**

实测（E3，覆盖工程师要求的每一个形状）：

| 用例 | 结果 | 判定 |
| --- | --- | --- |
| `{type:'text', metadata:{content:'blob:abc 是我的笔记正文'}}` | **保留原文** | ✓ 已修 |
| `{type:'image', metadata:{content:'blob:https://x/uuid'}}` | 清空 + dropped | ✓ 正确 |
| text 节点 content = 「我的笔记：」+ 一个长 data URL | **保留** | ✓ 正确（不是纯载荷） |
| text 节点 content = 纯长 data URL（≥128 字符） | 清空 + dropped | 可接受（整段正文就是一张图，等价于内联资产） |
| 非 base64 的 `data:image/png,%89PNG...` | 原样保留 | ✓ 正确（未解码，无风险） |
| `prompt` / `composerContent` / `errorDetails` 字段含 data URL | 整体旁路 | ✓ 正确 |

`BLOB_URL_PATTERN = /^blob:(?:[a-z][a-z0-9+.-]*:\/\/\S*|null\/\S*)$/i` 要求带 scheme，正好排除了 `blob:abc 是中文` 这种自然语言句子。

**判定：闭合。真数据丢失风险已消除，且未新增过度清洗。**

---

### 2.5 组 5 — P1-3 媒体备份：**部分闭合（server 侧未接线）**

三处默认值**一致**（都是 `true`）：

| 位置 | 声明 |
| --- | --- |
| `server/src/env.ts:103` | `BACKUP_INCLUDE_MEDIA: boolFromEnv(true)` |
| `deploy/.env.example:71` | `BACKUP_INCLUDE_MEDIA=true` |
| `deploy/backup/backup.sh:28` | `INCLUDE_MEDIA="${BACKUP_INCLUDE_MEDIA:-true}"` |
| `deploy/docker-compose.yml:159` | `${BACKUP_INCLUDE_MEDIA:-true}` |

**但 `docker-compose.yml` 只把它注入了 `backup` 服务，没有注入 `server` 服务**（grep 全文仅 159 行一处）。后果：

- `server` 容器里的 `env.BACKUP_INCLUDE_MEDIA` **永远是默认 `true`**，与操作员在 `.env` 里写什么无关；
- 操作员按注释设 `BACKUP_INCLUDE_MEDIA=false`（合理诉求：不用服务端手动备份统计媒体）时，`backup` 容器不打包媒体（正确），而 `server` 的 `/api/backups` 手动备份仍会 `countMedia()` 并把 `media_files/media_bytes` 写进审计行 → **审计行声称媒体有备份，实际零打包**；
- 叠加 `boolFromEnv` 是严格枚举（只认 `"true"`/`"false"`，见 `server/src/env.ts:14-18`）：若有人写 `BACKUP_INCLUDE_MEDIA=0`/`yes`，`backup.sh` 侧当 false、`server` 侧**启动直接崩**（zod 校验失败）。

**判定：P1-3 部分闭合。`backup.sh` 侧已修好，"三处默认一致"的声明只做到了两处接线。**

---

### 2.6 组 6 — P1-5 备份失败审计：**闭合（实测 8 个用例）**

本机栈全缺（无 `sqlite3`/`gzip`/`rclone`/`mkdir`/`date`），因此我把 `backup.sh` 依赖的每个外部命令替换成可注入失败的 bash 函数，**只测控制流**——这正是 P1-5 的全部内容。实测（E6）：

| 用例 | 脚本 exit | 审计 INSERT 次数 | 其中 success/failed | 判定 |
| --- | --- | --- | --- | --- |
| A 正常路径（含媒体） | 0 | **1** | 1 / 0 | ✓ 无重复行 |
| B `gzip` 压缩失败 | 1 | **1** | 0 / 1，`aborted (exit=1)` | ✓ 且半截 `.gz` 被删 |
| C `mkdir` 暂存目录失败 | 1 | **1** | 0 / 1 | ✓ **trap 确实注册在 mkdir 之前** |
| D `rclone` 上传失败 | 1 | **1**（不是 2） | 0 / 1，`rclone upload failed` | ✓ **`FINISHED=1` 防重复生效** |
| E 快照连续失败 | 1 | **1** | 0 / 1，`snapshot failed after 2 attempts` | ✓ 重试后放弃并记账 |
| F `tar` 打包媒体失败 | **0** | 1 | **1 / 0** | ✗ 见 P1-R2-5 |
| G `INCLUDE_MEDIA=false` | 0 | 1 | 1 / 0，`media_files=0` | ✓ 预期行为 |
| H `INCLUDE_MEDIA=true` 但媒体目录不存在 | **0** | 1 | **1 / 0，`media_files=0`，无任何日志** | ✗ 见 P1-R2-5 |

用例 D 的原始审计 SQL（可直接看到 `FINISHED` 守卫与失败原因）：

```sql
INSERT INTO backups (id, trigger, status, db_bytes, media_files, media_bytes, target, error_message, started_at, finished_at)
VALUES ('bk_20261026T120000Z_339','cron','failed',4096,4096,4096,'r2::bucket/ic',
        NULLIF('rclone upload failed',''),'20261026T120000Z','20261026T120000Z');
```

**trap 是否递归？** 每个用例都只产生 **1 条**审计行，trap 内 `record_audit` 的失败被 `|| warn` 吞掉（返回 0），且 POSIX sh 的 EXIT trap 不会被重入。**确认无递归。**

**判定：P1-5 闭合。** 但用例 F/H 暴露了同一类"静默"问题被挪到了媒体分支（→ P1-R2-5）。

---

### 2.7 组 7 — P2-12 / P2-6 / P2-1 / P2-2：**全部闭合**

| 项 | 证据 | 判定 |
| --- | --- | --- |
| P2-12 `HTTPException` 映射 | `respond.ts:handleError` 先判 `instanceof HTTPException` → `errorCodeForStatus()`（400 VALIDATION_FAILED / 404 NOT_FOUND / 409 REVISION_CONFLICT / 413 DOC_TOO_LARGE / 429 RATE_LIMITED …）再落到 INTERNAL | ✓ |
| P2-6 owner 过滤下沉 SQL | `canvas-sql.ts:SQL_SELECT_OPEN_JOBS` 改为 `JOIN canvases c ON c.id = j.canvas_id AND c.owner_id = ?`；`listAssetsByCanvas` 同 | ✓ |
| P2-1 `total` 语义 | `SQL_COUNT_CANVASES` 新增；`countCanvases → countCanvasRows(ownerId)`，`total` 不再等于本页条数 | ✓ |
| P2-2 CAS 不覆盖标题 | `SQL_UPDATE_CANVAS_CAS`：`title = COALESCE(?, title)`；`resolveTitleOrNull()` 对 `undefined`/`""`/`"   "` 都返回 `null`，对合法标题返回原值 | ✓ |

`listOpenJobs` 签名改为 `(ownerId, canvasId)` 后，grep 全仓库调用点**全部已更新**（`canvas-service.ts`、`job-service.ts` 无遗漏）。

`verify-fix-p01.mjs` 的 [4][5][6] 组已覆盖 P2-2 / P2-6 / P0-2 回归，实跑通过。

---

## 3. 工程师声明与实际的偏差

工程师在 `d935b95` commit message 末尾自陈了 3 条"偏差"。逐条判：

### 偏差 (a) CSP 不放在站点级，而放在静态侧 `handle` 块

**判定：接受，且这是正确做法。**

`deploy/Caddyfile:35-37` 的理由完全站得住：Caddy 的 `header Content-Security-Policy` 是**覆盖**语义，若放站点级，会把 `routes/assets.ts` 自己下发的更严格的 `default-src 'none'; sandbox` 替换掉，**反而削弱**资产侧防护。

我额外确认了 Caddy 的路由语义：`handle /api/*` 与 `handle`（静态兜底）互斥，CSP 只挂在后者，`/api/*` 不会命中；站点级那组（`-Server`/`X-Frame-Options`/`nosniff`/`Referrer-Policy`）在 `handle` 之外，对两条路由**都生效**，不会被覆盖。**结论：分层正确。**

### 偏差 (b) CSP 的 `script-src` 仍保留 `'unsafe-inline'`

**判定：接受（附条件），但要写进已知风险。**

`deploy/Caddyfile:83-95` 的解释诚实且具体（AntD 6 CSS-in-JS 运行时注入 `<style>`；`web/index.html` 有主题初始化内联脚本）。放弃 `unsafe-inline` 会直接白屏，这是真实约束。

但要明确这条 CSP 的**实际保护力**：它挡住的是"引入外部脚本域 / object / eval / 被 iframe"，**挡不住**"应用自身出现一处 HTML 注入"——一旦出现，就是完整 XSS。当前资产侧已闭环（§2.2），SPA 侧依赖 React 默认转义 + 无 `dangerouslySetInnerHTML`（此项我无法在 T03 范围内证伪，属 T05 前端审查范围）。

建议（不阻断）：把主题初始化脚本外置为 `/theme-boot.js`，用 `sha256-` 哈希或 `nonce` 放行，逐步去掉 `script-src 'unsafe-inline'`。

### 偏差 (c) `backup.sh` 记录 `exit=N` 而不是 `$LINENO`

**判定：接受，理由完全正确。**

POSIX sh 的 EXIT trap 里 `$LINENO` 指向 trap 自身行号，编一个假行号比没有更糟。实测用例 B/C 记录的 `aborted (exit=1)` 准确可读，且 `err` 日志与审计行对得上。

---

## 4. 上轮 P0/P1 的关闭情况

| 上轮编号 | 问题 | 状态 | 依据 |
| --- | --- | --- | --- |
| **P0-1** | 首次保存画布内联图片 100% 丢失 | **已闭合** | 正向 27/27；**反向修改后 5 项变红**（§2.1） |
| **P0-2** | 资产 MIME 全信请求头 → 存储型 XSS | **已闭合** | 白名单锚定 + 输出侧 CSP/Disposition + Caddy 三层（§2.2） |
| **P1-1** | doc 清洗深度绕过 / storageKey 透传 | **已闭合** | 64/65/66 层全部 `null`+dropped；`data:`/`blob:` storageKey 全部置空（§2.3） |
| **P1-2** | 跨用户内容去重把 storageKey 判给首个上传者 | **未修（已声明）** | 写入 `docs/KNOWN-ISSUES.md` §1，并标注"放开注册前必须修"。**本次复审额外发现同类的第二条：幂等键跨用户（P1-R2-4）** |
| **P1-3** | 媒体从未被备份 | **部分闭合** | `backup.sh` 侧已修好（默认 true + 真 tar 打包）；**server 容器未接线**（§2.5） |
| **P1-4** | `server/` 无 lockfile，镜像不可复现 | **未修（已声明）** | `KNOWN-ISSUES.md` §2，理由（本机无 bun）成立 |
| **P1-5** | 备份在压缩阶段失败不写审计行 | **已闭合** | 8 个用例实测：trap 生效、半截产物清理、`FINISHED=1` 无重复行（§2.6） |

**P0 关闭率 2/2 = 100%；P1 关闭率 3/5 = 60%（1 部分、2 已声明暂缓）。**

`docs/KNOWN-ISSUES.md` 本身质量很高：每条都有位置、现象、为什么可暂缓、将来怎么改，还标了"放开注册前必须先修哪几条"。这是对的做法。

---

## 5. 新增问题清单（按严重度）

> 以下全部是**本轮新发现**（`46f5133` T03 本体此前未审查）。每条都附实测证据。

### P1-R2-1（P1）收尾 SQL 无 attempt 围栏：僵尸 Worker 会覆盖新 Worker 的成果

**位置**
- `server/src/jobs/queue.ts:145-159`（`SQL_FINISH_SUCCEEDED`）
- `server/src/jobs/queue.ts:168-180`（`SQL_FINISH_FAILED`）
- `server/src/jobs/worker.ts:239-249`（心跳异常分支）
- `server/src/jobs/worker.ts:295-305`（`leaseLost` 判据）

**问题**

两条收尾 SQL 的唯一围栏是 `WHERE id = ? AND status = 'running'`：

```sql
UPDATE jobs SET status='succeeded', result_storage_keys=?, ... WHERE id = ? AND status = 'running'
```

`status='running'` **不是**围栏标记（fencing token）：任务被 reaper 回队、又被**另一个 Worker 重新认领**后，状态又变回 `running`，旧 Worker 的收尾照样命中。

而 `worker.ts:246-248` 的心跳异常分支只打日志、**不置 `leaseLost`**：

```ts
} catch (error) {
    console.error(`[worker] 任务 ${job.id} 心跳失败`, error);   // ← 没有 leaseLost = true
}
```

于是 `worker.ts:295` 的 `if (leaseLost || controller.signal.aborted)` 拦不住。文件头注释（`worker.ts:15-18`）承诺的"宁可浪费一次上游调用，也不能污染状态"**没有兑现**。

**实测（E5，`node:sqlite` + 从 `queue.ts` 原样抽取的 SQL）**

```
[t=0]   A 认领: status=running attempt=1 lease_until=...00:01:00Z
[t=0]   A 心跳抛异常 → leaseLost 保持 false
[t=61s] reaper 回队: changes=1  → status=queued attempt=1
[t=71s] B 认领: status=running attempt=2 lease_until=...00:02:11Z
[t=80s] A 僵尸收尾 finishSucceeded: changes=1   ← 应为 0 才安全
        此时行: status=succeeded, attempt=2, result_storage_keys=["image:A-STALE"]
[t=90s] B 正常收尾 finishSucceeded: changes=0   ← B 的成果被丢弃
最终:   result_storage_keys = ["image:A-STALE"]
```

**后果**：用户看到的是**上一次失败运行**的图片；同时 `attempt=2` 又被真实消耗，上游被计费两次。属"结果污染 + 计费双花"。

**触发现实性**：需要"心跳写库抛异常"。而 `KNOWN-ISSUES.md` §6（P2-9）自己就写着**备份容器以 root 身份对生产库做 INSERT**——这正是制造 `SQLITE_BUSY` 的真实路径（`busy_timeout=5000`，大库 checkpoint 时可达）。

**修法**

```sql
-- SQL_FINISH_SUCCEEDED / SQL_FINISH_FAILED 都加 attempt 围栏
 WHERE id = ? AND status = 'running' AND attempt = ?
```

```ts
// worker.ts 心跳异常分支
} catch (error) {
    leaseLost = true;                 // 拿不到续租就等于失去围栏
    controller.abort();
    console.error(...);
}
```

`markSucceeded(jobId, ..., attempt)` 需要把 `job.attempt` 传进去（`JobRow` 已有该字段）。

---

### P1-R2-2（P1）`downloadBytes()` 完全不过 `guard.ts`：上游可控 URL 的真 SSRF

**位置**：`server/src/providers/http.ts:260-265`

```ts
export async function downloadBytes(ctx: ProviderContext, url: string) {
    if (!/^https?:\/\//i.test(url)) { throw ... }
    return sendBytes(ctx, { url, method: "GET", headers: {} });   // ← 直接 fetch
}
```

**问题**

`routes/proxy.ts` 那一套三道闸（`checkTarget` + `resolveAndCheckHost` + 白名单）只保护**客户端传进来的 URL**。而 `downloadBytes()` 走的是**上游返回的 URL**：

- `providers/openai.ts:381`：`if (state.url) return downloadBytes(ctx, state.url);`
- `parseImageSources` 的 `url` 分支（`openai.ts:286-287`）→ `downloadBytes`
- Gemini 视频/图像同理

这里**没有任何** `isBlockedHost` / 白名单 / DNS 复检。一个被攻破、或被恶意运营的中转站只要返回：

```json
{"data":[{"url":"http://169.254.169.254/latest/meta-data/iam/security-credentials/"}]}
```

服务端就会去抓，抓到的字节经 `persistResults()` → `ingestAssetBytes()` 落成 `image:` 资产，**再由用户通过 `GET /api/assets/:key` 下载回来**。

这不是盲 SSRF——是**带外带数据回传的完整 SSRF**。

**为什么严重**：T03 新增的"任意渠道"设计意味着上游域名来自管理员配置的第三方中转站。云上部署（EC2/阿里云）时 metadata 服务就是云账号凭据。

**修法**

`downloadBytes()` 必须复用 `guard.ts`：

```ts
const check = checkTarget(url, /* 允许集 = 该渠道 host ∪ 结果 CDN 白名单 */);
if (!check.ok) throw new ProviderError(...);
const host = await resolveAndCheckHost(check.url.hostname);
if (!host.ok) throw new ProviderError(...);
```

白名单建议单独配置 `RESULT_DOWNLOAD_ALLOWLIST`（结果 CDN 常与 API 域名不同），并**至少**无条件拒绝 `isBlockedHost`。

---

### P1-R2-3（P1）`isBlockedIpv6` 对 `::ffff:x:y` 形式全线失效

**位置**：`server/src/proxy/guard.ts:87-105`

```ts
const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);   // ← 只认带点的形式
if (mapped) return isBlockedIpv4(mapped[1]!);

const first = value.split(":")[0] ?? "";
if (first.length === 0) return value.startsWith(":") ? false : true;   // ← 以 "::" 开头的全部 return false
```

**问题**

WHATWG URL 会把 `[::ffff:127.0.0.1]` **规范化**成 `[::ffff:7f00:1]`（末 32 位转十六进制）。此时：
1. 正则只匹配带点的写法 → 不命中；
2. `value.split(":")[0]` 对 `::ffff:7f00:1` 得到 `""` → 落进 `startsWith(":") ? false` 分支 → **返回 false（判定为"不阻断"）**。

**实测（E4）**

```
http://[::ffff:127.0.0.1]/         -> hostname=[::ffff:7f00:1]     isBlockedHost=false  ✗
http://[::ffff:169.254.169.254]/   -> hostname=[::ffff:a9fe:a9fe]  isBlockedHost=false  ✗
http://[0:0:0:0:0:ffff:127.0.0.1]/ -> hostname=[::ffff:7f00:1]     isBlockedHost=false  ✗

isBlockedIpv6("::ffff:7f00:1")     = false
isBlockedIpv6("::ffff:a9fe:a9fe")  = false
isBlockedIpv6("::ffff:127.0.0.1")  = true     ← 只有带点的才对
```

端到端（白名单里放了同形字面量）：

```
http://[::ffff:7f00:1]:8080/v1/chat         allow=[::ffff:7f00:1]     => *** 放行 ***
http://[::ffff:a9fe:a9fe]/latest/meta-data/ allow=[::ffff:a9fe:a9fe]  => *** 放行 ***
resolveAndCheckHost("::ffff:7f00:1") => ok=true      ← 第三道 DNS 复检也直接从"是 IP 字面量"返回 ok
```

**可利用性评估（如实说明）**

`checkTarget` 之后仍有 `isAllowedHost` 白名单，而白名单来源是"启用渠道的 base_url host"（需管理员权限）或 `UPSTREAM_HOST_ALLOWLIST`（环境变量）。所以在**当前部署形态**下，攻击者无法自行把 `::ffff:a9fe:a9fe` 塞进白名单 → **不可直接利用**。

但这是**安全控制失效**：文件头 `guard.ts:8-15` 明确宣称"第 2 道闸拦的是内网地址"，而它对整个 IPv4-mapped 十六进制地址族完全失灵；一旦将来允许用户自定义渠道、或运维把某个内网网关写进 `UPSTREAM_HOST_ALLOWLIST`，就直接裸奔。且 `verify-t03.mjs` 的 [4] 组"IPv4/IPv6 网段判定（保留段逐项）"**恰好没覆盖这一族写法**——测试盲区正好压在漏洞上。

**修法**

```ts
const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(value);
if (mapped) {
    if (mapped[1]) return isBlockedIpv4(mapped[1]);
    const hi = parseInt(mapped[2]!, 16), lo = parseInt(mapped[3]!, 16);
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
}
// 并把以 "::" 开头的压缩形式按"未指定/兼容地址"一律视为阻断（fail-closed）
```

同时补测试用例，并把 `first.length === 0` 的默认值从 `false`（放行）改为 `true`（阻断）——安全判定应 fail-closed。

---

### P1-R2-4（P1）幂等键全局唯一且查询不带 owner → 跨租户返回他人任务

**位置**
- `server/migrations/0001_init.sql:198-200`：`CREATE UNIQUE INDEX ux_jobs_idempotency ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;`（**全局，无 owner_id**）
- `server/src/jobs/queue.ts:197-199`：`SQL_SELECT_BY_IDEMPOTENCY = SELECT * FROM jobs WHERE idempotency_key = ? LIMIT 1`（**无 user_id 过滤**）
- `server/src/services/job-service.ts:162-176`：`createJobForUser` 校验的是**请求里的 canvasId** 归属，然后直接返回 `enqueueJob` 的结果

**问题**

用户 B 提交：

```json
{ "canvasId": "<B 自己的画布，通过归属校验>", "idempotencyKey": "<A 用过的键>", ... }
```

`enqueueJob` → `findJobByIdempotencyKey` 命中 **A 的任务行** → `created: false` → `toJobDto(A 的行)` **原样返回给 B**（`routes/jobs.ts:53`，HTTP 200）。

B 因此拿到：A 的 `job.id`、`canvasId`、`nodeId`、`model`、`channelId`、`resultStorageKeys`、`upstreamTaskId`、`errorMessage`。

即使 key 猜不中，还有一个**纯功能性 bug**：同一个用户对两个不同画布用同一 body（同样的 key）重复提交时，第二次会拿到**第一个画布的任务**，前端会把节点挂到错误的画布上。

**可利用性**：需要"猜中/撞上他人的幂等键"。前端用"请求体哈希"，若哈希算法可复现且攻击者知道受害者 prompt，可精确构造。属**租户边界破裂**，修法只需一个词。

**修法**

```sql
-- 迁移 0002（不能改 0001，checksum 会拒绝）
DROP INDEX ux_jobs_idempotency;
CREATE UNIQUE INDEX ux_jobs_idempotency ON jobs (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
```

```ts
// SQL_SELECT_BY_IDEMPOTENCY
SELECT * FROM jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1
```

另建议：命中幂等键时校验 `existing.canvas_id === input.canvasId && existing.type === input.type`，不一致就报 409 而不是静默返回。

---

### P1-R2-5（P1）媒体备份"要么静默跳过、要么失败记成功"，`backups` 表看不出区别

**位置**：`deploy/backup/backup.sh:162-172`

```sh
if [ "$INCLUDE_MEDIA" = "true" ] && [ -d "$STORAGE_LOCAL_ROOT" ]; then
    if tar -czf "$MEDIA_OUT" -C ... ; then
        MEDIA_FILES=...; MEDIA_BYTES=...
    else
        warn "媒体打包失败，已跳过（数据库备份仍然有效）"   # ← 只 warn
    fi
fi
```

**实测（E6 用例 F / H）**

| 场景 | exit | 审计行 |
| --- | --- | --- |
| F：`tar` 打包失败（磁盘满 / 权限 / 文件被改） | 0 | `status='success', media_files=0, media_bytes=0` |
| H：`STORAGE_LOCAL_ROOT` 路径不存在（compose 里改错） | 0 | `status='success', media_files=0`，**连一行日志都没有** |

用例 H 的完整输出里，从头到尾没有出现任何与媒体相关的日志，最后一句是"备份成功"。

**后果**：这正是 P1-3 要消灭的失败模式——"媒体零备份，但备份系统显示一切正常"。操作员看 `backups` 表全是 success，直到真的需要恢复时才发现图片全 404。而且**用例 F 和用例 G（有意关闭）产生的审计行完全一样**，无法区分"失败"和"关闭"。

**修法**（3 行）

```sh
else
    if [ "$INCLUDE_MEDIA" = "true" ]; then
        err "媒体目录不存在：$STORAGE_LOCAL_ROOT（INCLUDE_MEDIA=true 却找不到媒体）"
        record_audit "failed" "$DB_BYTES" 0 0 "media root missing: $STORAGE_LOCAL_ROOT"
        FINISHED=1; exit 1
    fi
fi
```

tar 失败同理（至少 `status='partial'` 或 `failed` + `error_message='media tar failed'`），并在审计行里写 `media_expected=1` 以便区分 G 场景。

---

### P2 清单

| 编号 | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| **P2-R2-1** | `queue.ts:69-84` | `SQL_CLAIM_JOB` 缺 `AND attempt < max_attempts`。实测：`attempt=2 / max_attempts=2` 的 `queued` 行仍被认领，`attempt` 被加到 **3**（超出上限）。成因：`requeueExpired()` 先跑 `SQL_REQUEUE_EXPIRED` 再跑 `SQL_FAIL_EXPIRED`，若进程在两者之间崩溃，attempt 已耗尽的行走不到 `failed` 分支 | `SELECT` 子查询加 `AND attempt < max_attempts` |
| **P2-R2-2** | `queue.ts:298-323` | `markFailed` 不检查 `changes`，无脑返回 `{status, nextAttemptInSeconds}`。任务若已被取消/已被别人收尾，函数仍报"已安排 X 秒后重试"，调用方（worker 日志、未来可能的告警）拿到的是假信息。对比 `markSucceeded` 返回 boolean | 返回 `{applied: boolean, ...}`，`worker.ts:317` 在 `!applied` 时打不同日志 |
| **P2-R2-3** | `worker.ts:141-164` | 注释写"超时后强停"，实际没有任何 `controller.abort()`。10s 后 `state='stopped'`，在途 handler 继续跑、心跳定时器继续续租。优雅停机语义不成立 | 把每个任务的 `AbortController` 存进 `running` 集合，超时后统一 abort |
| **P2-R2-4** | `providers/http.ts:211-221` | `MAX_RESPONSE_BYTES`（512MB）是**先把整个响应 `arrayBuffer()` 读进内存之后**才判的。注释说"防上游返回 2GB 把进程读死"，实际防不住（靠 `AbortSignal.timeout` 兜底，15min 内可读完数 GB） | 改用 `response.body` 流式累计，超限即 `cancel()` |
| **P2-R2-5** | `routes/proxy.ts` 的 `passthroughHeaders`（`d935b95` 中约 207-215 行） | `passthroughHeaders` 原样透传上游 `Content-Type`，且**不加** `X-Content-Type-Options: nosniff`、不回写 CSP。（当前只有 `POST /api/proxy`，浏览器无法用表单/导航直接渲染，故未升级为 P1） | 加 `result["X-Content-Type-Options"]="nosniff"`；非 SSE 时强制 `application/octet-stream` 或加 `Content-Disposition: attachment` |
| **P2-R2-6** | `docker-compose.yml:159` vs `env.ts:14-18` | `BACKUP_INCLUDE_MEDIA` 只注入 `backup` 服务，`server` 服务没有 → server 恒用默认值（§2.5）。另 `boolFromEnv` 只认 `"true"/"false"`，写 `0`/`yes` 会让 server **启动崩溃**，而 backup.sh 会当 false | server 服务补 `BACKUP_INCLUDE_MEDIA: ${BACKUP_INCLUDE_MEDIA:-true}`；`boolFromEnv` 放宽为 `["true","1","yes"]` 或 `.catch()` 兜底默认 |
| **P2-R2-7** | `queue.ts:401-404` | `catch { db.exec("ROLLBACK"); throw error; }`：若失败发生在 `COMMIT` 阶段，`ROLLBACK` 会抛 "no transaction is active" 并**掩盖原始异常**（与 `KNOWN-ISSUES` §9 的 `setup.ts` 同一类问题） | `try { db.exec("ROLLBACK"); } catch {}` 后再 `throw error` |
| **P2-R2-8** | `deploy/Caddyfile:97` | CSP `script-src` 保留 `'unsafe-inline'`（声明偏差 b）。资产侧已闭环，但 SPA 侧"一处 HTML 注入 = 完整 XSS"的爆炸半径未收敛 | 主题脚本外置为 `/theme-boot.js`，用 hash/nonce 放行，逐步去掉 `unsafe-inline` |
| **P2-R2-9** | `mime-whitelist.ts` | `image/png\n`（尾随换行）被接受为 `image/png`（只 `trim()` 首尾空白，换行被 trim 掉，但若中间夹 `\n` 则不同）。实测仅尾随换行可通过，无绕过价值 | 加 `/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/` 字符集预校验 |
| **P2-R2-10** | `doc-sanitizer.ts` | `storageKey="javascript:alert(1)"` 被原样保留（只拦 `data:` / `blob:`）。读侧 `openAsset` 对非法 key 返回 404，无实际风险 | 建议 storageKey 白名单前缀（`image:`/`video:`/`audio:`/`file:`），非法直接置空 |

---

## 6. T03 本体复审：三项核心设计的具体评价

### 6.1 `jobs/queue.ts` 原子认领 —— **设计正确，实测无重复无遗漏**

`SQL_CLAIM_JOB` 用"子查询与 UPDATE 在同一语句"的写法拿 SQLite 写锁，这是**对的**。实测（E5 场景 4）：

```
20 次 claimNextJob 认领到 20 个不同任务，重复=0
```

`verify-t03.mjs` 的 [2] 组更严格（4 条连接轮转 21 次认领 20 个任务），我实跑确认 60/60 全过。

`SQL_REQUEUE_EXPIRED` / `SQL_FAIL_EXPIRED` 用 `attempt < max_attempts` / `attempt >= max_attempts` 分流"回队"与"判死"，避免"永远转圈"，思路清晰。

**唯一缺陷**是收尾无围栏（P1-R2-1）与认领缺上限守卫（P2-R2-1）。

### 6.2 `proxy/guard.ts` SSRF 三重防护 —— **第一、三闸扎实，第二闸有洞，且存在 TOCTOU**

| 闸 | 覆盖情况 |
| --- | --- |
| 1 协议 | ✓ `file:`/`gopher:`/`data:` 全拒；`user:pass@` 全拒 |
| 1' URL 解析 | ✓ `//api.openai.com/x`（协议相对）被 `new URL()` 拒 |
| 2 字面量 | ✓ IPv4 十进制/十六进制/八进制/短写（`2130706433`、`0x7f.0.0.1`、`0177.0.0.1`、`127.1`）**全部**被 WHATWG 规范化后拦住<br>✗ IPv4-mapped IPv6 十六进制形式（`::ffff:7f00:1`）漏判（**P1-R2-3**） |
| 3 白名单 | ✓ `isAllowedHost` 后缀匹配正确：`evilapi.openai.com`、`api.openai.com.evil.tld` 都**不**匹配（实测） |
| 4 重定向 | ✓ `routes/proxy.ts:124` `redirect: "manual"`，不跟随——这是必须的，否则白名单会被跳转绕过 |

**TOCTOU / DNS rebinding**：`resolveAndCheckHost()` 用 `dns.lookup` 查一次，然后 `fetch()` **自己再解析一次**，两者之间没有任何绑定。经典的 rebinding 攻击（TTL=0，第一次返回公网 IP、第二次返回 `127.0.0.1`）在理论上可行。

但实际风险被"白名单是主闸"压住了：攻击者无法把自有域名放进 `upstreamHostAllowlist`（来源是管理员配置的 channels 或环境变量）。**判定：P2 级缺口，建议在修 P1-R2-2 时一并处理**——把解析结果作为 `lookup` 选项传给 `fetch`（Node/undici 支持 `dispatcher` + 自定义 `lookup`），做到"校验用哪个 IP，连接就用哪个 IP"。

### 6.3 `services/channel-service.ts` 密钥边界 —— **声明全部属实，我逐条验证过**

| 声明 | 验证方式 | 结果 |
| --- | --- | --- |
| 只有一处解密 | `grep decryptSecret` 全仓库 | **只有** `channel-service.ts:236` 一处调用（另 2 处是 import 与注释） |
| `ChannelDto` 不含密钥字段 | 读 `db/repos/channels.ts:47-60` | **确实没有** `apiKey`/`apiKeyCipher`/`api_key_hint` 之外的字段（`apiKeyHint` 是 `sk-****6789` 掩码） |
| 日志无明文密钥 | 读 `providers/http.ts:151-155` `scrubSecret()`；`channel-service.ts:238-242` 错误分支只带 `reason` 不带 message | `scrubSecret` 在 `sendJson`/`sendBytes` 的**每条**错误路径上都对 `ctx.apiKey` 做了替换；解密失败只回 `SecretBoxError.reason`。**未发现明文泄漏路径** |
| Worker 侧 | `handlers/shared.ts:104-128` | `apiKey` 只进 `ProviderContext`，用完即弃，不进 params/返回值/日志 |

`verify-t03.mjs` [1] 组的 SecretBox 断言（GCM 篡改检测、换 secret 无法解密、IV 随机）我实跑通过。

**这一块做得很好，没有意见。**

### 6.4 `jobs/handlers/*.ts` 错误处理 —— **"200 + 错误 JSON" 已正确处理**

工程师未主动声明这一项，我专门验证了团队要求的场景：

| 上游返回 | 处理 | 结果 |
| --- | --- | --- |
| `200 {"error":{"message":"quota exceeded"}}` | `openai.ts:269-271` 显式抛 `ProviderError` | ✓ 不当成功 |
| `200 {"code":1,"msg":"..."}`（中转站常见） | `openai.ts:266-268` 显式抛 | ✓ |
| `200 {"output":[]}`（空文本） | `openai.ts:327-329` 抛"上游返回了空文本"（可重试） | ✓ |
| `200 {"data":[]}`（空图片） | `openai.ts:274-276` 抛 | ✓ |
| `200 {"data":[{"foo":"bar"}]}`（字段认不出） | `openai.ts:290-292` 抛，**不可重试** | ✓ |
| `200` 但 body 不是 JSON | `http.ts:232-240` 抛"上游返回的不是合法 JSON"（可重试） | ✓ |
| `200` 且 `byteLength===0` | `http.ts:249-251` 抛"上游返回了空响应体" | ✓ |
| `status:'failed'` 的视频任务 | `openai.ts:377-379` 抛，`retryable:false` | ✓ |

`mapStatus()` 对 401/403/404/429/408/409/425/5xx/400/422 逐档映射，还用正则识别"内容审核拒绝"并归为**不可重试**（`openai.ts:179-184`）——这个细节做得比大多数生产代码好。

`persistResults` 在 `storageKeys.length === 0` 时抛 `JobFailure`（各 handler 都有），不存在"半写入当成功"。

**判定：这块没有缺陷。** 唯一的"半成功"隐患是 `image.ts:54` 多图场景下若第 2 张落盘失败，第 1 张已成资产（孤儿），但任务会整体失败重试——属可接受的取舍，与 `KNOWN-ISSUES` §4（P2-7 孤儿文件）同源。

### 6.5 `proxy/sse.ts` —— 无缺陷

`withHeartbeat` 把 `reader.read()` 的 Promise **跨 pull 保留**在 `pending` 里，这个细节正是流包装最容易写错的地方（写成"每次 pull 重新 read 并在超时后丢弃"会丢 SSE 事件）。注释直接点出了这个坑，代码也对。

`cancel()` 里 `await reader.cancel()` 保证客户端断开时上游被取消（否则上游继续生成并计费）——这是对的。

`verify-t03` [5] 组的 3 条断言（不丢首帧、正常 close、响应头）实跑通过。

---

## 7. 给工程师的具体行动清单

按建议顺序（前 4 条阻断 T04）：

1. **`providers/http.ts:260`** — `downloadBytes()` 接入 `checkTarget` + `resolveAndCheckHost`（P1-R2-2）
2. **`proxy/guard.ts:87-105`** — 补 `::ffff:x:y` 十六进制形式；`first.length === 0` 分支改 fail-closed（P1-R2-3）
3. **新迁移 `0002_jobs_idempotency.sql`** — 索引改 `(user_id, idempotency_key)`；`SQL_SELECT_BY_IDEMPOTENCY` 加 `user_id`（P1-R2-4）
4. **`jobs/queue.ts:145-180` + `worker.ts:246`** — 收尾 SQL 加 `AND attempt = ?`；心跳异常置 `leaseLost`（P1-R2-1）
5. **`deploy/backup/backup.sh:162-172`** — 媒体目录缺失/tar 失败要记 `failed`（P1-R2-5）
6. **`docker-compose.yml`** — server 服务补 `BACKUP_INCLUDE_MEDIA`（P2-R2-6）
7. P2 其余按 §5 表格逐条处理

**新增测试建议**（补上 `verify-t03.mjs` 的覆盖盲区）：

- [队列] "A 认领 → 租约过期 → B 认领 → A 收尾"必须 `changes=0`（当前会 `changes=1`，正是 P1-R2-1）
- [队列] `attempt == max_attempts` 的 `queued` 行必须认领不到（P2-R2-1）
- [guard] `isBlockedHost("::ffff:7f00:1")` 必须为 `true`（P1-R2-3）
- [guard] `downloadBytes` 对 `http://169.254.169.254/` 必须拒绝（P1-R2-2）
- [幂等] 用户 A 用 key `k` 建任务后，用户 B 用 key `k` 必须**新建**而不是返回 A 的任务（P1-R2-4）
- [backup] `INCLUDE_MEDIA=true` + 媒体目录不存在 → 审计行必须是 `failed`（P1-R2-5）

---

## 8. 复审过程的自查

| 项 | 状态 |
| --- | --- |
| 是否修改了仓库代码 | 仅一次：为做反向验证临时改 `canvas-service.ts:276`，**已 `git checkout` 复原并 `Read` 复核**，`git status --short` 为空 |
| 是否新增了仓库文件 | 仅本报告 |
| 是否有结论没有实跑证据 | 无。所有 P1/P2 都附了实测输出或明确的代码行 |
| 是否越权评价了 T04/T05 范围 | §3(b) 提到 SPA 侧 XSS 依赖 React 转义，已明确标注"属 T05 前端审查范围，本轮未证伪" |
| 无法在本环境验证的项 | `docker compose` 真实启动、Caddy 实际下发头、`backup.sh` 在真 sqlite3/gzip/rclone 下的行为。这些已在对应章节标注为"静态审查" |
| 行号基准 | 全部行号以 `d935b95`（HEAD）为准。复审结束时工作区已存在**他人未提交的 T04 改动**（`web/**` + `routes/proxy.ts` 的字节透传分支），本报告未评价那部分代码 |

---

## 9. 附：复审结束时工作区状态说明（非本报告结论，供主理人判断）

复审收尾时 `git status --short` 显示工作区已有他人未提交的改动，因此本报告**只针对 `d935b95` 已提交内容**：

```
 M server/src/routes/proxy.ts
 M web/**（11 个文件）
?? web/src/services/{asset-bridge,canvas-server-sync,channel-secrets,server-api,server-fetch}.ts
```

其中 `server/src/routes/proxy.ts` 的新增内容值得**立刻确认**（不在本轮结论内，仅提示）：

```ts
const rawUrl = c.req.query("url");                 // ← URL 来自 query
const rawContentType = c.req.header("content-type") ?? "";
if (isBytePassthrough(rawUrl, rawContentType)) {
    return await proxyBytes(c, user.id, rawUrl as string, ...);   // ← 新出口
}
```

- `method` 的枚举从 `["GET","POST"]` 放宽到 `["GET","POST","PUT","PATCH","DELETE"]`；
- 新增一条**绕过 `readJsonBody`** 的字节透传出口，目标 URL 从 **query 参数**取。

如果 `proxyBytes()` 内部没有复用 `checkTarget` + `resolveAndCheckHost`，那就是第二个 `downloadBytes`（即 P1-R2-2 的同类问题）。**建议在 T04 提交前先让 QA 看这段。**

---

*报告生成：QA（Edward）· 2026-10-26 · 对应 commit `d935b95` + `46f5133`*
