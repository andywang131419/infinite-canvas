#!/bin/sh
# =============================================================================
# backup 容器启动脚本
#
# 用 busybox crond 在容器内定时（不依赖宿主机 cron/systemd，ARCH §R9.3）。
# 计划表达式由 BACKUP_CRON 环境变量在启动时写入 /etc/crontabs/root，
# 因此改时间只需改 .env + 重启容器，不必重建镜像。
# =============================================================================
set -eu

if [ "${BACKUP_ENABLED:-true}" != "true" ]; then
    echo "[backup] BACKUP_ENABLED=false → 容器空转（不做任何备份）"
    while true; do sleep 3600; done
fi

CRON_EXPR="${BACKUP_CRON:-0 3 * * *}"

mkdir -p /etc/crontabs /data/backups

# busybox crond 读取 /etc/crontabs/<user>；以 root 身份运行（需要读 data 卷）。
printf '%s /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1\n' "$CRON_EXPR" > /etc/crontabs/root

echo "[backup] 已安装计划任务：${CRON_EXPR}（时区 ${TZ:-UTC}）"
echo "[backup] 数据库：${DATABASE_PATH:-/data/app.db}"
echo "[backup] 保留天数：${BACKUP_DB_KEEP_DAYS:-14}，重试：${BACKUP_RETRY:-3}"
if [ -n "${RCLONE_REMOTE:-}" ]; then
    echo "[backup] 远端：${RCLONE_REMOTE}:${RCLONE_DEST:-}"
else
    echo "[backup] 未配置 RCLONE_REMOTE → 仅本地备份到 /data/backups"
fi

# 首次部署立刻先跑一次，避免新机器等到凌晨 3 点才产生第一份备份。
if [ "${BACKUP_ON_START:-false}" = "true" ]; then
    echo "[backup] BACKUP_ON_START=true → 先执行一次"
    /usr/local/bin/backup.sh || echo "[backup] 首次备份失败，已忽略（后续由 cron 继续尝试）"
fi

# crond 前台运行，成为容器的 PID 1，日志直接进 docker logs
exec crond -f -l 2 -c /etc/crontabs
