# BASELINE — 上游基座锁定记录

> 目的（ARCH Rev2 §P0-11 / T01 第 8 条）：把「我们改的是哪个上游版本」钉死，
> 便于将来 diff 上游、判断能否安全合入新版本，以及在出问题时精确回退。
>
> 本文件**不随日常开发更新**。只有主动升级上游基线时才修改。

---

## 1. 基线标识

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/basketikun/infinite-canvas` |
| 本项目 fork（clone 来源） | `https://ghfast.top/https://github.com/andywang131419/infinite-canvas.git` |
| 上游版本号 | **`v0.20.0`**（取自仓库根 `VERSION` 文件） |
| 基线 commit | **`9cd3deacbcc598361807afc16c059a80dd18b6f9`** |
| commit 标题 | `feat(README): add KunrouAI logo and description to the README` |
| commit 时间 | `2026-10-25 19:21:15 +0800`（作者 HouYunFei） |
| 仓库 license | MIT（见根目录 `LICENSE`） |
| 本地分支 | `main`（基线）、**`stable`**（本项目改动基线，不 push） |

### 1.1 关于 commit / tag 的说明（重要）

本仓库是**浅克隆**（shallow clone，`depth=1`）：

- `git rev-list --count HEAD` = **1**
- `.git/shallow` 存在
- `git tag --points-at HEAD` 为空 —— 上游 tag 历史未拉取

因此**无法用 `git describe` / `git tag` 定位上游 tag**。
基线标识以两个不可变事实为准：

1. `VERSION` 文件内容 = `v0.20.0`
2. HEAD commit = `9cd3dea`

> 若将来需要完整上游历史，执行：
> `git fetch --unshallow --tags origin`（需要能连通 github.com）

---

## 2. 关键文件哈希（用于判断「是否被人手改过」）

算法：SHA-256，小写十六进制。

| 文件 | 大小（bytes） | SHA-256 |
|---|---:|---|
| `web/bun.lock` | 334096 | `51df6264668da87d49c4ccf0fc40c3cd5ae3651741af30027c38b1494e698841` |
| `web/package-lock.json` | 729745 | `cc4de9adcfcb6f2d27ae1106a8d68622c7ce1c72047b41e9dfdaf1984b5e701f` |
| `web/pnpm-lock.yaml` | 349303 | `85eb2d17aeaa777ee84cb6a89f94f92174b1f8b60ccba160fdd37f5e56de559f` |
| `VERSION` | 7 | `f8385526da05bdcc76869d8c973d0903aa37865660439f9dd95d9dfc95e48c96` |
| `CHANGELOG.md` | 28094 | `c44be00cd6271f297dfc309202980421f07c615a831288f91d6410b2cbe8b2c1` |

校验命令（Git Bash / Linux）：

```bash
sha256sum web/bun.lock web/package-lock.json web/pnpm-lock.yaml VERSION CHANGELOG.md
```

校验命令（PowerShell）：

```powershell
Get-FileHash web/bun.lock, VERSION -Algorithm SHA256
```

---

## 3. 锁定说明（本项目对上游的约束）

### 3.1 包管理器：**只允许 bun**

上游仓库同时存在三份 lock（`bun.lock` / `package-lock.json` / `pnpm-lock.yaml`），
但**权威只有 `bun.lock`**，依据：

- 上游 `Dockerfile:5-6`：`COPY web/package.json web/bun.lock ./` + `bun install`
- 上游 `Dockerfile:10`：`bun run build`
- `web/package.json:10`：测试为 `bun test`
- `web/pnpm-workspace.yaml` 只有 `allowBuilds` 占位，**不是**真正的 workspace

**约束**：

- ❌ 不得用 `npm install` / `pnpm install` 在 `web/` 下生成新 lock 或改写现有 lock
- ❌ 不得删除或「统一」三份 lock（保持与上游可比）
- ✅ 本地开发用 `bun install` / `bun run dev`
- ✅ `server/` 同样用 bun（Bun 直接执行 TypeScript，无构建阶段）

### 3.2 不允许引入的技术（ARCH §R3 / §R9.3）

`canvas-proxy/` 保持上游原样、**不修改、不部署、不暴露端口**。
明确不引入：Next.js、PostgreSQL、Redis/BullMQ、MinIO、NextAuth、Prisma、better-sqlite3、bcryptjs、vitest。

### 3.3 不改动的上游文件（T01 起）

- `web/src/pages/canvas/project.tsx`（198 KB 单文件）：改造时只做**行级替换**，不做重构
- `nginx.conf`：**零改动**（`/api` 由 Caddy 在外层拦截，永远到不了 nginx）
- `canvas-proxy/**`：原样保留

### 3.4 `web/package.json` 版本号与 `VERSION` 的关系

`web/package.json:3` 的 `version` 是 `0.1.0`，**与根 `VERSION`（`v0.20.0`）不同步**。
真实版本号的唯一来源是根 `VERSION` 文件：

- `web/vite.config.ts:10` 读 `../VERSION`
- `web/vite.config.ts:50` 通过 `define` 注入 `__APP_VERSION__`
- 前端经 `web/src/constant/env.ts:1` 导出 `APP_VERSION`

**不要**去改 `web/package.json` 的 version 字段来「对齐」——那会与上游产生无意义 diff。

---

## 4. 本项目的改动基线

| 项 | 值 |
|---|---|
| 本地分支 | `stable` |
| 起点 | `main` @ `9cd3dea` |
| 用途 | 自托管改造（server / deploy / web 增量）的长期基线分支 |
| 远端 | **不 push**（本机到 github.com 网络不通，仅本地保留） |
| 上游同步策略 | 需要升级时，在 `main` 上 pull 上游 → 与 `stable` 做 diff 评估 → 再决定是否 rebase |

新增目录（相对上游）：

```
server/     后端（Bun + Hono + bun:sqlite）
deploy/     部署编排（Caddy + compose + backup）
docs/       本项目文档（BASE-SURVEY.md / BASELINE.md / ARCH 副本）
```

---

## 5. 变更记录

| 日期 | 事件 |
|---|---|
| 2026-10-25 | 完成只读基座探查，产出 `docs/BASE-SURVEY.md` |
| 2026-10-25 | T01：创建 `server/` 与 `deploy/` 骨架，打通部署链路；建立 `stable` 分支 |
| 2026-10-25 | T02：数据层仓储 + argon2id/不透明 token 鉴权 + doc 清洗 + 资产内容寻址存储 + 画布 CRUD 乐观锁 |

---

## 6. 待办：`server/bun.lock`（**必须由有 Bun 的环境生成**）

**现状（T02 结束时仍未解决）**：`server/` 下**没有** `bun.lock`。

原因：当前开发机只有 Node 22（`node -v` → v22.22.2）、npm、git，**没有 Bun**，
也没有 Docker。因此 `bun install` 无法执行。

`server/Dockerfile` 当前写的是：

```dockerfile
RUN bun install --production
```

并且**故意保留** `--frozen-lockfile` 的 TODO 注释以及"先不要切 frozen"的提示。
这不是遗忘，而是刻意的：在没有 lock 文件的情况下加 `--frozen-lockfile` 会让镜像构建
直接失败（`bun install --frozen-lockfile` 找不到 lock 时会报错退出）。

### 解锁步骤（在有 Bun 的机器/CI 上执行，约 1 分钟）

```bash
cd server
bun install                 # 生成 server/bun.lock
bun run typecheck           # 顺手把 T01/T02 积压的类型检查跑一遍
bun test                    # T02 未写 bun:test 用例，此步会显示 0 tests（正常）
cd ..
git add server/bun.lock
git commit -m "chore(server): 提交 bun.lock，锁定后端依赖"
```

然后把 `server/Dockerfile` 的 `bun install --production` 改成：

```dockerfile
RUN bun install --production --frozen-lockfile
```

并删掉 Dockerfile 里那条 TODO 注释。

### 为什么现在不"凑"一个 lock

- 用 npm 生成 `package-lock.json` 塞进 `server/` 是**假 lock**：Bun 不读它，
  镜像构建照样不可复现，还会让人误以为已经锁定；
- 手写 `bun.lock` 更糟：Bun 会校验 integrity，手写必然与实际 tarball 不匹配。

所以这里只记录 TODO，不做替代动作。

### 同一批待办里还有两条（T02 发现，非阻塞）

1. `server/package.json` 里仍留着 `drizzle-orm` / `drizzle-kit`，但 T01/T02 的
   数据层全部走 `bun:sqlite` 原生 SQL（见 `server/src/db/client.ts` 注释）。
   这两个依赖当前**未被引用**。等有 Bun 环境时一并决定：要么删掉（推荐，
   可省掉 `drizzle-kit` 那一串传递依赖），要么在 T03 用它做类型化查询。
2. `bun run typecheck` 需要在 `bun install` 之后才能跑（`tsc` 与 `@types/bun` 都在
   `devDependencies` 里）。T02 的替代验证见下节。

---

## 7. T02 的替代验证方式（无 Bun / 无 Docker 时怎么保证质量）

`server/scripts/verify-t02.mjs` 只用 **Node 22 自带能力**跑真断言，覆盖：

| 覆盖点 | 手段 |
|---|---|
| 迁移可执行 + 幂等 | `node:sqlite` 真跑 `0001_init.sql` |
| **乐观锁 20 并发只成功 1 个** | 从 `src/db/repos/canvas-sql.ts` **正则抽取** `SQL_UPDATE_CANVAS_CAS` 原文后在 SQLite 上执行（不是抄一份 SQL） |
| **doc 清洗后 DB 无内联 base64 / blob:** | 直接 `import` `src/services/doc-sanitizer.ts`（Node 22 默认类型剥离），清洗结果真写进 SQLite 再读回断言 |
| **路径穿越 400** | 直接 `import` `src/storage/key.ts`，17 组恶意 key 全部断言抛错 |
| 内容寻址 / Range / 去重 / 原子写 | 直接 `import` `src/storage/local-disk.ts`，在临时目录真读写 |
| 全部 `.ts` 语法 | `node:module` 的 `stripTypeScriptTypes()` 逐文件解析（等价 tsc 语法阶段） |

运行：`cd server && node scripts/verify-t02.mjs`

**它不能替代**的部分（必须在有 Bun 的机器上补跑）：
`bun install` / `bun run typecheck` / `bun test` / 服务真实启动 + `curl` 登录画布全链路 /
`docker compose build`。
