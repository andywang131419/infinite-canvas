/**
 * Job 队列 —— 表即队列（不引入 Redis/Kafka，ARCH §R3 明确不引入中间件）。
 *
 * 并发安全的**唯一**依据是下面那几条单语句 SQL：
 * - 认领：`UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` —— 
 *   子查询与更新在同一个语句里，SQLite 的写锁保证 20 个并发 worker 不会拿到同一条；
 * - 续租：`... WHERE id = ? AND lease_until > :now` —— 租约已失效时 changes=0，
 *   Worker 据此自杀式放弃（避免"僵尸任务"把结果写回去覆盖新 Worker 的成果）；
 * - 回收：`lease_until < now` 的 running 分两类处理 ——
 *   还有重试余量 → 回 `queued` 并退避；已用尽 → 直接 `failed`。
 *
 * 所有 SQL 都以常量导出，`scripts/verify-t03.mjs` 会**原样抽取**并在
 * `node:sqlite` 上跑真断言（不是抄一份 SQL）。
 */

import { getDb } from "../db/client";

/** 任务类型（与 `jobs.type` 的 CHECK 约束一致）。 */
export type JobType = "image" | "image_edit" | "video" | "audio" | "llm";

/** 任务状态。 */
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** 任务行（`RETURNING *` 的完整形状）。 */
export type JobRow = {
    id: string;
    canvas_id: string;
    node_id: string;
    user_id: string;
    type: JobType;
    channel_id: string | null;
    capability: "image" | "video" | "audio" | "text";
    model: string;
    params: string;
    status: JobStatus;
    progress: number;
    stage: string | null;
    result_storage_keys: string | null;
    upstream_task_id: string | null;
    error_code: string | null;
    error_message: string | null;
    retryable: number;
    attempt: number;
    max_attempts: number;
    idempotency_key: string | null;
    lease_until: string | null;
    run_after: string;
    priority: number;
    cost_estimate: number | null;
    cost_actual: number | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    updated_at: string;
};

// =============================================================================
// SQL
// =============================================================================

/**
 * **原子认领**。
 *
 * 参数顺序：1. started_at(仅首次)  2. lease_until  3. updated_at  4. now(run_after 判据)
 *
 * 为什么 `started_at = COALESCE(started_at, ?)`：重试的任务不应该把"首次开始时间"
 * 反复刷新，否则排障时看不出真实耗时。
 *
 * `AND attempt < max_attempts`（QA R2 队列类 P2）：
 * 少了它，一条 attempt 已耗尽、却因 `requeueExpired` 中途崩溃而停留在 `queued`
 * 的任务会被再次认领，`attempt` 被加到 3/2 —— 于是用户看到"重试 3 次"而
 * 配置写的是 2 次，上游也被多计费一次。
 */
export const SQL_CLAIM_JOB = `
UPDATE jobs
   SET status = 'running',
       attempt = attempt + 1,
       started_at = COALESCE(started_at, ?),
       lease_until = ?,
       updated_at = ?
 WHERE id = (
     SELECT id FROM jobs
      WHERE status = 'queued'
        AND run_after <= ?
        AND attempt < max_attempts
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
 )
RETURNING *
`;

/**
 * 心跳续租。
 *
 * 参数顺序：1. lease_until  2. updated_at  3. id  4. now
 *
 * `AND lease_until > ?` 是关键：租约已被别人回收（或已被 requeue）时
 * changes=0，Worker 必须立即停止并丢弃结果。
 */
export const SQL_HEARTBEAT = `
UPDATE jobs
   SET lease_until = ?, updated_at = ?
 WHERE id = ?
   AND status = 'running'
   AND lease_until > ?
`;

/**
 * 回收过期租约：还有重试余量 → 回 queued 并退避。
 *
 * 参数顺序：1. run_after(退避后)  2. updated_at  3. now   4. now
 */
export const SQL_REQUEUE_EXPIRED = `
UPDATE jobs
   SET status = 'queued',
       lease_until = NULL,
       run_after = ?,
       updated_at = ?
 WHERE status = 'running'
   AND lease_until IS NOT NULL
   AND lease_until < ?
   AND attempt < max_attempts
   AND run_after <= ?
`;

/**
 * 回收过期租约：重试已用尽 → 直接判失败（否则会永远转圈）。
 *
 * 参数顺序：1. finished_at  2. updated_at  3. now
 */
export const SQL_FAIL_EXPIRED = `
UPDATE jobs
   SET status = 'failed',
       lease_until = NULL,
       error_code = COALESCE(error_code, 'PROVIDER_TIMEOUT'),
       error_message = COALESCE(error_message, '任务租约过期且重试次数已用尽'),
       retryable = 0,
       finished_at = ?,
       updated_at = ?
 WHERE status = 'running'
   AND lease_until IS NOT NULL
   AND lease_until < ?
   AND attempt >= max_attempts
`;

/**
 * 成功收尾。
 *
 * **QA R2 `P1-R2-1`（僵尸 Worker 覆盖新 Worker 的成果）**：
 * 原来这里只有 `WHERE id = ? AND status = 'running'`，而 `status='running'`
 * **不是 fencing token** —— 任务被 reaper 回队、又被另一个 Worker 认领之后，
 * 状态又变回 `running`，旧 Worker 的收尾照样命中，于是：
 *
 *   A 认领 attempt=1 → 心跳失败 → reaper 回队 → B 认领 attempt=2
 *   → A 僵尸收尾 changes=1，写入 image:A-STALE
 *   → B 正常收尾 changes=0，成果被丢
 *   → 用户看到上一次失败运行的图，attempt 被真实消耗、上游计费两次
 *
 * `AND attempt = ?` 才是围栏：它认的是**这一次的认领**，不是"当前是不是 running"。
 * 两条收尾 SQL 必须一起加，漏一条就等于没加。
 *
 * 参数顺序：1. result_storage_keys  2. cost_actual  3. finished_at  4. updated_at
 *           5. id  6. attempt
 */
export const SQL_FINISH_SUCCEEDED = `
UPDATE jobs
   SET status = 'succeeded',
       progress = 1,
       stage = NULL,
       result_storage_keys = ?,
       cost_actual = ?,
       error_code = NULL,
       error_message = NULL,
       lease_until = NULL,
       finished_at = ?,
       updated_at = ?
 WHERE id = ?
   AND status = 'running'
   AND attempt = ?
`;

/**
 * 失败 / 取消收尾。
 *
 * 同样带 `AND attempt = ?` 围栏（理由见 `SQL_FINISH_SUCCEEDED`）：
 * 僵尸 Worker 写一次"失败 + 回队"会让 attempt 计数与退避时间都错乱。
 *
 * 参数顺序：1. status  2. error_code  3. error_message  4. retryable
 * 5. run_after（可重试时用于退避，不可重试时写入当前时间即可）
 * 6. finished_at  7. updated_at  8. id  9. attempt
 */
export const SQL_FINISH_FAILED = `
UPDATE jobs
   SET status = ?,
       error_code = ?,
       error_message = ?,
       retryable = ?,
       run_after = ?,
       lease_until = NULL,
       finished_at = ?,
       updated_at = ?
 WHERE id = ?
   AND status = 'running'
   AND attempt = ?
`;

/** 进度上报。参数：1. progress 2. stage 3. updated_at 4. id */
export const SQL_UPDATE_PROGRESS = `
UPDATE jobs
   SET progress = ?, stage = ?, updated_at = ?
 WHERE id = ?
   AND status = 'running'
`;

/** 记录上游二级任务 ID（视频）。参数：1. upstream_task_id 2. updated_at 3. id */
export const SQL_SET_UPSTREAM_TASK = `
UPDATE jobs SET upstream_task_id = ?, updated_at = ? WHERE id = ?
`;

// 下面几条 SQL 同样导出：`scripts/verify-t03.mjs` 会原样抽取来验证
// 「幂等入队只写一行」「列表/取消的 WHERE 条件正确」，而不是在脚本里重写一遍。

/**
 * 按幂等键取（**限定 user_id**）。
 *
 * QA R2 `P1-R2-4`：原来只有 `WHERE idempotency_key = ?`，而幂等键是客户端
 * 随便给的字符串 —— B 只要猜到/复用 A 用过的键，就能拿到 A 的任务详情，
 * 包括 `result_storage_keys`（能直接下载 A 生成的图）、`upstream_task_id`
 * 与 `errorMessage`。配套的 `ux_jobs_idempotency` 也缺 `user_id`
 * （见 `migrations/0002_job_fencing.sql`），所以这里是"索引 + 查询"两边一起修。
 *
 * 参数顺序：1. idempotency_key  2. user_id
 */
export const SQL_SELECT_BY_IDEMPOTENCY = `
SELECT * FROM jobs WHERE idempotency_key = ? AND user_id = ? LIMIT 1
`;

export const SQL_INSERT_JOB = `
INSERT INTO jobs (id, canvas_id, node_id, user_id, type, channel_id, capability, model, params,
                  status, progress, retryable, attempt, max_attempts, idempotency_key,
                  run_after, priority, cost_estimate, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 1, 0, ?, ?, ?, ?, ?, ?, ?)
`;

export const SQL_SELECT_JOB_BY_ID = `SELECT * FROM jobs WHERE id = ?`;

export const SQL_SELECT_JOB_BY_ID_OWNED = `SELECT * FROM jobs WHERE id = ? AND user_id = ?`;

export const SQL_LIST_ALL = `
SELECT * FROM jobs
 WHERE canvas_id = ?
 ORDER BY created_at DESC
 LIMIT ?
`;

export const SQL_LIST_OPEN = `
SELECT * FROM jobs
 WHERE canvas_id = ?
   AND status IN ('queued', 'running')
 ORDER BY created_at ASC
 LIMIT ?
`;

export const SQL_COUNT_OPEN = `
SELECT COUNT(*) AS total FROM jobs
 WHERE canvas_id = ? AND status IN ('queued', 'running')
`;

export const SQL_CANCEL = `
UPDATE jobs
   SET status = 'canceled',
       lease_until = NULL,
       finished_at = ?,
       updated_at = ?
 WHERE id = ?
   AND user_id = ?
   AND status IN ('queued', 'running')
`;

// =============================================================================
// 操作
// =============================================================================

/** 认领结果。`null` 表示队列为空（或全部未到 `run_after`）。 */
export function claimNextJob(leaseSeconds: number, now: Date = new Date()): JobRow | null {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

    const row = getDb().query(SQL_CLAIM_JOB).get(nowIso, leaseUntil, nowIso, nowIso) as JobRow | null;
    return row ?? null;
}

/** 心跳续租。@returns false = 租约已失效，调用方必须放弃。 */
export function heartbeat( jobId: string, leaseSeconds: number, now: Date = new Date()): boolean {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const changes = getDb().query(SQL_HEARTBEAT).run(leaseUntil, nowIso, jobId, nowIso).changes;
    return Number(changes) > 0;
}

/** 回收过期租约的统计。 */
export type RequeueResult = { requeued: number; failed: number };

/**
 * 回收过期租约。
 *
 * @param backoffSeconds 可重试任务的退避时长（`JOB_RETRY_BACKOFF_S`）。
 */
export function requeueExpired(backoffSeconds: number, now: Date = new Date()): RequeueResult {
    const db = getDb();
    const nowIso = now.toISOString();
    const runAfter = new Date(now.getTime() + backoffSeconds * 1000).toISOString();

    const requeued = Number(db.query(SQL_REQUEUE_EXPIRED).run(runAfter, nowIso, nowIso, nowIso).changes);
    const failed = Number(db.query(SQL_FAIL_EXPIRED).run(nowIso, nowIso, nowIso).changes);

    return { requeued, failed };
}

/**
 * 标记成功。
 *
 * @param job 认领时的快照 —— **必须带 `attempt`**：它是这次认领的 fencing token
 *             （`SQL_FINISH_SUCCEEDED` 的 `AND attempt = ?`），没有它就等于没围栏。
 * @returns 是否真的写入。`false` 表示这一轮已经不是自己在跑（被取消 / 被回收 / 已被他人收尾）。
 */
export function markSucceeded(job: Pick<JobRow, "id" | "attempt">, storageKeys: string[], costActual: number | null, now: Date = new Date()): boolean {
    const nowIso = now.toISOString();
    const keys = storageKeys.length > 0 ? JSON.stringify(storageKeys) : null;
    const changes = getDb().query(SQL_FINISH_SUCCEEDED).run(keys, costActual, nowIso, nowIso, job.id, job.attempt).changes;
    return Number(changes) > 0;
}

/** 失败收尾的结果。 */
export type MarkFailedResult = {
    /** 写入的状态：`queued`（还能重试）或 `failed`（终态）。 */
    status: JobStatus;
    /** 还要等多久才会被再次认领；`null` 表示不再重试。 */
    nextAttemptInSeconds: number | null;
    /**
     * 是否真的写入了这行。
     *
     * QA R2 队列类 P2：以前不看 `changes`，任务已被用户取消、或已被另一个 Worker
     * 收尾时仍会打日志"X 秒后重试"—— 运维按日志去等一次永远不会发生的重试。
     * 这里与 `markSucceeded` 统一成返回 boolean，调用方据此决定要不要说"会重试"。
     */
    applied: boolean;
};

/**
 * 标记失败。
 *
 * 可重试（`retryable` 且 `attempt < max_attempts`）时**回到 queued** 并退避；
 * 否则终态 `failed`。这条判断放在应用层是刻意的：
 * 让"什么叫可重试"成为业务语义（上游 429 可重试，内容审核拒绝不可重试）。
 */
export function markFailed(
    job: Pick<JobRow, "id" | "attempt" | "max_attempts">,
    error: { code: string; message: string; retryable: boolean },
    backoffSeconds: number,
    now: Date = new Date(),
): MarkFailedResult {
    const canRetry = error.retryable && job.attempt < job.max_attempts;
    const nowIso = now.toISOString();
    const nextRunAfter = canRetry ? new Date(now.getTime() + backoffSeconds * 1000).toISOString() : nowIso;
    const status: JobStatus = canRetry ? "queued" : "failed";

    const changes = getDb()
        .query(SQL_FINISH_FAILED)
        .run(
            status,
            error.code,
            truncate(error.message, 1000),
            error.retryable ? 1 : 0,
            nextRunAfter,
            canRetry ? null : nowIso,
            nowIso,
            job.id,
            job.attempt,
        ).changes;

    return { status, nextAttemptInSeconds: canRetry ? backoffSeconds : null, applied: Number(changes) > 0 };
}

/** 上报进度（progress 会被夹到 [0,1]）。 */
export function updateProgress(jobId: string, progress: number, stage?: string | null, now: Date = new Date()): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
    getDb().query(SQL_UPDATE_PROGRESS).run(clamped, stage ?? null, now.toISOString(), jobId);
}

/** 记录上游二级任务 ID。 */
export function setUpstreamTaskId(jobId: string, upstreamTaskId: string): void {
    getDb().query(SQL_SET_UPSTREAM_TASK).run(upstreamTaskId, new Date().toISOString(), jobId);
}

/** 按 id 取（不限 owner，Worker 内部用）。 */
export function findJobById(id: string): JobRow | null {
    return (getDb().query(SQL_SELECT_JOB_BY_ID).get(id) as JobRow | null) ?? null;
}

/** 按 id 取（限定 owner，路由用）。 */
export function findJobByIdOwned(userId: string, id: string): JobRow | null {
    return (getDb().query(SQL_SELECT_JOB_BY_ID_OWNED).get(id, userId) as JobRow | null) ?? null;
}

/**
 * 按幂等键取（**限定 owner**）。
 *
 * 必须传 `userId`：幂等键是客户端随便给的字符串，不按用户隔离就等于
 * 「猜到别人的键就能读到别人的任务结果」（QA R2 `P1-R2-4`）。
 */
export function findJobByIdempotencyKey(key: string, userId: string): JobRow | null {
    return (getDb().query(SQL_SELECT_BY_IDEMPOTENCY).get(key, userId) as JobRow | null) ?? null;
}

/**
 * 幂等键冲突：同一用户对同一键再次提交，但既有任务属于**另一个画布**或**另一种类型**。
 *
 * 刻意不是 `ApiError`：本文件是数据层，不该知道 HTTP 状态码；
 * 由 `services/job-service.ts` 翻译成 409。
 *
 * 为什么不能"直接返回既有任务"：前端用"请求体哈希"当幂等键，两个不同画布的
 * 请求体完全可能一样（同一句 prompt 在两个画布各生成一次）。此时返回第一个画布的
 * 任务，用户会在当前画布里看到永远等不到的结果。
 */
export class IdempotencyConflictError extends Error {
    /** 冲突的维度。 */
    readonly reason: "canvas_mismatch" | "type_mismatch";
    /** 既有任务的 id（前端拿它可以跳过去看）。 */
    readonly jobId: string;

    constructor(reason: "canvas_mismatch" | "type_mismatch", jobId: string, message: string) {
        super(message);
        this.name = "IdempotencyConflictError";
        this.reason = reason;
        this.jobId = jobId;
    }
}

/** 建任务入参。 */
export type EnqueueJobInput = {
    canvasId: string;
    nodeId: string;
    userId: string;
    type: JobType;
    capability: "image" | "video" | "audio" | "text";
    channelId?: string | null;
    model: string;
    /** 可序列化 JSON（**禁止**含 apiKey / 参考图 base64）。 */
    params: Record<string, unknown>;
    idempotencyKey?: string | null;
    maxAttempts?: number;
    priority?: number;
    /** 延迟执行（毫秒）。默认 0 = 立即可领。 */
    delayMs?: number;
    costEstimate?: number | null;
};

/** 入队结果。`created=false` 表示命中幂等键，返回的是已有任务。 */
export type EnqueueJobResult = { job: JobRow; created: boolean };

/**
 * 入队（含幂等）。
 *
 * 幂等实现：`BEGIN IMMEDIATE` 内「查幂等键 → 有则直接返回 → 无则插入」。
 * 用写事务而不是"先查后插"是因为后者在并发下会双插（虽然有唯一索引兜底，
 * 但会把异常路径变成常态路径，日志会很脏）。
 *
 * 三道隔离（QA R2 `P1-R2-4`）：
 * 1. `user_id` —— 幂等键按用户隔离，B 复用 A 的键会**新建**而不是读到 A 的；
 * 2. `canvas_id` —— 同一用户对两个画布提交同一份 body，第二次是**新任务**；
 * 3. `type` —— 同一键先建 image 再建 video，也是新任务。
 *
 * 2/3 命中时抛 `IdempotencyConflictError`（而不是悄悄返回另一个任务），
 * 让调用方能明确告诉前端"这个键已经被别处用了"。
 *
 * @returns `created=true` 表示新建；`false` 表示命中幂等键（**不得重复调用上游**）。
 * @throws {IdempotencyConflictError} 幂等键被同一用户的另一个画布/类型占用
 */
export function enqueueJob(input: EnqueueJobInput, now: Date = new Date()): EnqueueJobResult {
    const db = getDb();
    const idempotencyKey = input.idempotencyKey?.trim() || null;

    if (!idempotencyKey) {
        return { job: insertJobRow(input, now), created: true };
    }

    db.exec("BEGIN IMMEDIATE");
    try {
        const existing = findJobByIdempotencyKey(idempotencyKey, input.userId);
        if (existing) {
            if (existing.canvas_id !== input.canvasId) {
                throw new IdempotencyConflictError("canvas_mismatch", existing.id, `幂等键已被同一用户的另一个画布占用（画布 ${existing.canvas_id}）`);
            }
            if (existing.type !== input.type) {
                throw new IdempotencyConflictError("type_mismatch", existing.id, `幂等键已被同一用户的另一种任务占用（类型 ${existing.type}）`);
            }
            db.exec("COMMIT");
            return { job: existing, created: false };
        }

        const job = insertJobRow(input, now);
        db.exec("COMMIT");
        return { job, created: true };
    } catch (error) {
        // COMMIT 失败时事务已经结束，再 ROLLBACK 会抛
        // "cannot rollback - no transaction is active"，把真正的错误掩盖掉。
        // 所以回滚本身也要容错（QA R2 队列类 P2）。
        try {
            db.exec("ROLLBACK");
        } catch {
            // 忽略：这里唯一要做的就是把原始异常抛上去。
        }
        throw error;
    }
}

/** 真正写一行。 */
function insertJobRow(input: EnqueueJobInput, now: Date): JobRow {
    const db = getDb();
    const id = crypto.randomUUID();
    const nowIso = now.toISOString();
    const runAfter = new Date(now.getTime() + Math.max(0, input.delayMs ?? 0)).toISOString();

    db.query(SQL_INSERT_JOB).run(
        id,
        input.canvasId,
        input.nodeId,
        input.userId,
        input.type,
        input.channelId ?? null,
        input.capability,
        input.model,
        JSON.stringify(input.params ?? {}),
        Math.max(1, input.maxAttempts ?? 2),
        input.idempotencyKey?.trim() || null,
        runAfter,
        input.priority ?? 0,
        input.costEstimate ?? null,
        nowIso,
        nowIso,
    );

    const created = findJobById(id);
    if (!created) throw new Error("任务入队后无法读回");
    return created;
}

/** 列出画布下全部任务（倒序）。 */
export function listJobs(canvasId: string, limit = 50): JobRow[] {
    return getDb().query(SQL_LIST_ALL).all(canvasId, Math.min(Math.max(1, limit), 200)) as JobRow[];
}

/** 列出画布下未完成任务。 */
export function listOpenJobsByCanvas(canvasId: string, limit = 50): JobRow[] {
    return getDb().query(SQL_LIST_OPEN).all(canvasId, Math.min(Math.max(1, limit), 200)) as JobRow[];
}

/** 未完成任务数。 */
export function countOpenJobs(canvasId: string): number {
    const row = getDb().query(SQL_COUNT_OPEN).get(canvasId) as { total: number } | null;
    return row?.total ?? 0;
}

/** 取消任务（仅自己的、且未终态）。@returns 是否真的取消了。 */
export function cancelJob(userId: string, jobId: string, now: Date = new Date()): boolean {
    const nowIso = now.toISOString();
    return Number(getDb().query(SQL_CANCEL).run(nowIso, nowIso, jobId, userId).changes) > 0;
}

/** 截断字符串（错误信息入库前统一裁一下，避免上游返回巨串撑爆表）。 */
function truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max)}…`;
}
