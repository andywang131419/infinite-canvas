# T05 真机部署验证清单

> 目的：在真实 VPS 上把 `ic-user2` 跑起来并证明"数据能持久、备份能用、能恢复、功能正常"。
> 配套总文档：`docs/DEPLOY-VPS.md`（完整部署手册，含 4 服务 docker-compose、Caddy、rclone、初始化、备份、恢复演练）。
> 本清单只列**验证动作 + 预期结果**，按阶段顺序在 VPS 上执行，任何一步不达标就停。

---

## 阶段 0：仓库侧已完成的预检（无需 VPS 做）

这些在提交里已经做好，VPS 上不必再处理：

- ✅ `server/bun.lock` 已生成并提交，`server/Dockerfile` 用 `bun install --frozen-lockfile --production` → 镜像构建可复现（ closes KNOWN-ISSUES #2）。
- ✅ 根 `Dockerfile` 的 `COPY` 引用文件全部存在：`nginx.conf`、`web/bun.lock`、`web/docker-entrypoint.sh`（VPS `docker compose build` 不会因缺文件失败）。
- ✅ 备份三处代码 bug **已修**（DEPLOY-VPS.md 附录 A 标 ✅）：
  - **F2** `entrypoint.sh` 与 `backup.sh` 共用 `is_truthy`（认 `true/1/yes/on`），写 `1/yes/on` 也能开备份，不再静默关闭；
  - **F3** `entrypoint.sh` 启动自动把 `/data/backups` chown 到 uid 1000（设置页「立即备份」不再需要手动 chown）；
  - **F5** `BACKUP_ON_START` 已接进 `docker-compose.yml` + `.env.example`，默认 `true`，容器启动即先备份一次。

---

## 阶段 1：构建（VPS）

```bash
cd /srv/ic
git pull                                  # 拉到含 server/bun.lock 的版本
cd deploy
docker compose build --no-cache
```

**验收**：4 个镜像（`web` / `server` / `backup` / `caddy`）都 build 成功退出。
**排错**：若 `web` 构建报 `COPY` 找不到 `nginx.conf` / `web/docker-entrypoint.sh` / `web/bun.lock`，说明这些文件没随 commit 带上 —— 回仓库确认它们已 `git add` 并提交（已在阶段 0 预检通过，正常不会触发）。

---

## 阶段 2：启动 + 健康检查

```bash
docker compose up -d
docker compose ps            # 4 个 Up；server 带 healthy（HEALTHCHECK 生效）
docker compose logs --tail 50 server
docker compose logs --tail 30 caddy
```

**验收**：
- `curl -k https://127.0.0.1/api/health` → `200`，且 `db` 状态 `ok`（server 健康探针）。
- `curl -k -o /dev/null -w '%{http_code}' https://127.0.0.1/` → `200`，返回 `index.html`。
- `curl -kI https://<你的域名>/` → `200`，证书有效（或自签告警，属预期）。
- `docker compose ps` 中 `server` 状态应为 `healthy`（不是单纯 `Up`）。

---

## 阶段 3：初始化 owner 账号

- 浏览器打开 `https://<你的域名>` → 系统检测 `users` 表为空，显示初始化页 → 用准备好的邮箱/密码建号，这个账号即 owner。
- `curl -k https://127.0.0.1/api/setup/status`
  - 建号前：`{"ok":true,"data":{"initialized":false,"registrationEnabled":false}}`
  - 建号后：`{"ok":true,"data":{"initialized":true,"registrationEnabled":false}}`
- 若一直是 `false` 但明明建过号 → 连的不是这个库（检查 `DATABASE_PATH` 与卷挂载）。

---

## 阶段 4：备份验证（**最关键，必须全绿**）

```bash
# (1) 首份备份应在启动时已做（F5 已修）——
docker compose exec backup sh -c 'ls -lht /data/backups | head'
# 预期：有 app-<stamp>.sqlite.gz；若已传过图，还有 media-<stamp>.tar.gz

# (2) rclone 配置（仅当配了 RCLONE_REMOTE 时）——
docker compose exec backup rclone config file
# 预期：/root/.config/rclone/rclone.conf（F1 已修）

# (3) 审计行 —— 至少一条 success ——
docker compose exec backup sqlite3 -header -column /data/app.db \
  "SELECT status, COUNT(*) c FROM backups GROUP BY status;"
# 预期：success >= 1

# (4) 设置页「立即备份」按钮 → 在浏览器点一下，预期成功（F3 已修，自动 chown）
# 或命令行强制再跑一次：
docker compose exec backup /usr/local/bin/backup.sh
# 预期：最后一行 [backup …] 备份成功，退出码 0
```

**排错**：
- 审计行出现 `rclone config missing` / `rclone upload failed` → rclone.conf 没放对（`deploy/rclone/rclone.conf` 被挂到 `/root/.config/rclone/`）。
- 审计行 `failed` + `media directory missing` → 全新部署还没传过图；先传一张图，或执行 `docker compose exec server mkdir -p /data/media`（F4 缓解）。
- 「立即备份」报 `BACKUP_FAILED` → 多半 `/data/backups` 属主异常（正常不应发生，F3 已修）。

---

## 阶段 5：恢复演练（上线一周内**必须**真做一次）

> 备份 ≠ 能恢复。没演练过的备份等于没有。按 `docs/DEPLOY-VPS.md` 第 6.6 节完整走一遍：

1. 确认已有至少一份成功备份（`/data/backups/app-*.sqlite.gz`）。
2. 停服务（`docker compose stop server`）。
3. 用最新 `.gz` 还原 `/data/app.db`（先备份当前库再覆盖）。
4. `docker compose start server` → 健康检查转 `healthy`。
5. 浏览器登录，打开画布、确认图片能加载、画布内容与还原前一致。

---

## 阶段 6：功能回归冒烟

- 建/打开一个画布，传一张本地图片（验证服务端资产存储 + `RESULT_DOWNLOAD_ALLOWLIST` 已填域名）。
- 跑一次 AI 生图（验证 `server-api.ts` / `server-fetch.ts` AI 调用收口 + 代理路径）。
- 生成过程中刷新页面 → 生成任务应能从 `GET /api/jobs?canvasId=&open=true` 恢复（T04-B 刷新可续）。
- **跨设备**：用另一台设备/手机登录同一账号 → 画布与图片都在（验证服务端持久化，而非本地存储）。

---

## 阶段 7：收尾

- 按 `docs/DEPLOY-VPS.md` 第 8 节（每周自查）：`docker compose ps` + 审计行 + `df -h`。
- 配置对象存储生命周期规则（F7：远端只增不删，容量会单调增长）。
- `deploy/Caddyfile` 的 CSP 仍是 `unsafe-inline`（F8 / KNOWN-ISSUES #12，T05 未做 hash 化）—— 不要往站点挂第三方脚本。

---

## 已知仍待办（非阻塞，单用户部署下不影响上线）

| 项 | 说明 |
|---|---|
| F4 | 全新部署若首夜没传过图，备份记 `failed`（预建 `/data/media` 规避，阶段 4 已含） |
| F6 | `backup` 服务无 healthcheck，crond 僵死时 `docker ps` 仍显示 Up —— 每周查审计行 |
| F7 | rclone 远端只增不删 —— 对象存储侧配生命周期 |
| F8 | `web` 服务无 healthcheck —— nginx 挂了 Caddy 仍转发会 502 |
| KNOWN-ISSUES #1/#3/#8 | 放开公开注册前的阻断项（跨用户去重 / canvasId 归属 / sessions 索引） |
| KNOWN-ISSUES #11 | 视频「参考视频/音频」参数未透传（功能缺口，非崩溃） |
| KNOWN-ISSUES #12 | antd 6 `Modal styles.content` 基线类型错误（不影响 `vite build`） |
