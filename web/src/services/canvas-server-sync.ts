/**
 * canvas-server-sync —— 画布"本地为主 + 服务端持久化"的双写引擎（T04-A5）。
 *
 * 设计取舍（为什么不是"改成纯服务端"）：
 * 画布页是上游 198KB 的大文件，硬约束是**一行不改**。它的读写全部通过
 * `useCanvasStore`（zustand + 本地 IndexedDB persist）。因此最稳的做法是
 * **旁挂一个同步器**：本地存储仍然是唯一事实来源（离线可用、零回归），
 * 服务端拿一份可跨设备恢复的副本。
 *
 * 关键机制（逐条对应设计稿）：
 * 1. **变更检测用对象引用比对**，不做深比较。
 *    `useCanvasStore.updateProject` 每次都用新对象替换被改的那一项，
 *    所以"引用变了 = 内容可能变了"，比 `JSON.stringify` 便宜几个数量级。
 *    整个 `projects` 数组引用没变时直接早退。
 * 2. **800ms 防抖**：拖拽节点会连续触发几十次更新，不防抖就是几十次 PUT。
 * 3. **同一画布串行化**：上一发没回来不发下一发，避免乱序覆盖 + 版本号打架。
 * 4. **乐观锁**：每次 PUT 带 `baseRevision`；409 意味着"另一端已更新"，
 *    **绝不自动覆盖**，而是把服务端最新内容塞进冲突弹窗让用户选。
 * 5. **失败退避**：1→2→4→…≤30s，且**不清本地数据**（离线也要能继续画）。
 * 6. **revision 持久化**：换页/刷新后不能忘掉自己拿到的是第几版，
 *    否则会拿错误的 baseRevision 去 PUT（要么假冲突，要么真覆盖）。
 */

import localforage from "localforage";

import { apiDelete, apiGet, apiPut, ServerApiError } from "@/services/server-api";
import { useCanvasStore, type CanvasDeletedProject, type CanvasProject } from "@/stores/canvas/use-canvas-store";

/** 同步状态（顶栏 pill / 列表小圆点都读它）。 */
export type CanvasSyncState = "idle" | "syncing" | "pending" | "conflict" | "offline";

/** 同步快照（供 UI 订阅）。 */
export type CanvasSyncSnapshot = {
    state: CanvasSyncState;
    /** 还没推上去的画布数。 */
    pending: number;
    /** 处于冲突的画布 id。 */
    conflicts: string[];
    /** 最近一次成功同步时间（ISO）。 */
    lastSyncedAt: string | null;
    /** 最近一次失败的人话原因。 */
    error: string | null;
    /** 离线（连续失败）时的下次重试时间（毫秒时间戳）。 */
    retryAt: number | null;
};

/** 冲突详情（弹窗数据源）。 */
export type CanvasConflict = {
    canvasId: string;
    title: string;
    /** 本机这一版的更新时间与节点数。 */
    localUpdatedAt: string;
    localNodeCount: number;
    /** 服务端那一版的更新时间/节点数/版本号。 */
    remoteUpdatedAt: string;
    remoteNodeCount: number;
    remoteRevision: number;
    /** 服务端最新 doc（只在"保留服务端"时整份替换本地）。 */
    latestDoc: unknown;
};

/** 服务端画布列表项（与 `CanvasSummaryDto` 对齐）。 */
type CanvasSummaryDto = {
    id: string;
    title: string;
    revision: number;
    nodeCount: number;
    createdAt: string;
    updatedAt: string;
};

/** 服务端画布详情。 */
type CanvasDetailDto = CanvasSummaryDto & { doc: unknown; updatedByDevice: string | null };

/** PUT 的响应。 */
type PutCanvasResult = { canvas: CanvasSummaryDto; sanitize: { dropped: number } };

/** PUT 的请求体。 */
type PutCanvasBody = { baseRevision: number; doc: unknown; title: string };

/**
 * 传输层（可注入）。
 *
 * 生产环境就是 `server-api` 的三个调用；单测里可以换成一个纯内存的假实现，
 * 从而验证"引用比对不重复推送""409 不自动覆盖"这类**引擎行为**，
 * 而不是去断言 HTTP 细节。
 */
export type CanvasSyncTransport = {
    put: (canvasId: string, body: PutCanvasBody) => Promise<PutCanvasResult>;
    remove: (canvasId: string) => Promise<void>;
    list: () => Promise<{ items: CanvasSummaryDto[]; total: number }>;
    detail: (canvasId: string) => Promise<{ canvas: CanvasDetailDto }>;
    revision: (canvasId: string) => Promise<{ revision: number; updatedAt: string }>;
};

const defaultTransport: CanvasSyncTransport = {
    put: (canvasId, body) => apiPut<PutCanvasResult>(`/api/canvases/${encodeURIComponent(canvasId)}`, body),
    remove: (canvasId) => apiDelete<void>(`/api/canvases/${encodeURIComponent(canvasId)}`),
    list: () => apiGet<{ items: CanvasSummaryDto[]; total: number }>("/api/canvases?limit=200"),
    detail: (canvasId) => apiGet<{ canvas: CanvasDetailDto }>(`/api/canvases/${encodeURIComponent(canvasId)}`),
    revision: (canvasId) => apiGet<{ revision: number; updatedAt: string }>(`/api/canvases/${encodeURIComponent(canvasId)}/revision`),
};

let transport: CanvasSyncTransport = defaultTransport;

/** 替换传输层（传 `null` 恢复真实 HTTP）。仅供测试使用。 */
export function setCanvasSyncTransport(next: CanvasSyncTransport | null): void {
    transport = next ?? defaultTransport;
}

/** 清空引擎内部状态（仅供测试使用）。 */
export function resetCanvasSyncState(): void {
    revisions.clear();
    syncedRefs.clear();
    queuedRefs.clear();
    inflight.clear();
    deletedSent.clear();
    conflicts.clear();
    backoffMs = 0;
    dirty = false;
    started = false;
    lastProjectsRef = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    debounceTimer = null;
    retryTimer = null;
    disposeFns = [];
    snapshot = { state: "idle", pending: 0, conflicts: [], lastSyncedAt: null, error: null, retryAt: null };
}

/** 防抖窗口：拖拽时一帧内多次更新只发一次。 */
const DEBOUNCE_MS = 800;

/** 退避上限。 */
const MAX_BACKOFF_MS = 30_000;

/** revision 持久化的本地键。 */
const REVISION_STORAGE_KEY = "infinite-canvas:server_revisions";

const revisionStore = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });

/** 每个画布已知的服务端版本号。 */
const revisions = new Map<string, number>();

/** 每个画布"最后一次成功推送时的对象引用" —— 引用相同就不必再推。 */
const syncedRefs = new Map<string, CanvasProject>();

/** 每个画布"最后被观察到并已排进队列的对象引用"（避免同一版本重复入队）。 */
const queuedRefs = new Map<string, CanvasProject>();

/** 同一画布的 PUT 串行化。 */
const inflight = new Map<string, Promise<void>>();

/** 已经尝试删除过的画布 id（删除是幂等的，但不必反复发）。 */
const deletedSent = new Set<string>();

/** 冲突表。 */
const conflicts = new Map<string, CanvasConflict>();

/** 快照与订阅。 */
let snapshot: CanvasSyncSnapshot = { state: "idle", pending: 0, conflicts: [], lastSyncedAt: null, error: null, retryAt: null };
const listeners = new Set<() => void>();

/** 防抖定时器。 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** 退避状态。 */
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 0;
/** 是否还有没推上去的脏数据（退避结束后要整体重试）。 */
let dirty = false;

let started = false;
let disposeFns: (() => void)[] = [];
let lastProjectsRef: CanvasProject[] | null = null;

/** 读快照（`useSyncExternalStore` 的 getSnapshot）。 */
export function getCanvasSyncSnapshot(): CanvasSyncSnapshot {
    return snapshot;
}

/** 订阅快照变化。 */
export function subscribeCanvasSync(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** 取某个画布的冲突详情（没有就返回 `null`）。 */
export function getCanvasConflict(canvasId: string): CanvasConflict | null {
    return conflicts.get(canvasId) ?? null;
}

/** 重新计算并广播快照。 */
function publish(patch: Partial<CanvasSyncSnapshot> = {}): void {
    const pending = countPending();
    const next: CanvasSyncSnapshot = {
        ...snapshot,
        ...patch,
        pending,
        conflicts: [...conflicts.keys()],
    };
    // 状态机只有一处推导：有冲突优先冲突，其次离线/同步中，最后看有没有待推数据。
    if (conflicts.size > 0) next.state = "conflict";
    else if (next.state !== "offline" && next.state !== "syncing") next.state = pending > 0 ? "pending" : "idle";

    const changed =
        next.state !== snapshot.state ||
        next.pending !== snapshot.pending ||
        next.conflicts.length !== snapshot.conflicts.length ||
        next.lastSyncedAt !== snapshot.lastSyncedAt ||
        next.error !== snapshot.error ||
        next.retryAt !== snapshot.retryAt;
    snapshot = next;
    if (changed) listeners.forEach((listener) => listener());
}

/**
 * 还有多少画布等着推。
 *
 * 处于冲突的画布**不算 pending**：它在等用户做选择，自动重推只会再撞一次 409。
 */
function countPending(): number {
    const projects = useCanvasStore.getState().projects;
    let count = 0;
    for (const project of projects) {
        if (conflicts.has(project.id)) continue;
        if (syncedRefs.get(project.id) !== project) count += 1;
    }
    return count;
}

/** 持久化 revision 表（失败无所谓，最多下次多一次 409）。 */
async function persistRevisions(): Promise<void> {
    try {
        await revisionStore.setItem(REVISION_STORAGE_KEY, Object.fromEntries(revisions));
    } catch {
        // 存不进去也只是重启后多一次冲突探测，不阻断主流程。
    }
}

/** 从本地恢复 revision 表。 */
async function restoreRevisions(): Promise<void> {
    try {
        const saved = await revisionStore.getItem<Record<string, number>>(REVISION_STORAGE_KEY);
        if (!saved || typeof saved !== "object") return;
        for (const [id, revision] of Object.entries(saved)) {
            if (typeof revision === "number" && Number.isFinite(revision)) revisions.set(id, revision);
        }
    } catch {
        // 同上：读不出来就当作首次运行。
    }
}

/** 取某画布用于 PUT 的 baseRevision。 */
function baseRevisionFor(canvasId: string): number {
    return revisions.get(canvasId) ?? 0;
}

/**
 * 启动同步引擎（幂等；返回 dispose）。
 *
 * 做三件事：
 * 1. 恢复 revision 表；
 * 2. 启动时做一次基线拉取（比对 updatedAt），把"服务端有、本地没有"的画布补进来；
 * 3. 订阅 store，按引用比对 + 防抖推增量。
 */
export function startCanvasServerSync(): () => void {
    if (started) return () => undefined;
    started = true;

    const unsubscribeStore = useCanvasStore.subscribe((state) => {
        // 数组引用没变 → 没有任何画布被写过。`scheduleScan` 内部会立刻早退，
        // 这里不做深比较，代价就是一次 map 遍历。
        lastProjectsRef = state.projects;
        scheduleScan(state.projects, state.deletedProjects);
    });

    // 事件监听是"有则更好"：单测 / SSR 里没有 document/window，不能因此启动失败。
    const hasDocument = typeof document !== "undefined";
    const hasWindow = typeof window !== "undefined";

    const onVisible = () => {
        if (document.visibilityState === "visible") void probeRevisions();
    };
    if (hasDocument) document.addEventListener("visibilitychange", onVisible);

    const onOnline = () => {
        // 网络回来了：清掉退避，立刻重试一轮。
        backoffMs = 0;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        publish({ state: "pending", error: null, retryAt: null });
        scheduleScan(useCanvasStore.getState().projects, useCanvasStore.getState().deletedProjects, 0);
    };
    if (hasWindow) window.addEventListener("online", onOnline);

    disposeFns = [unsubscribeStore];
    if (hasDocument) disposeFns.push(() => document.removeEventListener("visibilitychange", onVisible));
    if (hasWindow) disposeFns.push(() => window.removeEventListener("online", onOnline));

    void (async () => {
        await restoreRevisions();
        await bootstrapFromServer();
        scheduleScan(useCanvasStore.getState().projects, useCanvasStore.getState().deletedProjects, 0);
    })();

    return () => {
        disposeFns.forEach((fn) => fn());
        disposeFns = [];
        if (debounceTimer) clearTimeout(debounceTimer);
        if (retryTimer) clearTimeout(retryTimer);
        debounceTimer = null;
        retryTimer = null;
        started = false;
    };
}

/**
 * 基线拉取：拿服务端列表与本地比对。
 *
 * 只在"本地没有这份画布"时才去取详情（`GET /api/canvases/:id` 带整份 doc，比较贵）。
 * 本地已有的画布一律**以本地为准**，只把服务端 revision 记下来当 baseRevision ——
 * 这样既不会用旧的服务端数据覆盖用户正在画的东西，也不会因为版本号不对而假冲突。
 */
async function bootstrapFromServer(): Promise<void> {
    try {
        const payload = await transport.list();
        const local = useCanvasStore.getState();
        const localById = new Map(local.projects.map((project) => [project.id, project]));
        const deletedIds = new Set(local.deletedProjects.map((item) => item.id));

        const adopted: CanvasProject[] = [];
        let adoptedFailed = false;

        for (const summary of payload.items) {
            const existing = localById.get(summary.id);
            if (existing) {
                // 本地已有：只对齐 revision，不碰内容。
                revisions.set(summary.id, summary.revision);
                continue;
            }
            if (deletedIds.has(summary.id)) {
                // 本地删过、服务端还活着（可能另一台设备没同步删除）→ 不复活。
                continue;
            }
            try {
                const detail = await transport.detail(summary.id);
                const project = toProject(detail.canvas);
                if (!project) continue;
                revisions.set(summary.id, detail.canvas.revision);
                adopted.push(project);
            } catch {
                adoptedFailed = true;
            }
        }

        await persistRevisions();

        if (adopted.length > 0) {
            // 合并时再读一次，避免这期间用户又建了新画布。
            const latest = useCanvasStore.getState();
            const merged = [...adopted, ...latest.projects];
            useCanvasStore.getState().replaceProjects(merged, latest.deletedProjects);
        }

        if (adoptedFailed) publish({ error: "部分画布未能从服务端拉取", state: "pending" });
    } catch (error) {
        // 服务端不可达：保持本地可用，进入离线态，等 online 事件或退避重试。
        publish({ state: "offline", error: describe(error), retryAt: Date.now() + 1000 });
        scheduleRetry();
    }
}

/** 服务端 doc → 本地 `CanvasProject`（缺字段就用默认值兜住）。 */
function toProject(canvas: CanvasDetailDto): CanvasProject | null {
    const doc = canvas.doc;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    const source = doc as Partial<CanvasProject>;
    return {
        id: canvas.id,
        title: source.title || canvas.title,
        createdAt: source.createdAt || canvas.createdAt,
        updatedAt: source.updatedAt || canvas.updatedAt,
        nodes: Array.isArray(source.nodes) ? source.nodes : [],
        connections: Array.isArray(source.connections) ? source.connections : [],
        chatSessions: Array.isArray(source.chatSessions) ? source.chatSessions : [],
        activeChatId: source.activeChatId ?? null,
        backgroundMode: source.backgroundMode || "lines",
        showImageInfo: Boolean(source.showImageInfo),
        viewport: source.viewport || { x: 0, y: 0, k: 1 },
    };
}

/**
 * 这份画布是否真的需要推送。
 *
 * 三个条件同时成立才算脏：
 * 1. 对象引用和服务端已同步的那一版不同（引用比对，不做深比较）；
 * 2. 这个对象还没被排进队列（否则同一版本会被重复入队）；
 * 3. 没有未解决的冲突（冲突等用户裁决，自动重推只会再撞 409）。
 */
function needsPush(project: CanvasProject): boolean {
    if (conflicts.has(project.id)) return false;
    if (syncedRefs.get(project.id) === project) return false;
    return true;
}

/** 扫描一遍，把变了的部分排进推送队列（按需防抖）。 */
function scheduleScan(projects: CanvasProject[], deletedProjects: CanvasDeletedProject[], delay = DEBOUNCE_MS): void {
    for (const item of deletedProjects) {
        if (deletedSent.has(item.id)) continue;
        deletedSent.add(item.id);
        void pushDeletion(item.id);
    }

    const hasDirty = projects.some((project) => needsPush(project));

    if (!hasDirty) {
        publish();
        return;
    }

    dirty = true;
    publish({ state: "pending" });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void flush();
    }, delay);
}

/** 把一个画布推上去（同一画布串行）。 */
function enqueuePush(project: CanvasProject): Promise<void> {
    const previous = inflight.get(project.id) ?? Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() => pushOne(project))
        .finally(() => {
            if (inflight.get(project.id) === next) inflight.delete(project.id);
        });
    inflight.set(project.id, next);
    return next;
}

/**
 * 推送一个画布。
 *
 * 成功后记下"这个对象引用已经同步过"，因此**对象没换过就再也不会被扫出来**
 * —— 这就是引用比对的全部魔法。
 */
async function pushOne(project: CanvasProject): Promise<void> {
    if (!needsPush(project)) return;
    if (queuedRefs.get(project.id) === project && syncedRefs.get(project.id) === project) return;

    publish({ state: "syncing" });
    try {
        const result = await transport.put(project.id, {
            baseRevision: baseRevisionFor(project.id),
            doc: project,
            title: project.title,
        });

        revisions.set(project.id, result.canvas.revision);
        syncedRefs.set(project.id, project);
        queuedRefs.set(project.id, project);
        conflicts.delete(project.id);

        backoffMs = 0;
        void persistRevisions();
        publish({ state: "idle", error: null, retryAt: null, lastSyncedAt: new Date().toISOString() });
    } catch (error) {
        if (error instanceof ServerApiError && error.status === 409) {
            registerConflict(project, error);
            return;
        }
        // 网络 / 5xx：退避重试，绝不清本地数据。
        publish({ state: "offline", error: describe(error) });
        scheduleRetry();
    }
}

/** 409 → 记下冲突（不覆盖任何一侧）。 */
function registerConflict(project: CanvasProject, error: ServerApiError): void {
    const details = (error.details ?? {}) as Record<string, unknown>;
    const latestDoc = details.latestDoc;
    const remoteRevision = typeof details.latestRevision === "number" ? details.latestRevision : (revisions.get(project.id) ?? 0) + 1;
    const remote = latestDoc && typeof latestDoc === "object" && !Array.isArray(latestDoc) ? (latestDoc as Partial<CanvasProject>) : null;

    conflicts.set(project.id, {
        canvasId: project.id,
        title: project.title,
        localUpdatedAt: project.updatedAt,
        localNodeCount: project.nodes.length,
        remoteUpdatedAt: remote?.updatedAt ?? new Date().toISOString(),
        remoteNodeCount: Array.isArray(remote?.nodes) ? remote.nodes.length : 0,
        remoteRevision,
        latestDoc,
    });

    publish({ state: "conflict", retryAt: null });
}

/** 删除一个画布（幂等：404 视为已删除）。 */
async function pushDeletion(canvasId: string): Promise<void> {
    try {
        await transport.remove(canvasId);
    } catch (error) {
        if (error instanceof ServerApiError && error.status === 404) {
            // 已经是删除状态，正常。
        } else {
            deletedSent.delete(canvasId);
            publish({ state: "offline", error: describe(error) });
            scheduleRetry();
        }
    } finally {
        revisions.delete(canvasId);
        syncedRefs.delete(canvasId);
        queuedRefs.delete(canvasId);
        conflicts.delete(canvasId);
        void persistRevisions();
    }
}

/** 退避重试（1→2→4→…≤30s）。 */
function scheduleRetry(): void {
    if (retryTimer) return;
    backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    const delay = backoffMs;
    publish({ retryAt: Date.now() + delay });
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void flush();
    }, delay);
}

/** 立刻把当前所有脏画布推一遍（测试 / 关闭页面前调用）。 */
export async function flushCanvasSync(): Promise<void> {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    const state = useCanvasStore.getState();
    // 冲突中的画布被 `needsPush` 滤掉 —— 用户还没选，不能偷偷重推。
    const dirtyProjects = state.projects.filter((project) => needsPush(project));
    if (dirtyProjects.length === 0) {
        dirty = false;
        publish();
        return;
    }

    publish({ state: "syncing" });
    await Promise.all(dirtyProjects.map((project) => enqueuePush(project)));
    dirty = state.projects.some((project) => needsPush(project));
    publish();
}

/** 内部 flush（供定时器调用）。 */
async function flush(): Promise<void> {
    await flushCanvasSync();
}

/**
 * 切回标签页时探一次版本（轻量，不读 doc）。
 *
 * 只做判断不自动覆盖：服务端 revision 比本地记录的新，说明**另一端改过**，
 * 这时把状态标成冲突候选，交给用户决定（自动拉取会毁掉正在编辑的内容）。
 */
async function probeRevisions(): Promise<void> {
    const projects = useCanvasStore.getState().projects;
    let stale = false;
    for (const project of projects) {
        const known = revisions.get(project.id);
        if (known === undefined) continue;
        try {
            const current = await transport.revision(project.id);
            if (current.revision > known) {
                stale = true;
                registerConflict(
                    project,
                    new ServerApiError("REVISION_CONFLICT", "另一端已更新画布", 409, {
                        latestRevision: current.revision,
                        // 只探测 revision 拿不到 doc；弹窗里"保留服务端"会再取一次详情。
                        latestDoc: undefined,
                    }),
                );
            }
        } catch {
            // 探测失败不算错误（离线/刚启动都可能），下一次再探。
        }
    }
    if (!stale) publish();
}

/**
 * 解决冲突。
 *
 * - `"local"`：以本机为准覆盖服务端（baseRevision 用服务端最新版本，绕过 CAS）；
 * - `"remote"`：丢弃本机改动，整份换成服务端 doc。
 *
 * 两种情况都会把 revision 对齐，避免下一次保存继续 409。
 */
export async function resolveCanvasConflict(canvasId: string, choice: "local" | "remote"): Promise<void> {
    const conflict = conflicts.get(canvasId);
    if (!conflict) return;

    revisions.set(canvasId, conflict.remoteRevision);

    if (choice === "remote") {
        let canvas: CanvasDetailDto | null = null;
        if (conflict.latestDoc) {
            // 409 场景：服务端已经在 `details.latestDoc` 里给了整份 doc。
            canvas = {
                id: canvasId,
                title: conflict.title,
                revision: conflict.remoteRevision,
                nodeCount: conflict.remoteNodeCount,
                createdAt: conflict.remoteUpdatedAt,
                updatedAt: conflict.remoteUpdatedAt,
                doc: conflict.latestDoc,
                updatedByDevice: null,
            };
        } else {
            // 冲突来自 revision 探测（没带 doc），这里补一次详情。
            const detail = await transport.detail(canvasId);
            canvas = detail.canvas;
            revisions.set(canvasId, detail.canvas.revision);
        }
        const project = toProject(canvas);
        const state = useCanvasStore.getState();
        if (project) {
            const next = state.projects.some((item) => item.id === canvasId) ? state.projects.map((item) => (item.id === canvasId ? project : item)) : [project, ...state.projects];
            syncedRefs.set(canvasId, project);
            useCanvasStore.getState().replaceProjects(next, state.deletedProjects);
        }
        conflicts.delete(canvasId);
        await persistRevisions();
        publish({ state: "idle", error: null });
        return;
    }

    // 以本机为准：拿服务端最新 revision 当 baseRevision 再推一次。
    const project = useCanvasStore.getState().projects.find((item) => item.id === canvasId);
    conflicts.delete(canvasId);
    await persistRevisions();
    if (!project) {
        publish({ state: "idle" });
        return;
    }
    syncedRefs.delete(canvasId);
    await enqueuePush(project);
}

/** 把异常翻译成人话（不把堆栈丢给 UI）。 */
function describe(error: unknown): string {
    if (error instanceof ServerApiError) return error.message;
    return error instanceof Error ? error.message : "同步失败";
}

/** 当前是否还有未推送的改动（测试用）。 */
export function hasPendingCanvasChanges(): boolean {
    return dirty;
}
