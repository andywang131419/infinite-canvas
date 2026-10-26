# 生产部署手册：一台全新 VPS 从零上线（infinite-canvas fork）

> **这份文档给谁看**：项目 Owner（迪哥）。假设你拿到的是一台空 VPS，只会复制粘贴命令。
> **目标**：上线一套「注册后数据永久保存在服务端、换设备/清缓存都不丢、每天有备份且备份能恢复出来」的服务。
> **约定**：
> - 所有命令都在 **VPS 的终端**里执行（不是你本机 Windows）。
> - `$` 开头表示这是一条命令，复制时**不要**把 `$` 复制进去。
> - `<尖括号>` 里的内容是需要你替换的（比如 `<你的域名>`），替换时把尖括号也去掉。
> - 每一节末尾都有 **「验收」**。**验收没通过就别往下走**，先按「不达标说明什么」排查。
> - 全文所有相对路径都以仓库里的 `deploy/` 目录为基准。

---

## 目录

1. [前置条件](#1-前置条件vps规格系统端口域名)
2. [服务器初始化](#2-服务器初始化docker--非-root-用户--目录规划)
3. [生成 `.env`](#3-生成-env逐项必填说明不填会怎样)
4. [首次启动与数据卷](#4-首次启动顺序与数据卷持久化路径)
5. [Caddy 反代与 TLS 自动签发](#5-caddy-反代与-tls-自动签发)
6. [备份与恢复（本文档的重点）](#6-备份与恢复重点)
7. [升级与回滚](#7-升级与回滚)
8. [上线后健康检查清单](#8-上线后健康检查清单)
9. [已知风险与待办](#9-已知风险与待办上线后如何自查)
10. [附录 A：本次对 deploy 配置的审查发现](#附录-a本次对-deploy-配置的审查发现问题清单)

---

## 0. 先把结论说在前面（务必读完这 10 行）

1. **数据会不会丢**：架构上不会 —— `server` 和 `backup` 两个容器都挂了同一个命名卷 `data:/data`，数据库 `/data/app.db` 和媒体 `/data/media` 都落在这个卷上，删除容器、重建容器、`docker compose down` 都**不会**删掉它。（本次审查专门查了"卷挂载缺失"，**没有发现**这类问题。）
2. **但是**：备份默认只写在**这台 VPS 自己的磁盘**上。VPS 被删、被黑、机房故障 = 数据全没。**必须配置 rclone 远端（第 6.4 节）**，这是本项目的生命线。
3. **备份不等于能恢复**。第 6.6 节有一次完整的恢复演练步骤，**上线第一周内必须真做一次**。没演练过的备份等于没有。
4. 本次审查发现了 **3 个会让"备份静默失效"的真实配置错误**（`deploy/docker-compose.yml:179`、`deploy/backup/entrypoint.sh:11`、`entrypoint.sh:18` 造成的目录属主问题），详见[附录 A](#附录-a本次对-deploy-配置的审查发现问题清单)。在修好之前，请严格按第 6 节的**手动补救命令**操作。
5. 文档里所有 shell 脚本部分（backup.sh / entrypoint.sh）是**源码级审查**结论，写文档的本机是 Windows，没有 bash/sqlite3/gzip/rclone，**没有真跑过**。所以每一步都给了"验收命令"，请你按验收结果为准。

---

## 1. 前置条件（VPS 规格、系统、端口、域名）

### 1.1 VPS 规格建议

| 项目 | 最低 | 推荐 | 说明 |
| --- | --- | --- | --- |
| CPU | 2 核 | 2 核 | 生图/生视频任务的耗时主要卡在**上游 API**，不在本机 CPU |
| 内存 | 2 GB | **4 GB** | 前端构建是在**镜像构建时**做的（不吃运行时内存）；但 web 镜像构建峰值约 2GB，内存太小构建会 OOM |
| 磁盘 | 40 GB SSD | **按「媒体总量 × 2.5 + 20GB」估算** | 见下方容量公式 |
| 带宽 | 1 Mbps | 3 Mbps 以上 | 图片/视频上传下载都走这条线 |
| 机房 | 任意 | **出海优先** | 见 1.4 的备案提醒 |

**磁盘容量公式**（照着算，别拍脑袋）：

```
需要磁盘 ≥ 媒体总量 × 2  +  数据库大小 × 15  +  10GB（系统与镜像）

其中：
  媒体总量 × 2   = 一份是 /data/media 本体，另一份是每晚 tar 出来的 media-*.tar.gz
                   （BACKUP_INCLUDE_MEDIA=true 时，打包期间磁盘峰值 ≈ 媒体总量 × 2）
  数据库 × 15    = 保留 14 天，每天一份 gzip 快照（gzip 后通常只剩 1/5 ~ 1/10）
```

举例：你预计会有 10GB 图片/视频 → `10×2 + 1×15 + 10 ≈ 45GB`，买 60GB 的盘比较从容。

> ⚠️ **磁盘写满的后果**：备份 `tar` 会失败 → `backup.sh` 记 `failed` 审计行并 `exit 1`；更糟的是 SQLite 写不进去 → 全站保存失败。所以**磁盘余量低于 30% 就要扩容或清媒体**。

### 1.2 操作系统

- **Ubuntu 22.04 LTS 或 24.04 LTS**（64 位）。其它发行版也能跑，但本手册的命令是 Ubuntu 的。
- 必须是 **全新、干净** 的系统：上面不要已经装了 nginx / apache / 宝塔，否则 80/443 端口会被占住，Caddy 起不来。

验收：

```bash
$ cat /etc/os-release | head -n 2
# 预期：NAME="Ubuntu"  VERSION="22.04.x LTS" 或 24.04

$ sudo ss -tlnp | grep -E ':80 |:443 '
# 预期：没有任何输出（80/443 空闲）
# 不达标说明什么：有输出说明端口被占用，先停掉占用者（通常是 nginx/apache），
#                 否则 Caddy 会因为 bind: address already in use 反复重启。
```

### 1.3 需要开放的端口

| 方向 | 端口 | 用途 | 是否必须 |
| --- | --- | --- | --- |
| 入站 | 22/tcp | SSH 登录 | 必须（建议改成密钥登录） |
| 入站 | **80/tcp** | HTTP；**Let's Encrypt 签发证书必须走它** | 必须 |
| 入站 | **443/tcp** | HTTPS 主入口 | 必须 |
| 入站 | 443/udp | HTTP/3（QUIC） | 可选，不影响可用性 |
| **出站** | **443/tcp** | 访问 AI 服务（生图/生视频）与结果 CDN | **必须**，见下 |
| 入站 | 8787 / 3000 | 内部端口（`docker-compose.yml` 用的是 `expose`，**不对外发布**） | **不要开放** |

> ⚠️ **出站 443 经常被忽略**：服务端要去上游拿生成结果（`RESULT_DOWNLOAD_ALLOWLIST` 里那些 CDN 域名）。很多便宜 VPS / 国内机器默认不限制出站，但如果你加了严格的出站规则，**必须放行 443 出站**，否则现象是「任务显示成功，画布上没图」。

云厂商的话：在 **安全组/防火墙** 里开 22/80/443。系统内防火墙（可选）：

```bash
$ sudo ufw allow 22/tcp
$ sudo ufw allow 80/tcp
$ sudo ufw allow 443/tcp
$ sudo ufw allow 443/udp
$ sudo ufw --force enable
$ sudo ufw status
# 预期：Status: active，且上面 4 条 ALLOW 都在
```

> 注意：Docker 自己会写 iptables，个别系统上开 `ufw` 后 Docker 发布的端口会不通。**若你开了 ufw 之后 80/443 突然访问不了，先 `sudo ufw disable` 对照一次**；只要云厂商安全组开着，系统内 ufw 不开也完全可以。

### 1.4 域名解析

准备一个域名（例如 `canvas.example.com`），在你的 DNS 服务商处加一条 **A 记录**指向 VPS 的公网 IP。

| 类型 | 名称 | 值 |
| --- | --- | --- |
| A | `canvas`（或你想要的二级域名） | `<你的 VPS 公网 IP>` |

验收（**在 VPS 上执行**）：

```bash
$ curl -s ifconfig.me
# 记下输出的 IP，这就是你的公网 IP

$ dig +short canvas.example.com
# 预期：输出与上面 ifconfig.me 完全相同的 IP
# 不达标说明什么：
#   - 输出为空 / 输出别的 IP → DNS 没生效或填错了。Caddy 会在申请证书时失败并反复重启，
#     表现为"站点一直打不开"。DNS 生效通常要 1~10 分钟，最长 48 小时。
```

> ⚠️ **中国大陆 VPS 特别注意**：大陆机房的 80/443 需要 **ICP 备案** 才能对外服务。没备案的话，80/443 会被封，Let's Encrypt 也签不到证书（HTTP-01 挑战走 80 端口）。**没备案建议直接用海外 VPS**，别在这上面耗时间。

### 1.5 开工前请把这张表填好

后面每一步都要用，先在纸上/记事本里填完：

| 项 | 你的值 | 用在哪 |
| --- | --- | --- |
| 域名 | `____________` | `.env` 的 `APP_DOMAIN` |
| 你的邮箱（收证书到期通知） | `____________` | `.env` 的 `TLS_MODE` |
| AUTH_SECRET（等下生成） | `____________` | `.env` 的 `AUTH_SECRET`，**记到密码管理器里** |
| 首个管理员邮箱 / 密码 | `____________` | 首次打开站点时建号 |
| 你用的 AI 中转站域名 | `____________` | 结果下载白名单（可上线后补） |
| 异地备份目标（对象存储等） | `____________` | `RCLONE_REMOTE` / `RCLONE_DEST` |

---

## 2. 服务器初始化（docker + 非 root 用户 + 目录规划）

### 2.1 建一个非 root 用户

全程不要用 root 跑应用。先建用户（本节命令用 root 身份执行）：

```bash
$ adduser ic
# 按提示设密码，其余一律回车

$ usermod -aG sudo ic
```

### 2.2 安装 Docker 与 Compose 插件

```bash
$ curl -fsSL https://get.docker.com | sh
$ usermod -aG docker ic
```

验收（**注意：必须退出重登，用户组才生效**）：

```bash
$ exit        # 退出 SSH
# 重新用 ic 登录：ssh ic@<你的 VPS IP>

$ docker version
# 预期：Client 与 Server 两段都有输出

$ docker compose version
# 预期：Docker Compose version v2.xx.x（必须是 v2.3.3 以上，因为 compose 文件用了顶层 name: 字段）
# 不达标说明什么：
#   - "permission denied while trying to connect to the Docker daemon" → 没重新登录，或没加进 docker 组
#   - "docker: command not found" → 安装脚本没跑成功，重跑一次并把报错发出来

$ docker run --rm hello-world
# 预期：Hello from Docker!
```

### 2.3 限制 Docker 日志体积（强烈建议，防磁盘被日志撑爆）

```bash
$ sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
$ sudo systemctl restart docker
$ docker info | grep -A2 'Logging Driver'
# 预期：Logging Driver: json-file
```

### 2.4 目录规划

| 路径 | 是什么 | 会不会被删 |
| --- | --- | --- |
| `/srv/ic` | 仓库代码（含 `deploy/` 与 `deploy/.env`） | 你手动删才会没 |
| `/srv/ic/deploy/.env` | **唯一的密钥文件**，权限 600 | 同上；**换了它=AUTH_SECRET 变了=所有人掉线** |
| `/srv/ic/deploy/rclone/` | rclone 远端配置（含对象存储密钥，已 gitignore） | 同上 |
| `/var/lib/docker/volumes/infinite-canvas_data/_data` | **全部生产数据**（数据库 + 媒体 + 本地备份） | `docker compose down` 不会删；`down -v` 才会删 |

拉代码：

```bash
$ sudo mkdir -p /srv/ic && sudo chown -R ic:ic /srv/ic
$ cd /srv/ic
$ git clone <你的仓库地址> .
# 如果仓库是私有的，用 ssh 地址并配好 deploy key；或者在本机打包后 scp 上去

$ ls
# 预期能看到：Dockerfile  nginx.conf  VERSION  CHANGELOG.md  web/  server/  deploy/
# 不达标说明什么：看不到 deploy/ 说明仓库拉错了分支/不完整，后面全都会失败

$ ls deploy
# 预期：Caddyfile  docker-compose.yml  .env.example  backup/
```

验收（这一节的收尾检查）：

```bash
$ whoami          # 预期：ic
$ docker compose version | head -n1
$ ls /srv/ic/deploy/docker-compose.yml
```

---

## 3. 生成 `.env`（逐项必填，说明"不填会怎样"）

### 3.1 生成步骤

```bash
$ cd /srv/ic/deploy
$ cp .env.example .env
$ chmod 600 .env

# 生成 AUTH_SECRET（输出一长串，复制它）
$ openssl rand -base64 48

# 编辑
$ nano .env
# nano 操作：方向键移动，改完按 Ctrl+O 回车保存，Ctrl+X 退出
```

改完后自检（**这两条必须都通过**）：

```bash
$ docker compose config > /dev/null && echo "compose 配置 OK"
# 预期：compose 配置 OK
# 不达标说明什么：会直接打印缺哪个变量。最常见是 AUTH_SECRET 没填
#                 （compose 第 87 行写了 ${AUTH_SECRET:?...}，空值直接拒绝启动）

$ grep -c '=$' .env
# 预期：0（没有任何一行是"变量名="这种空值；除了本来就该空的 ANALYTICS_*/API_BASE_URL/UPSTREAM_HOST_ALLOWLIST 之外）
```

### 3.2 必填变量逐项说明

分三档：
- 🟥 **不填 = 起不来 / 功能全阻断**
- 🟧 **不填 = 静默失效**（能起来、看着正常，但某件事其实没在做 —— 最危险）
- 🟩 **保持默认即可**，改错了才会出事

| 变量 | 档 | 填什么 | 不填 / 填错的后果 |
| --- | --- | --- | --- |
| `AUTH_SECRET` | 🟥 | `openssl rand -base64 48` 的输出（≥32 字符） | 空 → `docker compose` **直接拒绝启动**；<32 字符 → server 进程启动崩溃；**改一次这个值 = 所有人登录态失效 + 渠道密钥解不开** |
| `APP_DOMAIN` | 🟥 | 你的真实域名，如 `canvas.example.com` | 留空 = `localhost` → Caddy 只为 localhost 签发、公网访问直接失败；且配了邮箱也签不到证 |
| `TLS_MODE` | 🟥 | 你的邮箱，如 `dige@example.com` | 留空 = `internal` 自签证书 → 每次打开都是红色安全警告，且**配了 `APP_DOMAIN` 真实域名也签不到 Let's Encrypt 证书** |
| `RESULT_DOWNLOAD_ALLOWLIST` | 🟥 | 结果文件所在域名，逗号分隔（见 3.3） | 留空 = **拒绝一切结果下载** → 现象是"AI 说生成成功了，画布上永远没有图"。这是 fail-closed 的安全设计，不是 bug |
| `BACKUP_ENABLED` | 🟧 | **只能写 `true`** | 🔴 写 `1` / `yes` / `on` / `True` → `entrypoint.sh:11` 只认精确的 `"true"`，会被判为"关闭备份" → **容器空转、一条备份都不做，而且没有任何报错**（详见附录 A F2）。在修复前请**写死 `true`** |
| `BACKUP_INCLUDE_MEDIA` | 🟧 | `true` | 写 `false`/`0`/`no`/`off` → 只备份数据库，媒体零备份 → **恢复后画布里所有图 404**。另外不能写 `maybe` 这类无法判定的值，否则 server 启动崩溃 |
| `RCLONE_REMOTE` + `RCLONE_DEST` | 🟧 | 远端名与目标路径，如 `mycos` / `ic-backup/2026` | 留空 = **只有 VPS 本地一份备份**。VPS 一毁全没。这是本项目最该补的一项 |
| `BACKUP_ON_START` | 🟧 | —— | 🔴 **这个变量现在写了也没用**：只有 `entrypoint.sh:33` 读它，但 compose 和 `.env.example` 都没声明它 → 永远取默认 `false` → **首份备份要等到第二天凌晨 3 点**。首次上线请按 6.2 手动跑一次 |
| `DATABASE_PATH` | 🟩 | **保持 `/data/app.db`** | 改了就必须同步改 backup 服务的 `DATABASE_PATH`，否则备份打的是空库 |
| `STORAGE_LOCAL_ROOT` | 🟩 | **保持 `/data/media`** | 改了必须同步改 backup 服务的 `STORAGE_LOCAL_ROOT`，否则 `backup.sh` 找不到目录 → 记 failed 并退出 |
| `COOKIE_SECURE` | 🟩 | `true` | 全站 HTTPS，必须为 true；设 false 会让会话 Cookie 走明文 |
| `TRUST_PROXY` | 🟩 | `true` | 设 false → 登录限流把所有请求算成同一个 IP，"5 次/分"变成全站共用，会被误锁 |
| `ALLOW_REGISTRATION` | 🟩 | `false` | 设 true = 任何人都能注册账号（当前代码还有跨用户去重缺陷，见 `docs/KNOWN-ISSUES.md` 第 1 条） |
| `TZ` | 🟩 | `Asia/Shanghai` | 决定 cron 的触发时刻。`BACKUP_CRON=0 3 * * *` + 这个时区 = 北京时间每天凌晨 3 点 |
| `MAX_UPLOAD_MB` | 🟩 | `200` | 与 Caddy 的 `request_body max_size` 同一个变量，改一处两边一起改 |
| `APP_VERSION` / `LOG_LEVEL` | 🟩 | 默认 | 仅展示/日志用 |
| `API_BASE_URL` | 🟩 | **留空** | 留空 = 同域（推荐）；拆子域才填 |

### 3.3 `RESULT_DOWNLOAD_ALLOWLIST` 到底怎么取值（这项最容易卡住）

生图/生视频服务返回的通常是一个 **URL**，这个 URL 的域名来自上游响应，不在我们控制范围内，所以服务端必须自己判断"能不能去抓"。

**取值步骤**（上线后做，不用卡在部署这一步）：

1. 先在站点里配好你的渠道（API 域名 + Key）。
2. 跑一次生图。
3. 看服务端日志里被拒绝的域名：

```bash
$ docker compose logs --tail 200 server | grep -i '不允许的结果下载地址'
# 典型输出：上游返回了不允许的结果下载地址：host not in allowlist（xxx-cdn.example.com）
```

4. 把日志里的域名填进 `.env`：

```bash
RESULT_DOWNLOAD_ALLOWLIST=xxx-cdn.example.com,oss-cn-beijing.aliyuncs.com
```

5. 重启 server 生效：`docker compose up -d server`

> 同一个中转站可能换 CDN 域名，隔一段时间要复查一次。判断标准很简单：**能正常出图就是配对了**。

---

## 4. 首次启动顺序与数据卷持久化路径

### 4.1 启动

```bash
$ cd /srv/ic/deploy
$ docker compose up -d --build
# 首次会构建两个镜像（web 前端编译较慢，5~15 分钟，耐心等）
```

### 4.2 启动顺序（系统自己保证，你只需要知道为什么）

```
1) server   —— 校验环境变量 → 建/连 SQLite → 跑迁移 → 启动内嵌 Worker → 监听 8787
              ↓ 健康检查 /api/health 通过（DB 可用才算 healthy）
2) caddy    —— depends_on: server(healthy) + web(started) → 开始监听 80/443
3) backup   —— depends_on: server(healthy) → 安装 cron 表 → crond 前台运行
```

**为什么必须这样**：Caddy 等 server 健康了才起来，否则用户会先看到 502；backup 等 server 健康了才起来，否则它会对着一个还没建好的空库做备份。

### 4.3 数据卷：数据到底存在哪

```bash
$ docker volume inspect infinite-canvas_data -f '{{ .Mountpoint }}'
# 预期：/var/lib/docker/volumes/infinite-canvas_data/_data
```

卷内布局：

```
/data
├── app.db            ← 主数据库（WAL 模式，旁边还会有 app.db-wal / app.db-shm）
│                       里面装着：账号、会话、渠道密钥、画布 JSON、资产元数据、任务、备份审计行
├── media/            ← 媒体本体（内容寻址）
│   └── 2026/10/9f2c…c1.png
└── backups/          ← 备份产物
    ├── app-20261026T190000Z.sqlite.gz
    └── media-20261026T190000Z.tar.gz
```

验收：

```bash
# 1) 四个容器都在跑
$ docker compose ps
# 预期：ic-caddy / ic-server / ic-web / ic-backup 四行，状态都是 Up
#      且 ic-server 一行的 STATUS 里带 (healthy)
# 不达标说明什么：
#   - ic-server 是 (unhealthy) 或一直 restarting → 立刻看 docker compose logs server
#   - 任何一行是 Exit 1 → 把最后 50 行日志发出来，多半是 .env 没填对

# 2) 卷里真的有东西了
$ sudo ls -l /var/lib/docker/volumes/infinite-canvas_data/_data
# 预期：至少能看到 app.db
# 不达标说明什么：看不到 app.db = server 根本没起来或环境变量指向了别处

# 3) 健康接口
$ curl -k https://127.0.0.1/api/health
# 预期（关键字段）：{"ok":true,"data":{"db":"ok","worker":"running","env":"production", …}}
# 不达标说明什么：
#   - db 不是 "ok" → 数据库不可用，server 会返回 503，compose 健康判定也会失败
#   - worker 是 "disabled" → WORKER_ENABLED 被设成了假值，生图任务不会跑
```

### 4.4 首次部署后立刻要做的两件补救（重要）

这两件是因为附录 A 里的 **F4 / F5** 尚未修复，不做会有后果：

```bash
# (1) 建出 /data/media 目录（否则今晚 3 点的备份会因为"媒体目录不存在"直接判失败）
$ docker exec ic-server mkdir -p /data/media
$ docker exec ic-server ls -ld /data/media
# 预期：drwxr-xr-x … bun  bun  /data/media   （属主是 bun，不是 root）

# (2) 修正备份目录属主，否则设置页的"立即备份"按钮会失败
$ docker exec ic-server id
# 预期：uid=1000(bun) gid=1000(bun)   ← 记下这个 uid:gid
$ docker exec ic-backup sh -c 'mkdir -p /data/backups && chown -R 1000:1000 /data/backups'
$ docker exec ic-backup ls -ld /data/backups
# 预期：drwxr-xr-x … 1000  1000  /data/backups
```

### 4.5 建第一个账号

浏览器打开 `https://<你的域名>`（第一次用自签/未就绪的证书会报警告，点"继续访问"即可）。

系统检测到 `users` 表为空，会显示初始化页面 —— 用你 1.5 表里准备好的邮箱/密码建号，**这个账号就是 owner**。

验收：

```bash
$ curl -k https://127.0.0.1/api/setup/status
# 建号前预期：{"ok":true,"data":{"initialized":false,"registrationEnabled":false}}
# 建号后预期：{"ok":true,"data":{"initialized":true,"registrationEnabled":false}}
# 不达标说明什么：一直是 false 但你明明建过号 → 说明连的不是这个库（DATABASE_PATH 不一致/卷没挂上）
```

> 建号后 `/api/setup` 会永久返回 409，公开注册默认关闭 —— 这是设计如此。要加人只能后续开放。

---

## 5. Caddy 反代与 TLS 自动签发

### 5.1 它做了什么

```
外部请求
  ├─ /api/*  → 反代到 server:8787（同源，所以没有跨域问题；SSE 流式不缓冲）
  └─ 其它    → 反代到 web:3000（nginx 静态 SPA，负责 SPA 路由回退）
```

对外只暴露 80/443；`server` 的 8787 与 `web` 的 3000 是**容器网络内部端口**，不对外发布（已核对：nginx 监听 3000、`server` 监听 8787、Caddyfile 转发到 `server:8787` 与 `web:3000`，三处一致）。

### 5.2 从自签切到 Let's Encrypt

`.env` 里把 `TLS_MODE` 改成你的邮箱（**前提是第 1.4 节的 DNS 已经生效、80 端口已放行**）：

```bash
TLS_MODE=dige@example.com
```

然后重建 Caddy（**只重建 caddy，不要全量 up**）：

```bash
$ cd /srv/ic/deploy
$ docker compose up -d --force-recreate caddy
$ docker compose logs -f caddy
```

验收：

```bash
# 1) 证书签发成功
$ docker compose logs caddy 2>&1 | grep -iE 'certificate|acme|error' | tail -n 20
# 预期：看到 "certificate obtained successfully" 或 "certificate is already up to date"
# 不达标说明什么：
#   - 反复出现 "failed to obtain certificate" / "challenge failed" → 80 端口没放行，或 DNS 没生效
#   - 出现 rate limited → 你短时间内重试太多次被 Let's Encrypt 限流了，等 1 小时再试

# 2) 用域名访问，证书是被信任的
$ curl -sS -o /dev/null -w '%{http_code}\n' https://<你的域名>/api/health
# 预期：200（不带 -k 也必须是 200，说明证书链可信）
# 不达标说明什么：返回 000 或报证书错误 → 证书没签下来，回上面一步看日志

# 3) 看证书颁发者
$ echo | openssl s_client -connect <你的域名>:443 -servername <你的域名> 2>/dev/null | openssl x509 -noout -issuer -dates
# 预期：issuer 里出现 Let's Encrypt / R3 / E5 之类，notAfter 是约 90 天后
```

### 5.3 证书续期与存放

- 证书存在命名卷 `caddy_data` 里，**重启容器不会丢**。
- Caddy 自动续期（到期前约 30 天内），**不需要你做任何事**。
- 只要邮箱填对了，快过期时 Let's Encrypt 会给你发邮件（这是 `TLS_MODE` 填邮箱的第二个用途）。

### 5.4 已知的 Caddyfile 注意点

- **第 46 行下发了 HSTS（`max-age=1y`）**。如果你一开始用 `localhost` + 自签证书调试，建议先把第 46 行注释掉，否则浏览器会长期强制 `https://localhost`，之后想用 http 访问 localhost 会很麻烦。
- **第 97 行的 CSP 仍带 `'unsafe-inline'`**（脚本与样式），这是已知待办（T05 做 hash 化）。详见第 9 节。

---

## 6. 备份与恢复（重点）

> 这一节是本项目的生命线。**能恢复的备份才算备份。**

### 6.1 备份什么、落在哪、保留多久

| 内容 | 本地落盘位置 | 谁产生 | 频率 | 保留策略 |
| --- | --- | --- | --- | --- |
| 数据库快照 | `/data/backups/app-<UTC时间戳>.sqlite.gz` | `backup.sh`（`sqlite3 .backup` 在线快照 → gzip） | 每天 03:00（北京时间） | **14 天**（`BACKUP_DB_KEEP_DAYS`），由 `backup.sh:230` 的 `find -mtime +14 -delete` 清理 |
| 媒体打包 | `/data/backups/media-<UTC时间戳>.tar.gz` | `backup.sh`（`tar -czf` 整个 `/data/media`） | 同上 | 同上 14 天 |
| 远端副本 | `RCLONE_REMOTE:RCLONE_DEST`（对象存储/网盘） | `backup.sh` 的 `rclone copy` | 同上 | ⚠️ **远端从不删除**，会一直增长。请自己在对象存储侧配生命周期规则（见 6.5） |
| 审计行 | 数据库 `backups` 表 | 备份脚本 + 手动触发 | 每次备份 | 手动备份路径会按 `finished_at` 清理；**cron 路径不清理审计行**（表会缓慢增长，风险低） |

**落盘位置到宿主机的映射**：

```bash
$ docker exec ic-backup sh -c 'ls -lh /data/backups'
# 等价于宿主机：
$ sudo ls -lh /var/lib/docker/volumes/infinite-canvas_data/_data/backups
```

**两件必须知道的事**：

1. **本地备份和生产数据在同一个卷、同一块盘上。** 磁盘坏了，本体和备份一起没。所以本地备份只防"误删/误改/软件故障"，**不防硬件与机房故障** —— 异地副本（rclone）必须配。
2. **数据库快照和媒体包不是同一时刻的原子快照。** 脚本先做数据库快照、后 `tar` 媒体，中间相差几十秒到几分钟。极端情况下（正好在这个窗口里上传了图）可能出现"数据库里有记录、媒体包里没有这个文件"。影响有限（最多丢一个刚上传的文件），但演练时要知道这是设计如此，不是备份坏了。

### 6.2 怎么确认备份真的在跑（六道检查，逐条做）

**检查 1：cron 装上了没有**

```bash
$ docker exec ic-backup cat /etc/crontabs/root
# 预期：0 3 * * * /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1
# 不达标说明什么：文件不存在 = 容器没起来或 entrypoint 没跑完；
#                 表达式不是你填的 = BACKUP_CRON 改了之后没重建容器
```

**检查 2：容器活着**

```bash
$ docker ps --filter name=ic-backup --format '{{.Names}}\t{{.Status}}'
# 预期：ic-backup   Up xx minutes
# 不达标说明什么：Exited → 看 docker logs ic-backup；
#                 一直 Restarting → 多半是 entrypoint 里 mkdir /etc/crontabs 失败
```

**检查 3：文件在长**

```bash
$ docker exec ic-backup sh -c 'ls -lht /data/backups | head -n 10'
# 预期：最上面是最近的 app-*.sqlite.gz 与 media-*.tar.gz，大小明显大于 0
# 不达标说明什么：
#   - 一个文件都没有 → 备份从没跑成功过，直接看检查 5 的日志
#   - 只有 app-* 没有 media-* → BACKUP_INCLUDE_MEDIA 被关了（媒体零备份！）
```

**检查 4（最权威）：看审计行**

```bash
$ docker exec ic-backup sqlite3 -header -column /data/app.db \
    "SELECT id, trigger, status, db_bytes, media_files, media_expected, error_message, started_at FROM backups ORDER BY started_at DESC LIMIT 5;"
```

预期：

| 字段 | 应该是什么 | 不对说明什么 |
| --- | --- | --- |
| `status` | `success` | `failed` → 看 `error_message` 列；`running` 卡住 → 上次备份被打断 |
| `media_expected` | `1` | `0` = 有意只备份数据库（媒体零备份），等于画布里的图没备份 |
| `media_files` | **大于 0**（前提是你已经上传过图/生成过图） | 为 0 且 `media_expected=1` → 媒体目录是空的或卷没挂上 |
| `db_bytes` | 大于 0 | 为 0 → 快照是空的 |
| `error_message` | 空 | 有内容 → 直接照着错误信息排障 |

再查一次"最近 7 天有没有失败"：

```bash
$ docker exec ic-backup sqlite3 -header -column /data/app.db \
    "SELECT status, COUNT(*) AS c FROM backups WHERE started_at > datetime('now','-7 days') GROUP BY status;"
# 预期：只出现 success（可以有 running 吗？不可以，正常跑完不会留 running）
# 不达标说明什么：出现 failed → 下面这条把失败原因列出来
$ docker exec ic-backup sqlite3 -header -column /data/app.db \
    "SELECT started_at, error_message FROM backups WHERE status='failed' ORDER BY started_at DESC LIMIT 5;"
```

**检查 5：看日志**

```bash
$ docker logs --tail 100 ic-backup
# 预期能看到一次完整流程：
#   [backup 已安装计划任务：0 3 * * *（时区 Asia/Shanghai）]
#   [backup …] sqlite3 .backup 第 1/3 次尝试 → /data/backups/.snapshot-….sqlite
#   [backup …] 已生成 /data/backups/app-….sqlite.gz（压缩后 xxx bytes）
#   [backup …] 打包媒体目录 /data/media → /data/backups/media-….tar.gz
#   [backup …] 媒体打包完成：N 个文件，xxx bytes
#   [backup …] 备份成功
# 不达标说明什么：看到 ERROR 行就照着排；看到"媒体目录不存在"→ 做 4.4 第 (1) 步
```

**检查 6：文件是完整的（不是半截）**

```bash
$ docker exec ic-backup sh -c 'for f in /data/backups/app-*.sqlite.gz; do gzip -t "$f" && echo "OK  $f"; done | tail -n 3'
# 预期：OK  /data/backups/app-….sqlite.gz
# 不达标说明什么：gzip: …invalid compressed data → 这份文件坏了，换前一天的那份

$ docker exec ic-backup sh -c 'f=$(ls -t /data/backups/media-*.tar.gz | head -n1); tar -tzf "$f" | head -n 3; echo "---- 文件总数 ----"; tar -tzf "$f" | wc -l'
# 预期：列出 media/2026/… 这样的路径，总数 > 0
```

### 6.3 现在就手动跑一次（别等凌晨 3 点）

因为 `BACKUP_ON_START` 目前没接进去（附录 A F5），**首份备份要等到次日 03:00**。上线当天请手动跑一次：

```bash
$ docker exec ic-backup /usr/local/bin/backup.sh
# 预期：最后一行是 [backup …] 备份成功
# 失败会直接打印 ERROR，并且 exit 1

$ echo "退出码=$?"
# 预期：退出码=0
```

> 说明：cron 那一行是 `… >> /proc/1/fd/1 2>&1`（**重定向，不是管道**），所以退出码不会被管道吞掉；但 crond **不会因为备份失败就让容器退出**，所以失败的可见性完全依赖上面"检查 4 的审计行"和"检查 5 的日志"。**这两条请每周看一次。**

设置页的「立即备份」按钮（`POST /api/backups/run`）也能触发，但它走的是服务端进程（`VACUUM INTO`），**只打包数据库、不打包媒体**，并且需要 4.4 第 (2) 步已经修好目录属主，否则会报 `BACKUP_FAILED`。日常请以 cron 的那份为准。

### 6.4 配置异地备份（rclone）—— 强烈建议

**为什么必须做**：本地备份和数据库在同一块盘上。VPS 被误删、被黑、机房故障，两者一起没。

```bash
# 1) 建配置目录（已在 .gitignore 里，不会被提交）
$ mkdir -p /srv/ic/deploy/rclone

# 2) 用交互向导生成远端（会在容器里问你一堆问题，按对象存储提供的参数填）
$ docker run --rm -it \
    -v /srv/ic/deploy/rclone:/config/rclone \
    alpine:3.20 sh -c 'apk add --no-cache rclone >/dev/null && rclone config'
# 按向导：n（新建）→ 起个名字（比如 mycos）→ 选存储类型（S3/COS/OSS…）→ 填 key/secret/region/endpoint
# 完成后退出

$ sudo ls -l /srv/ic/deploy/rclone/
# 预期：rclone.conf 存在
```

**⚠️ 关键坑（附录 A F1）**：容器里的 rclone 是 alpine 版，**默认去找 `/root/.config/rclone/rclone.conf`，而不是 compose 挂载的 `/config/rclone/rclone.conf`**。所以现在这样配完，**cron 里的 `rclone copy` 会报找不到 remote**。先验证：

```bash
$ docker compose up -d --force-recreate backup
$ docker exec ic-backup rclone config file
# 如果输出是 /root/.config/rclone/rclone.conf → 中招了，按下面二选一处理
```

处理办法（**二选一，推荐第一种**）：

```bash
# 办法 A（不动任何文件，但容器重建后要重做）：软链过去
$ docker exec ic-backup sh -c 'mkdir -p /root/.config/rclone && ln -sf /config/rclone/rclone.conf /root/.config/rclone/rclone.conf'
$ docker exec ic-backup rclone listremotes
# 预期：输出你配的远端名，例如 mycos:

# 办法 B（推荐，一劳永逸）：给 compose 加一行环境变量
#   在 deploy/docker-compose.yml 的 backup.environment 里加：
#       RCLONE_CONFIG: /config/rclone/rclone.conf
#   然后 docker compose up -d --force-recreate backup
```

在 `.env` 里填远端：

```bash
RCLONE_REMOTE=mycos
RCLONE_DEST=ic-backup/canvas      # 远端上的目录路径
BACKUP_TARGET_LABEL=对象存储-上海  # 只是展示用，别写真密钥
```

验收（**这一步必须看到文件真的出现在远端**）：

```bash
$ docker exec ic-backup /usr/local/bin/backup.sh     # 手动跑一次
$ docker exec ic-backup rclone ls "mycos:ic-backup/canvas" | tail -n 5
# 预期：能看到 app-….sqlite.gz 与 media-….tar.gz
# 不达标说明什么：
#   - "didn't find section in config file" → 就是上面那个坑，配置没被读到
#   - 上传失败 → backup.sh 会写 failed 审计行并 exit 1，但**本地备份文件仍然在**
```

### 6.5 远端保留策略（当前没有，自己补）

`backup.sh` 只做 `rclone copy`，**从不删除远端文件**，所以远端会一直增长。请到你的对象存储控制台配置 **生命周期规则**（例如：超过 60 天的对象自动删除 / 转低频存储）。

### 6.6 一次完整的恢复演练（上线第一周内必须做一次）

> 原则：**演练不要拿唯一的生产库开刀**。推荐方案 A（另起炉灶），实在只有一台机器再用方案 B（原地，但先做全量快照）。

#### 方案 A：在另一台机器上恢复（推荐，生产零风险）

准备：一台临时 VPS（按小时计费，1 小时就够），或者你本地装了 Docker 的机器。

```bash
# ——— 在第 1 台（生产）机器上：导出备份文件 ———
$ mkdir -p /srv/ic/export
$ docker cp ic-backup:/data/backups/app-<选一个时间戳>.sqlite.gz /srv/ic/export/
$ docker cp ic-backup:/data/backups/media-<同一时间戳>.tar.gz    /srv/ic/export/
$ ls -lh /srv/ic/export
# 记下这两个文件名，两个必须是**同一次**备份（时间戳相同）
# 把它们 scp 到演练机：
$ scp /srv/ic/export/* ic@<演练机IP>:/tmp/restore-in/
```

```bash
# ——— 在演练机上（全新，只装了 docker）———
$ mkdir -p /tmp/restore-in /srv/ic && cd /srv/ic
$ git clone <你的仓库地址> .
$ cd /srv/ic/deploy
$ cp .env.example .env
$ openssl rand -base64 48          # 填进 AUTH_SECRET
# APP_DOMAIN 先保持 localhost，TLS_MODE 保持 internal（演练不需要真证书）

$ docker compose up -d --build
$ docker compose ps                # 四个都 Up，ic-server 是 healthy

# —— 开始恢复 ——
$ docker compose down              # 只停容器，不删卷

$ docker run --rm \
    -v infinite-canvas_data:/data \
    -v /tmp/restore-in:/bak \
    alpine:3.20 sh -c '
      set -e
      cd /data
      rm -f app.db app.db-wal app.db-shm
      gunzip -c /bak/app-<时间戳>.sqlite.gz > app.db
      rm -rf media
      tar -xzf /bak/media-<时间戳>.tar.gz -C /data
      chown -R 1000:1000 /data/app.db /data/media          # ← 这行不能少，见下方说明
      ls -l /data && echo "恢复完成"
    '
# 预期：最后打印 恢复完成，且 /data 下有 app.db 与 media/

$ docker compose up -d
$ docker inspect -f '{{.State.Health.Status}}' ic-server
# 预期：healthy
```

> **为什么必须 `chown -R 1000:1000`**：恢复是用 root 身份写的，而 server 容器里跑进程的用户是 `bun`（uid 1000）。不改属主，server 会打不开数据库（"unable to open database file"），表现为**能打开页面但保存全部失败**。这是恢复环节最容易踩的坑。

#### 方案 B：本机原地演练（先做全量快照兜底）

```bash
$ cd /srv/ic/deploy

# 0) 演练前的全量快照（出任何意外都能退回来）
$ docker compose stop server web caddy
$ sudo mkdir -p /srv/ic/drill-snapshots
$ docker run --rm -v infinite-canvas_data:/data -v /srv/ic/drill-snapshots:/out alpine:3.20 \
    sh -c 'cd /data && tar -czf /out/pre-drill-$(date -u +%Y%m%dT%H%M%SZ).tar.gz .'
$ ls -lh /srv/ic/drill-snapshots
# 预期：生成一个几百 MB 的 tar.gz。没有这个文件就不要往下做

$ docker compose start server web caddy

# 1) 挑一份备份（要成对）
$ docker exec ic-backup sh -c 'ls -lht /data/backups | head -n 6'
$ sudo mkdir -p /srv/ic/restore-in
$ docker cp ic-backup:/data/backups/app-<时间戳>.sqlite.gz /srv/ic/restore-in/
$ docker cp ic-backup:/data/backups/media-<时间戳>.tar.gz  /srv/ic/restore-in/

# 2) 停服务（绝不能让 server 继续往库里写）
$ docker compose down

# 3) 恢复
$ docker run --rm \
    -v infinite-canvas_data:/data \
    -v /srv/ic/restore-in:/bak \
    alpine:3.20 sh -c '
      set -e
      cd /data
      rm -f app.db app.db-wal app.db-shm
      gunzip -c /bak/app-<时间戳>.sqlite.gz > app.db
      rm -rf media && tar -xzf /bak/media-<时间戳>.tar.gz -C /data
      chown -R 1000:1000 /data/app.db /data/media
      echo "恢复完成"
    '

# 4) 起来并验收（见下方"演练判定"）
$ docker compose up -d
$ docker inspect -f '{{.State.Health.Status}}' ic-server
# 预期：healthy

# 5) 演练收尾：
#    - 如果一切正常，这份就是你的真实数据，直接继续用（删掉 pre-drill 快照可以，建议先留 7 天）
#    - 如果发现问题，用 pre-drill 快照按同样流程恢复回去，然后再排查
```

#### 演练判定（**做不到就是备份不可用**）

在浏览器里登录演练环境，逐条打勾：

| # | 检查 | 预期 | 不达标说明什么 |
| --- | --- | --- | --- |
| 1 | 能用原来的账号密码登录 | 登录成功 | 数据库没恢复成功 / 选错了备份文件 |
| 2 | 演练前建的画布还在 | 列表里能看到 | 同上，或恢复的是更早的备份 |
| 3 | 打开画布，**图片能显示**（不是裂图） | 图片正常加载 | 媒体没恢复，或 `media_expected` 当时就是 0（媒体零备份） |
| 4 | 新建一张画布 + 上传一张图 → 保存 → 刷新 | 都还在 | 属主没改（chown 那一步漏了）导致写入失败 |
| 5 | `/api/health` 的 `db` 是 `ok` | `ok` | 数据库损坏或不可写 |
| 6 | 跑一次生图（若已配渠道） | 出图 | `RESULT_DOWNLOAD_ALLOWLIST` 没配对 |

**把结果记下来**（建议直接写进 `docs/` 下或在记事本里留存）：

```
演练日期：____  演练方式：A / B
使用的备份文件：app-____.sqlite.gz + media-____.tar.gz
1 登录：✅/❌   2 画布：✅/❌   3 图片：✅/❌   4 写入：✅/❌   5 health：✅/❌   6 生图：✅/❌
耗时：____ 分钟   遇到的问题：____
```

> 之后**每季度演练一次**，并在每次大版本升级前演练一次。

### 6.7 真出事时的恢复流程（VPS 彻底没了）

1. 买一台新 VPS，从第 2 节开始重新装 docker、拉代码、写 `.env`（**`AUTH_SECRET` 必须和原来完全一致**，否则渠道密钥解不开）。
2. 从异地备份（对象存储）把最近一对 `app-*.sqlite.gz` + `media-*.tar.gz` 下载下来。
3. `docker compose up -d --build` 一次（让它把卷和目录建出来），然后 `docker compose down`。
4. 按 6.6 方案 A 的第 3 步恢复 + chown。
5. `docker compose up -d`，按 6.6 的"演练判定"逐条验收。
6. 域名 A 记录改指向新 IP。

---

## 7. 升级与回滚

### 7.1 升级前必做（缺一不可）

```bash
$ cd /srv/ic
$ git rev-parse --short HEAD > /tmp/old-commit.txt && cat /tmp/old-commit.txt
# 记下当前 commit，回滚要用

$ docker exec ic-backup /usr/local/bin/backup.sh && echo "备份成功，可以升级"
# 必须看到"备份成功"

# 把备份文件复制一份到宿主机（别只留在卷里）
$ sudo mkdir -p /srv/ic/pre-upgrade && F=$(docker exec ic-backup sh -c 'ls -t /data/backups/app-*.sqlite.gz | head -n1') \
  && docker cp ic-backup:$F /srv/ic/pre-upgrade/
$ docker cp ic-backup:$(docker exec ic-backup sh -c 'ls -t /data/backups/media-*.tar.gz | head -n1') /srv/ic/pre-upgrade/
$ sudo ls -lh /srv/ic/pre-upgrade
```

### 7.2 升级

```bash
$ cd /srv/ic
$ git fetch --all
$ git checkout <目标 tag 或 commit>      # 不要用 git pull 直接拉最新，钉死版本更可控
$ cd deploy
$ docker compose up -d --build

$ docker compose logs -f server
# 关键：看迁移日志
#   预期之一：[boot] 迁移已是最新（共 N 个，无新增）
#   预期之二：[boot] 本次执行迁移：0002_job_fencing.sql
# 不达标说明什么：
#   - "环境变量校验失败" → 新版 .env.example 新增了必填项，对比补进你的 .env
#   - "迁移…执行失败" / "checksum 不匹配" → 立刻回滚，数据库可能处于中间状态
```

验收：`docker inspect -f '{{.State.Health.Status}}' ic-server` 必须是 `healthy`，再按第 8 节过一遍清单。

### 7.3 回滚（**数据库不能自动回滚**，这是重点）

```bash
$ cd /srv/ic
$ git checkout $(cat /tmp/old-commit.txt)
$ cd deploy && docker compose up -d --build
```

**三种情况，处理方式不同**：

| 情况 | 后果 | 怎么办 |
| --- | --- | --- |
| 新版本**没带**新迁移 | 回滚代码即可，数据库不受影响 | 直接 `git checkout` + `up -d --build` |
| 新版本**带了**新迁移（如 `0002`） | 回滚代码后启动会**直接失败**：迁移执行器发现"数据库里有、磁盘上没有"的迁移版本，拒绝启动（这是有意的安全设计） | 必须**先恢复升级前的数据库备份**，再启动旧版本代码 |
| 数据库出问题但代码没问题 | —— | 停服务 → 用 6.6 的流程恢复备份 → 启动验收 |

**所以：升级前那一步"复制备份到宿主机"不是形式主义，它是你唯一的后悔药。**

### 7.4 版本钉死建议

- 生产环境**不要用 `git pull` 拉 main**。固定到某个 commit 或打 tag。
- 每次升级记一条：`日期 / 从哪个 commit 到哪个 commit / 有没有新迁移 / 验收结果`。

---

## 8. 上线后健康检查清单

> 建议：上线当天全做一遍；之后**每周做第 1、4、5、6 条**（5 分钟），每月全做一遍。

| # | 检查 | 命令 | 预期结果 | 不达标说明什么 |
| --- | --- | --- | --- | --- |
| 1 | 容器都活着 | `cd /srv/ic/deploy && docker compose ps` | 4 个 Up；`ic-server` 带 `(healthy)` | 有 Exit/Restarting → `docker compose logs <服务名>` 看最后 50 行 |
| 2 | 健康接口 | `curl -sS https://<域名>/api/health` | `{"ok":true,...}` 且 `data.db == "ok"`、`data.worker == "running"` | `db` 非 ok → 数据库不可用（503）；`worker` 是 disabled → 任务不会跑 |
| 3 | 证书 | `curl -sS -o /dev/null -w '%{http_code}\n' https://<域名>/api/health` | `200`（**不加 `-k`**） | 非 200 → 证书没签下来/过期，看 `docker compose logs caddy` |
| 4 | 备份在跑 | `docker exec ic-backup sqlite3 -header -column /data/app.db "SELECT status, COUNT(*) c FROM backups WHERE started_at > datetime('now','-7 days') GROUP BY status;"` | 只有 `success`，**没有 `failed`** | 有 failed → 查 `error_message`；一条都没有 → cron 没跑，看 `docker exec ic-backup cat /etc/crontabs/root` |
| 5 | 备份文件在长 | `docker exec ic-backup sh -c 'ls -lht /data/backups \| head -n 6'` | 有当天的 `app-*.sqlite.gz` **和** `media-*.tar.gz`，大小 > 0 | 缺 media → `BACKUP_INCLUDE_MEDIA` 被关了（媒体零备份，恢复后全是裂图） |
| 6 | 媒体真的被打包了 | 同上查询里的 `media_files > 0` 且 `media_expected = 1` | `media_files` 大于 0 | `media_files=0` 但 `media_expected=1` → 媒体目录是空的或卷没挂上 |
| 7 | 异地副本存在 | `docker exec ic-backup rclone ls "<RCLONE_REMOTE>:<RCLONE_DEST>" \| tail -n 5` | 能看到最新的两个文件 | 报 "didn't find section" → 附录 A F1（rclone 配置路径） |
| 8 | 磁盘余量 | `df -h /var/lib/docker` | 使用率 **< 70%** | > 85% → 备份 tar 会失败、数据库会写不进去，立刻扩容或清媒体 |
| 9 | 数据库文件属主 | `docker exec ic-server sh -c 'ls -l /data/app.db*'` | `app.db(-wal/-shm)` 属主都是 `bun`，**不是 root** | 出现 root 属主 → 备份容器以 root 写库留下的副作用（KNOWN-ISSUES 第 6 条），立刻 `docker exec ic-backup sh -c 'chown 1000:1000 /data/app.db*'`，否则服务端会写不进去 |
| 10 | 登录与保存 | 浏览器：登录 → 新建画布 → 上传一张图 → 刷新页面 | 都还在，图片能显示 | 保存失败 → 第 9 条的属主问题；图片裂 → 媒体没恢复/没备份 |
| 11 | 生图链路 | 配好渠道后跑一次生图 | 画布上**真的出现图** | 任务成功但没图 → `RESULT_DOWNLOAD_ALLOWLIST` 没配（看服务端日志里的"不允许的结果下载地址"） |
| 12 | 安全响应头 | `curl -sSI https://<域名>/ \| grep -iE 'strict-transport\|content-security\|x-frame'` | 三条都在 | CSP 带 `'unsafe-inline'` 是**已知待办**（第 9 节），不是配置错误 |
| 13 | 端口没裸露 | `sudo ss -tlnp \| grep -E ':8787\|:3000'` | **在宿主机上应该没有输出**（只有 Caddy 的 80/443） | 有输出 → 有人改了 compose 把内部端口发布出来了，等于绕过 Caddy 的 TLS 与安全头 |

---

## 9. 已知风险与待办（上线后如何自查）

### 9.1 本次审查新发现（**未修，靠运维规避**）

详细内容与修法见[附录 A](#附录-a本次对-deploy-配置的审查发现问题清单)。这里只给"上线后怎么自查有没有踩坑"：

| 风险 | 自查方法 | 看到什么 = 踩坑了 |
| --- | --- | --- |
| 🔴 rclone 配置读不到（异地备份实际没生效） | `docker exec ic-backup rclone config file` | 输出不是 `/config/rclone/rclone.conf`，且审计行里出现 `rclone upload failed` |
| 🔴 `BACKUP_ENABLED` 写成 `1/yes/on` → 备份被静默关闭 | `grep '^BACKUP_ENABLED' /srv/ic/deploy/.env` + 第 8 节第 4 条 | 值不是 `true`，且 `backups` 表连续 7 天没有任何新行 |
| 🔴 设置页「立即备份」按钮失败 | 点一下看返回；或 `docker compose logs server \| grep -i backup` | 报 `BACKUP_FAILED`（第 4.4 节的 chown 没做） |
| 🟡 首份备份要等到次日 03:00 | 上线当天 `ls /data/backups` | 上线当天目录是空的（按 6.3 手动跑一次） |
| 🟡 备份容器僵死但 `docker ps` 显示 Up | 第 8 节第 4 条（审计行） | 连续两天没有新审计行，但容器显示 Up |
| 🟡 远端只增不删 | 去对象存储控制台看容量 | 容量单调上升 → 配生命周期规则 |

### 9.2 项目已知遗留（`docs/KNOWN-ISSUES.md` 里已有，此处只标注与运维相关的）

| 项 | 位置 | 对上线的影响 | 自查/规避 |
| --- | --- | --- | --- |
| CSP 仍是 `unsafe-inline`（未做 hash 化） | `deploy/Caddyfile:97` | 存储型 XSS 的纵深防御里少一层；资产本身另有 `default-src 'none'; sandbox` 兜底 | 不要往站点上挂任何第三方统计/脚本；若要开 `ANALYTICS_GA4_ID`，必须先把 `googletagmanager.com` / `hm.baidu.com` 加进 `script-src`。T05 做 hash 化 |
| `RESULT_DOWNLOAD_ALLOWLIST` 空白 = 功能全阻断 | `deploy/.env` / `server/src/env.ts:124` | 「AI 生成成功但画布上没图」。compose 已经注入了这个变量（第 129 行），**缺的是值** | 跑一次生图 → `docker compose logs server \| grep -i '不允许的结果下载地址'` → 把域名填进去 |
| 备份容器以 root 对生产库写审计行 | `deploy/backup/backup.sh` | 极端情况下 `-wal`/`-shm` 被 root 重建 → 服务端（bun）写不了库 | 第 8 节第 9 条每月查一次属主；发现 root 属主就 chown 回 1000 |
| HSTS 对 localhost 自签场景 | `deploy/Caddyfile:46` | 只在 localhost 自签调试时，浏览器会长期强制 https | 纯 localhost 调试时把第 46 行注释掉 |
| `server/` 没有 lockfile，镜像构建不可复现 | `server/Dockerfile` | 同一 commit 两次构建可能装到不同依赖版本 | 升级时留意 `docker compose logs server` 的启动日志；有条件时补 `bun.lock` |

---

## 附录 A：本次对 deploy 配置的审查发现（问题清单）

> 审查方式：**源码级审查**（逐个文件通读）。写文档的本机是 Windows，没有 bash / sqlite3 / gzip / rclone，
> **shell 脚本没有真跑过**。所以下面每条都附了"怎么改"和"怎么验证"，请以你在 VPS 上跑出来的结果为准。

### 结论先说

- ✅ **没有发现"卷挂载缺失导致数据不持久"**：`server`（第 131 行）与 `backup`（第 177 行）都挂了 `data:/data`，数据库与媒体都在持久化卷上。
- ✅ **没有发现端口前后不一致**：`web` 内 3000（nginx.conf:2 / compose:62）、`server` 内 8787（compose:79,133 / Caddyfile:56），三处一致。
- ✅ **cron 的退出码没有被管道吞掉**：`deploy/backup/crontab:7` 用的是 `>> /proc/1/fd/1 2>&1`（重定向，不是 `| tee` 之类），退出码保留。真正的问题是**失败了没人知道**（见 F6）。
- 🔴 **发现 3 个会让备份静默失效的真问题**（F1/F2/F3），其中 F1 关系到"VPS 毁了数据还在不在"。

| # | 位置 | 后果（一句话） | 怎么改 |
| --- | --- | --- | --- |
| **F1** 🔴 | `deploy/docker-compose.yml:179`（`- ./rclone:/config/rclone:ro`） | 容器里是 **alpine 版 rclone**，默认去读 `/root/.config/rclone/rclone.conf`，**不会**自动读挂载进来的 `/config/rclone/rclone.conf` → 一旦配了 `RCLONE_REMOTE`，`backup.sh` 的上传步骤失败 → 记 `failed` 审计行并 `exit 1`。此时数据**只有 VPS 本地一份**，等于异地备份完全没生效 | 在 `backup.environment` 里加一行 `RCLONE_CONFIG: /config/rclone/rclone.conf`（或 `XDG_CONFIG_HOME: /config`）。不改文件的临时办法：容器内 `ln -sf /config/rclone/rclone.conf /root/.config/rclone/rclone.conf`。验证：`docker exec ic-backup rclone config file` |
| **F2** 🔴 | `deploy/backup/entrypoint.sh:11`（`if [ "${BACKUP_ENABLED:-true}" != "true" ]`） | 提交 `997435f` 统一了 `env.ts` 与 `backup.sh` 的布尔口径（认 `true/1/yes/on`），但 **entrypoint 没跟着改**，仍只认精确的 `"true"` → 把 `BACKUP_ENABLED` 写成 `1`/`yes`/`on`/`True` 会被判为"关闭" → 容器进入空转、**一条备份都不做，且无任何报错**（第 33 行的 `BACKUP_ON_START` 同理） | entrypoint 里复用与 `backup.sh` 相同的 `is_truthy` 判定。**在此之前：`.env` 里的 `BACKUP_ENABLED` 必须写死 `true`** |
| **F3** 🔴 | `deploy/backup/entrypoint.sh:18`（`mkdir -p /etc/crontabs /data/backups`，以 root 执行） | `/data/backups` 被建成 **root:root 755**，而 server 容器里进程是 `bun`（uid 1000）→ 设置页的「立即备份」（`POST /api/backups/run`，要往 `/data/backups` 写文件）**必然失败**，返回 `BACKUP_FAILED`。cron 备份不受影响（它自己就是 root） | 启动后执行一次 `docker exec ic-backup sh -c 'chown -R 1000:1000 /data/backups'`（第 4.4 节第 2 步）。彻底修法：让备份容器以 uid 1000 运行并写审计行（但 busybox crond 需要 root，需连 `KNOWN-ISSUES` 第 6 条一起设计） |
| **F4** 🟡 | `deploy/backup/backup.sh:198`（媒体目录不存在即判失败） | 全新部署时 `/data/media` **不存在**（server 只在第一次落盘资产时才 `mkdir`，见 `storage/local-disk.ts:66`）→ 上线第一晚若还没传过任何图，备份会记 `failed` 并 `exit 1`。不是数据丢失，但会让人误以为"备份坏了" | 首次启动后执行一次 `docker exec ic-server mkdir -p /data/media`（以 bun 身份建，属主正确）。或在 `server` 启动时预建该目录 |
| **F5** 🟡 | `deploy/backup/entrypoint.sh:33` 读 `BACKUP_ON_START`，但 `docker-compose.yml` 与 `.env.example` **都没声明**它 | 该开关永远取默认 `false` → "容器启动即先备份一次"这段代码**永远不执行** → 首份备份要等到次日 03:00 | compose 的 `backup.environment` 加 `BACKUP_ON_START: ${BACKUP_ON_START:-true}`，`.env.example` 补一行。临时办法：按 6.3 手动跑一次 |
| **F6** 🟡 | `deploy/docker-compose.yml:152-184`（backup 服务无 healthcheck） | crond 挂了 / 容器僵死时，`docker compose ps` 仍然显示 `Up`，**没有任何告警** → 备份停了可能几周才发现 | 加一个 `healthcheck`（例如探测 `crond` 进程或"最近 24h 内有新审计行"）。在此之前：按第 8 节第 4 条每周查审计行 |
| **F7** 🟡 | `deploy/backup/backup.sh:245`（只有 `rclone copy`） | 远端**从不删除**旧备份 → 对象存储容量与成本单调增长 | 在对象存储侧配生命周期规则（如 60 天后删除/转低频） |
| **F8** 🟢 | `deploy/docker-compose.yml:50-64`（web 服务无 healthcheck） | nginx 挂了 Caddy 仍会转发 → 502，且 `depends_on` 只等 `service_started` | 给 web 加一个 `healthcheck`（`curl -f http://127.0.0.1:3000/`）；nginx:alpine 自带 wget，可用 `wget -qO-` |

### 修复优先级建议

1. **F1**（异地备份实际不生效）—— 数据生命线，最高。
2. **F2**（备份被静默关闭）—— 最阴险，因为它不报错。
3. **F3**（手动备份按钮失败）—— 影响你对"备份能用"的信心。
4. F5 / F4 —— 影响首日体验，有手动规避办法。
5. F6 / F7 / F8 —— 可观测性与成本，随版本迭代处理。

---

## 附录 B：一页纸速查（贴墙上）

```
日常（每周 5 分钟）
  cd /srv/ic/deploy
  docker compose ps                                   # 4 个 Up，server 带 healthy
  docker exec ic-backup sqlite3 -header -column /data/app.db \
    "SELECT status, COUNT(*) c FROM backups WHERE started_at > datetime('now','-7 days') GROUP BY status;"
                                                      # 只允许出现 success
  df -h /var/lib/docker                               # < 70%

出事了先看这三处
  docker compose logs --tail 100 server
  docker compose logs --tail 100 backup
  docker exec ic-backup sh -c 'ls -lht /data/backups | head'

三件永远不能做的事
  1. 不要 docker compose down -v        （-v 会删掉数据卷 = 删库）
  2. 不要改 AUTH_SECRET                 （改了所有人掉线 + 渠道密钥解不开）
  3. 不要在没备份的情况下升级            （数据库不能自动回滚）
```
