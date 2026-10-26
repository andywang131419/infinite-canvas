#!/bin/sh
# =============================================================================
# 备份脚本（ARCH §2.6 / §R9.3）
#
# 流程：sqlite3 .backup（在线安全快照） → gzip → 清理过期 → rclone 上传 → 记录审计行
#
# 为什么必须用 `.backup` 而不是 cp：
#   采用 WAL 模式时，直接 cp 主库文件会得到「撕裂」的快照（缺 -wal 里的最新事务）。
#   `sqlite3 .backup` 走 SQLite 的在线备份 API，可在服务运行中拿到一致性快照。
#
# 环境变量：
#   DATABASE_PATH            数据库路径（默认 /data/app.db）
#   BACKUP_DB_KEEP_DAYS      本地保留天数（默认 14）
#   BACKUP_RETRY             失败重试次数（默认 3）
#   RCLONE_REMOTE            远端名（留空 = 不上传）
#   RCLONE_DEST              远端目录
#   BACKUP_INCLUDE_MEDIA     true 时额外打包媒体目录（默认 true；关掉意味着媒体零备份）
#   STORAGE_LOCAL_ROOT       媒体根目录（默认 /data/media）
# =============================================================================
set -eu

DATABASE_PATH="${DATABASE_PATH:-/data/app.db}"
STORAGE_LOCAL_ROOT="${STORAGE_LOCAL_ROOT:-/data/media}"
STAGE_DIR="${BACKUP_STAGE_DIR:-/data/backups}"
KEEP_DAYS="${BACKUP_DB_KEEP_DAYS:-14}"
RETRY="${BACKUP_RETRY:-3}"
# 默认 true：媒体就是用户真正的数据，恢复时缺了它画布里全是 404（QA P1-3）。
INCLUDE_MEDIA="${BACKUP_INCLUDE_MEDIA:-true}"
# 与 INCLUDE_MEDIA 同源，但归一成 0/1 写进审计行的 media_expected 列。
# 判定函数 `is_truthy` 定义在下面（POSIX sh 顺序解析），所以这里先占位，
# 在真正用到之前（第 3 步媒体打包前）再算一次。
MEDIA_EXPECTED=0
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
RCLONE_DEST="${RCLONE_DEST:-}"
# rclone 配置文件路径。
#
# 本镜像是 `alpine:3.20` + `apk add rclone`（**不是** LinuxServer 系镜像），
# 它默认读 $HOME/.config/rclone/rclone.conf（root 下即 /root/.config/rclone/），
# **不会**自动去读 /config/rclone —— 那是 LinuxServer 镜像的约定。
# 之前 compose 把宿主 ./rclone 挂到了 /config/rclone，于是 RCLONE_REMOTE 配了
# 也连不上远端，备份只剩 VPS 本地一份：机器一挂数据全没，而"数据自动持久"
# 正是这次改造的全部意义。
#
# 现在挂载点改到 /root/.config/rclone（见 deploy/docker-compose.yml），
# 这里再显式 `--config` 传一遍：busybox crond 派生的环境可能根本不设 HOME，
# 只靠默认路径仍然是赌。两处指向同一个文件，互为兜底。
RCLONE_CONFIG_FILE="${RCLONE_CONFIG_FILE:-/root/.config/rclone/rclone.conf}"
TARGET_LABEL="${BACKUP_TARGET_LABEL:-}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_PREFIX="[backup $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

log() { printf '%s %s\n' "$LOG_PREFIX" "$*"; }
warn() { printf '%s WARN %s\n' "$LOG_PREFIX" "$*" >&2; }
err() { printf '%s ERROR %s\n' "$LOG_PREFIX" "$*" >&2; }
# 把字符串里的单引号转义成两个单引号，安全嵌入 SQL 字面量。
sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }

# -----------------------------------------------------------------------------
# 布尔值判定（QA R2 `P1-R2-5` 的配套项）
#
# 必须与 server/src/env.ts 的 boolFromEnv 认同一套写法，否则会出现
# "server 认为开了媒体备份、backup.sh 却关着"（或反过来）的口径分裂。
# 以前 backup.sh 只认精确的 "true"，于是写 1 / yes / True 全被当 false，
# 而 env.ts 那边是 z.enum(["true","false"]) —— 写 0/yes 直接让 server 启动崩溃。
# 两边现在都认：真 = true|1|yes|on，假 = false|0|no|off（空串按各自的默认值）。
# -----------------------------------------------------------------------------
is_truthy() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        true | 1 | yes | on) return 0 ;;
        *) return 1 ;;
    esac
}

# -----------------------------------------------------------------------------
# 审计记录：往 backups 表插一行，供设置页展示。
# best-effort —— 失败只告警，不影响备份文件本身的有效性。
# 注意：必须定义在所有调用点之前（POSIX sh 顺序解析）。
# -----------------------------------------------------------------------------
#
# 第 6 个参数 `media_expected`（QA R2 `P1-R2-5`）：
#   1 = 本次本来就该打包媒体 —— 于是 media_files=0 是**异常**，status 必须是 failed；
#   0 = 有意只备份数据库（BACKUP_INCLUDE_MEDIA 为假）—— media_files=0 是**预期**。
#
# 没有这一列时，"tar 失败"与"有意关闭媒体"产生的审计行一模一样
# （status=success, media_files=0），运维从设置页完全看不出媒体其实没备份
# —— 正是 P1-3 想消灭的失败模式：媒体零备份但系统全绿，等恢复时才发现图全 404。
# 列由 migrations/0002_job_fencing.sql 添加。
record_audit() {
    audit_status="$1"
    audit_db_bytes="$2"
    audit_media_files="$3"
    audit_media_bytes="$4"
    audit_err="$5"
    audit_media_expected="${6:-0}"

    [ -f "$DATABASE_PATH" ] || return 0
    command -v sqlite3 >/dev/null 2>&1 || return 0

    audit_id="bk_$(date -u +%s)_$$"
    audit_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    audit_target="$(sql_escape "${TARGET_LABEL:-${RCLONE_REMOTE}:${RCLONE_DEST}}")"
    audit_errmsg="$(sql_escape "$audit_err")"
    audit_status_esc="$(sql_escape "$audit_status")"

    sqlite3 "$DATABASE_PATH" <<SQL 2>/dev/null || warn "审计写入失败（不影响备份文件）"
PRAGMA busy_timeout = 5000;
INSERT INTO backups (id, trigger, status, db_bytes, media_files, media_bytes, media_expected, target, error_message, started_at, finished_at)
VALUES ('$audit_id', 'cron', '$audit_status_esc', ${audit_db_bytes:-0}, ${audit_media_files:-0}, ${audit_media_bytes:-0}, ${audit_media_expected:-0}, '$audit_target', NULLIF('$audit_errmsg',''), '$audit_now', '$audit_now');
SQL
}

# -----------------------------------------------------------------------------
# 退出兜底（QA P1-5）
#
# 问题：`set -eu` 下任何意外失败（mkdir 失败、gzip 失败、磁盘写满、tar 被打断、
# 收到 SIGTERM…）都会**直接退出且不写审计行** —— `backups` 表里看不到这次失败，
# 运维只能翻 docker logs，等于备份静默失败。
#
# 方案：入口即注册 EXIT trap（在第一次可能失败的 `mkdir` **之前**），
# 凡未正常走完主流程的退出都补一条 failed 审计行，并清掉半截的 .gz
# （否则要等 14 天后的 -mtime 才会被扫掉）。
# 正常/显式失败路径会先把 FINISHED 置 1（它们自己已经写过审计行），避免重复记录。
#
# 说明：POSIX sh 拿不到"出错的行号"（trap 里的 `$LINENO` 指向 trap 自身），
# 因此错误信息记录的是退出码而不是行号 —— 宁可准确，不要编一个假行号。
# -----------------------------------------------------------------------------
FINISHED=0
TMP_DB=""
DB_OUT=""

cleanup() {
    if [ -n "$TMP_DB" ]; then rm -f "$TMP_DB"; fi
}

on_exit() {
    status=$?
    cleanup
    if [ "$FINISHED" -ne 1 ]; then
        if [ -n "$DB_OUT" ]; then rm -f "$DB_OUT" 2>/dev/null || true; fi
        record_audit "failed" 0 0 0 "aborted (exit=$status)" "$MEDIA_EXPECTED"
        err "备份异常中断（exit=$status），已写入 failed 审计行并清理半截产物"
    fi
}

trap on_exit EXIT
trap 'exit 130' INT TERM

mkdir -p "$STAGE_DIR"

# -----------------------------------------------------------------------------
# 0. 前置检查
# -----------------------------------------------------------------------------
if [ ! -f "$DATABASE_PATH" ]; then
    warn "数据库不存在：$DATABASE_PATH（服务可能尚未首次启动）→ 本次跳过"
    FINISHED=1
    exit 0
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
    err "找不到 sqlite3 CLI，无法做在线安全快照"
    # 没有 sqlite3 就写不了审计行，直接跳过 trap 里的补偿逻辑。
    FINISHED=1
    exit 1
fi

TMP_DB="$STAGE_DIR/.snapshot-$STAMP.sqlite"
DB_OUT="$STAGE_DIR/app-$STAMP.sqlite.gz"

# -----------------------------------------------------------------------------
# 1. 在线快照（带重试：并发写可能让 .backup 暂时拿不到锁）
# -----------------------------------------------------------------------------
attempt=1
ok=0
while [ "$attempt" -le "$RETRY" ]; do
    log "sqlite3 .backup 第 $attempt/$RETRY 次尝试 → $TMP_DB"
    if sqlite3 "$DATABASE_PATH" ".backup '$TMP_DB'"; then
        ok=1
        break
    fi
    warn "快照失败（第 $attempt 次），$((attempt * 5))s 后重试"
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
done

if [ "$ok" -ne 1 ]; then
    err "快照连续失败 $RETRY 次，放弃本次备份"
    record_audit "failed" 0 0 0 "snapshot failed after $RETRY attempts" "$MEDIA_EXPECTED"
    FINISHED=1
    exit 1
fi

# -----------------------------------------------------------------------------
# 2. 压缩
# -----------------------------------------------------------------------------
gzip -c "$TMP_DB" > "$DB_OUT"
DB_BYTES="$(wc -c < "$DB_OUT" | tr -d ' ')"
log "已生成 $DB_OUT（压缩后 $DB_BYTES bytes）"

# -----------------------------------------------------------------------------
# 3. 媒体（可选）
# -----------------------------------------------------------------------------
MEDIA_FILES=0
MEDIA_BYTES=0
if is_truthy "$INCLUDE_MEDIA"; then MEDIA_EXPECTED=1; fi

if [ "$MEDIA_EXPECTED" -eq 1 ]; then
    # 【QA R2 P1-R2-5】要求打包却找不到目录 —— 多半是卷没挂上或 STORAGE_LOCAL_ROOT 配错。
    # 以前只是静默跳过，最终审计行仍是 status=success、media_files=0，
    # 与"有意只备份数据库"完全无法区分。现在判失败并退出。
    if [ ! -d "$STORAGE_LOCAL_ROOT" ]; then
        err "媒体目录不存在：$STORAGE_LOCAL_ROOT（BACKUP_INCLUDE_MEDIA 为真却找不到目录，检查卷挂载与 STORAGE_LOCAL_ROOT）"
        record_audit "failed" "$DB_BYTES" 0 0 "media directory missing: $STORAGE_LOCAL_ROOT" 1
        FINISHED=1
        exit 1
    fi

    MEDIA_OUT="$STAGE_DIR/media-$STAMP.tar.gz"
    log "打包媒体目录 $STORAGE_LOCAL_ROOT → $MEDIA_OUT"
    if tar -czf "$MEDIA_OUT" -C "$(dirname "$STORAGE_LOCAL_ROOT")" "$(basename "$STORAGE_LOCAL_ROOT")"; then
        MEDIA_FILES="$(find "$STORAGE_LOCAL_ROOT" -type f | wc -l | tr -d ' ')"
        MEDIA_BYTES="$(wc -c < "$MEDIA_OUT" | tr -d ' ')"
        log "媒体打包完成：$MEDIA_FILES 个文件，$MEDIA_BYTES bytes"
        # 目录存在却一个文件都没有：多半是挂了空卷。不判失败，但要让人看见。
        if [ "$MEDIA_FILES" -eq 0 ]; then
            warn "媒体目录存在但为空（0 个文件），请确认卷是否真的挂上了"
        fi
    else
        # 【QA R2 P1-R2-5】tar 失败不再"跳过并报成功"。
        err "媒体打包失败（数据库快照仍然有效，但本次备份不完整）"
        record_audit "failed" "$DB_BYTES" 0 0 "media tar failed" 1
        FINISHED=1
        exit 1
    fi
else
    # 有意关闭：审计行 media_expected=0，与上面的"失败"区分开。
    log "BACKUP_INCLUDE_MEDIA 为假 → 有意只备份数据库（媒体零备份，恢复后画布里的图会 404）"
fi

# -----------------------------------------------------------------------------
# 4. 清理过期本地备份
# -----------------------------------------------------------------------------
REMOVED="$(find "$STAGE_DIR" -maxdepth 1 -type f \( -name 'app-*.sqlite.gz' -o -name 'media-*.tar.gz' \) -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')"
log "清理超过 ${KEEP_DAYS} 天的本地备份：$REMOVED 个"

# -----------------------------------------------------------------------------
# 5. 上传远端
# -----------------------------------------------------------------------------
if [ -n "$RCLONE_REMOTE" ]; then
    if ! command -v rclone >/dev/null 2>&1; then
        err "RCLONE_REMOTE 已设置但找不到 rclone 命令"
        record_audit "failed" "$DB_BYTES" "$MEDIA_FILES" "$MEDIA_BYTES" "rclone missing" "$MEDIA_EXPECTED"
        FINISHED=1
        exit 1
    fi
    # 配置文件缺失必须显式报错。
    #
    # 以前 compose 的注释写"缺失也不会报错"，于是 rclone 拿着空配置静默连不上远端，
    # 备份只剩 VPS 本地一份，而审计行照样 status=success —— 典型的备份静默失效。
    # 原则同 P1-R2-5：既然 RCLONE_REMOTE 非空就是用户明确要异地备份，
    # 传不上去等同于失败，必须记 failed 并 exit 1，不能照常报成功。
    if [ ! -f "$RCLONE_CONFIG_FILE" ]; then
        err "找不到 rclone 配置：$RCLONE_CONFIG_FILE（把 rclone.conf 放进 deploy/rclone/ 后重启，或用 RCLONE_CONFIG_FILE 指向别处）"
        record_audit "failed" "$DB_BYTES" "$MEDIA_FILES" "$MEDIA_BYTES" "rclone config missing" "$MEDIA_EXPECTED"
        FINISHED=1
        exit 1
    fi

    REMOTE_TARGET="$RCLONE_REMOTE:$RCLONE_DEST"
    log "rclone → $REMOTE_TARGET（配置：$RCLONE_CONFIG_FILE）"
    if rclone copy "$STAGE_DIR" "$REMOTE_TARGET" \
        --config "$RCLONE_CONFIG_FILE" \
        --include 'app-*.sqlite.gz' --include 'media-*.tar.gz' \
        --retries "$RETRY" --low-level-retries "$RETRY" --stats-one-line; then
        log "上传完成"
    else
        err "rclone 上传失败（本地备份已保留，可人工补传）"
        record_audit "failed" "$DB_BYTES" "$MEDIA_FILES" "$MEDIA_BYTES" "rclone upload failed" "$MEDIA_EXPECTED"
        FINISHED=1
        exit 1
    fi
else
    log "未配置 RCLONE_REMOTE → 仅本地备份（$STAGE_DIR）"
fi

record_audit "success" "$DB_BYTES" "$MEDIA_FILES" "$MEDIA_BYTES" "" "$MEDIA_EXPECTED"
FINISHED=1
log "备份成功"
exit 0
