#!/bin/sh
# =============================================================================
# backup 容器启动脚本
#
# 用 busybox crond 在容器内定时（不依赖宿主机 cron/systemd，ARCH §R9.3）。
# 计划表达式由 BACKUP_CRON 环境变量在启动时写入 /etc/crontabs/root，
# 因此改时间只需改 .env + 重启容器，不必重建镜像。
# =============================================================================
set -eu

# -----------------------------------------------------------------------------
# 布尔值判定
#
# 必须与 `backup.sh` 里的 `is_truthy` 和 `server/src/env.ts` 的 `boolFromEnv`
# 认同一套词表，否则会出现"用户按文档写了 1/yes，结果备份被静默关掉"。
#
# 这里是复制而不是 `source backup.sh`：backup.sh **没有 main guard**，
# 顶层就是主流程，source 它会当场触发一次备份。
# 所以两边靠注释互相指认 —— 改一处必须改另一处。
# 真 = true|1|yes|on，其余（含空串）一律为假。
# -----------------------------------------------------------------------------
is_truthy() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        true | 1 | yes | on) return 0 ;;
        *) return 1 ;;
    esac
}

if ! is_truthy "${BACKUP_ENABLED:-true}"; then
    echo "[backup] BACKUP_ENABLED 为假 → 容器空转（不做任何备份）"
    while true; do sleep 3600; done
fi

CRON_EXPR="${BACKUP_CRON:-0 3 * * *}"

# 与 backup.sh 的 STAGE_DIR、server 的 BACKUP_STAGE_DIR 同一个变量：
# 改了 .env 里的路径，这里 chown 的也必须是同一个目录，否则修了属主却修错了地方。
STAGE_DIR="${BACKUP_STAGE_DIR:-/data/backups}"

mkdir -p /etc/crontabs "$STAGE_DIR"

# -----------------------------------------------------------------------------
# 修正备份暂存目录（默认 /data/backups）的属主
#
# 本容器以 root 运行（Dockerfile 无 USER 指令），上面 mkdir 出来的目录是
# root:root 0755；而 server 容器以 `USER bun` 运行（uid 1000），
# 它**确实会往这个目录写东西**：
#   - server/src/services/backup-service.ts:136  mkdir(stageDir)
#   - server/src/services/backup-service.ts:125  写 .snapshot-<stamp>.sqlite
#   - server/src/services/backup-service.ts:142  写 app-<stamp>.sqlite.gz
#   - server/src/services/backup-service.ts:287  unlink 过期文件（清理）
# uid 1000 对 root:755 目录没有写权限 → 设置页「立即备份」必然 BACKUP_FAILED。
# 这是真实故障，不是隐患。
#
# 只 chown 这一个子目录，不动 /data 本身（那里还有 app.db，属主本来就对）。
# -----------------------------------------------------------------------------
BACKUP_DIR_UID="${BACKUP_DIR_UID:-1000}"
# 这两条**故意不让它致命**：卷只读 / 宿主 SELinux / 非 ext4 等场景下 chown 会失败，
# 若因为修属主而让 entrypoint 直接退出，容器就崩了、cron 根本装不上 ——
# 那是"为了修一个小问题把备份整体停掉"，比原问题严重得多。失败只告警。
chown "$BACKUP_DIR_UID:$BACKUP_DIR_UID" "$STAGE_DIR" ||
    echo "[backup] WARN chown $BACKUP_DIR_UID $STAGE_DIR 失败：server(uid 1000) 可能无法写入，设置页「立即备份」会报错" >&2
chmod 0755 "$STAGE_DIR" ||
    echo "[backup] WARN chmod 0755 $STAGE_DIR 失败" >&2

# busybox crond 读取 /etc/crontabs/<user>；以 root 身份运行（需要读 data 卷）。
printf '%s /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1\n' "$CRON_EXPR" > /etc/crontabs/root

echo "[backup] 已安装计划任务：${CRON_EXPR}（时区 ${TZ:-UTC}）"
echo "[backup] 数据库：${DATABASE_PATH:-/data/app.db}"
echo "[backup] 保留天数：${BACKUP_DB_KEEP_DAYS:-14}，重试：${BACKUP_RETRY:-3}"
if [ -n "${RCLONE_REMOTE:-}" ]; then
    echo "[backup] 远端：${RCLONE_REMOTE}:${RCLONE_DEST:-}"
else
    echo "[backup] 未配置 RCLONE_REMOTE → 仅本地备份到 $STAGE_DIR"
fi

# 首次部署立刻先跑一次，避免新机器等到凌晨 3 点才产生第一份备份。
# 默认改为 true：新机器首日没有备份是最危险的窗口。
if is_truthy "${BACKUP_ON_START:-true}"; then
    echo "[backup] BACKUP_ON_START=true → 先执行一次"
    /usr/local/bin/backup.sh || echo "[backup] 首次备份失败，已忽略（后续由 cron 继续尝试）"
fi

# crond 前台运行，成为容器的 PID 1，日志直接进 docker logs
exec crond -f -l 2 -c /etc/crontabs
