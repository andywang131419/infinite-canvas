# 备份容器（ARCH §2.6 / §R9.3）
#
# 只装三样非 npm 依赖：sqlite3（在线快照）、rclone（统一远端）、busybox crond（容器内定时）。
# 全部来自 Alpine 包仓库，镜像约 40MB。
#
# 为什么以 root 运行：
#   /data 是 server 与 backup 共享的命名卷，属主是 server 镜像里的 bun(1000)。
#   备份需要读 app.db 并写 /data/backups，跨 uid 授权反而更脆弱；
#   该容器不监听端口、不接收入站流量，root 的风险面仅限卷内文件。

FROM alpine:3.20

ENV TZ=Asia/Shanghai \
    DATABASE_PATH=/data/app.db \
    BACKUP_DB_KEEP_DAYS=14 \
    BACKUP_RETRY=3 \
    BACKUP_CRON="0 3 * * *"

RUN apk add --no-cache \
        sqlite \
        rclone \
        tzdata \
        ca-certificates \
    && rm -rf /var/cache/apk/*

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY crontab /etc/crontabs/root

RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh \
    # rclone 配置目录：alpine 官方 rclone 默认读 $HOME/.config/rclone，
    # 本容器以 root 运行（HOME=/root），所以是 /root/.config/rclone。
    # **不是** /config/rclone —— 那是 LinuxServer 系镜像的约定，这里不适用。
    && mkdir -p /data/backups /root/.config/rclone \
    && sqlite3 --version \
    && rclone version | head -n 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
