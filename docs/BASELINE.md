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
