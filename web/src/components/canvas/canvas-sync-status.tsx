/**
 * 画布同步状态 UI（T04-A8）。
 *
 * 三块：
 * 1. `CanvasSyncPill` —— 顶栏那颗小药丸（已同步 / 同步中 / 未同步(N) / 冲突 / 离线）；
 * 2. `CanvasSyncDot` —— 画布列表卡片上的小圆点（同一份状态，尺寸更小）；
 * 3. `CanvasSyncBootstrap` —— 启动同步引擎 + 冲突弹窗宿主（挂在 `ClientRootInit` 里）。
 *
 * 全部状态都来自 `canvas-server-sync` 的快照订阅（`useSyncExternalStore`），
 * 组件不持有自己的副本，也不做轮询 —— 引擎那边一旦变了这边立刻重渲染。
 */

import { Alert, App, Button, Modal, Space, Tag, Tooltip } from "antd";
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import {
    getCanvasConflict,
    getCanvasSyncSnapshot,
    hasPendingCanvasChanges,
    resolveCanvasConflict,
    startCanvasServerSync,
    subscribeCanvasSync,
    type CanvasSyncState,
} from "@/services/canvas-server-sync";

/** 订阅同步快照。 */
export function useCanvasSyncSnapshot() {
    return useSyncExternalStore(subscribeCanvasSync, getCanvasSyncSnapshot, getCanvasSyncSnapshot);
}

/** 状态 → i18n key。 */
function stateKey(state: CanvasSyncState): string {
    switch (state) {
        case "syncing":
            return "canvas.sync.state.syncing";
        case "pending":
            return "canvas.sync.state.pending";
        case "conflict":
            return "canvas.sync.state.conflict";
        case "offline":
            return "canvas.sync.state.offline";
        default:
            return "canvas.sync.state.idle";
    }
}

/** 状态 → 小圆点颜色。 */
function dotClass(state: CanvasSyncState): string {
    switch (state) {
        case "syncing":
            return "bg-sky-500 animate-pulse";
        case "pending":
            return "bg-amber-500";
        case "conflict":
            return "bg-red-500";
        case "offline":
            return "bg-stone-400";
        default:
            return "bg-emerald-500";
    }
}

/** 顶栏药丸。 */
export function CanvasSyncPill() {
    const { t } = useTranslation();
    const snapshot = useCanvasSyncSnapshot();
    const label = t(stateKey(snapshot.state), { count: snapshot.pending });
    const detail = snapshot.error ?? (snapshot.lastSyncedAt ? t("canvas.sync.lastSyncedAt", { time: new Date(snapshot.lastSyncedAt).toLocaleTimeString() }) : t("canvas.sync.neverSynced"));

    return (
        <Tooltip title={detail}>
            <Tag
                className="!mr-0 inline-flex items-center gap-1.5 !rounded-full !px-2.5 !py-0.5 !text-xs"
                color={snapshot.state === "conflict" ? "red" : snapshot.state === "offline" ? "default" : snapshot.state === "idle" ? "green" : "blue"}
            >
                <SyncIcon state={snapshot.state} />
                <span className="whitespace-nowrap">{label}</span>
            </Tag>
        </Tooltip>
    );
}

/** 药丸里的小图标。 */
function SyncIcon({ state }: { state: CanvasSyncState }) {
    if (state === "syncing") return <Loader2 className="size-3 animate-spin" />;
    if (state === "conflict") return <AlertTriangle className="size-3" />;
    if (state === "offline") return <CloudOff className="size-3" />;
    if (state === "pending") return <RefreshCw className="size-3" />;
    return <CheckCircle2 className="size-3" />;
}

/** 列表卡片上的小圆点（不带文字，靠 tooltip 解释）。 */
export function CanvasSyncDot() {
    const { t } = useTranslation();
    const snapshot = useCanvasSyncSnapshot();
    return (
        <Tooltip title={t(stateKey(snapshot.state), { count: snapshot.pending })}>
            <span className={`inline-block size-2 rounded-full ${dotClass(snapshot.state)}`} aria-label={t("canvas.sync.dotAria")} />
        </Tooltip>
    );
}

/**
 * 同步引擎宿主：启动引擎 + 冲突弹窗。
 *
 * 挂在 `ClientRootInit`（App 上下文内），因此弹窗/提示都能用 antd 的 `App.useApp()`。
 */
export function CanvasSyncBootstrap() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const snapshot = useCanvasSyncSnapshot();
    const [openId, setOpenId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => startCanvasServerSync(), []);

    // 有新冲突时自动弹窗（一次只处理一个，处理完如果还有会继续弹）。
    useEffect(() => {
        if (!openId && snapshot.conflicts.length > 0) setOpenId(snapshot.conflicts[0]);
    }, [openId, snapshot.conflicts]);

    const conflict = useMemo(() => (openId ? getCanvasConflict(openId) : null), [openId, snapshot.conflicts]);

    const resolve = async (choice: "local" | "remote") => {
        if (!openId) return;
        setBusy(true);
        try {
            await resolveCanvasConflict(openId, choice);
            message.success(t(choice === "local" ? "canvas.sync.conflict.keptLocal" : "canvas.sync.conflict.keptRemote"));
            setOpenId(null);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.sync.conflict.failed"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={Boolean(conflict)}
            title={t("canvas.sync.conflict.title")}
            closable={false}
            maskClosable={false}
            footer={
                <Space>
                    <Button danger loading={busy} onClick={() => void resolve("remote")}>
                        {t("canvas.sync.conflict.useRemote")}
                    </Button>
                    <Button type="primary" loading={busy} onClick={() => void resolve("local")}>
                        {t("canvas.sync.conflict.keepLocal")}
                    </Button>
                </Space>
            }
        >
            {conflict ? (
                <div className="space-y-3">
                    <Alert type="warning" showIcon message={t("canvas.sync.conflict.description", { title: conflict.title })} />
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="mb-1 font-semibold text-foreground">{t("canvas.sync.conflict.local")}</div>
                            <div className="text-stone-500">{t("canvas.sync.conflict.updatedAt", { time: new Date(conflict.localUpdatedAt).toLocaleString() })}</div>
                            <div className="text-stone-500">{t("canvas.sync.conflict.nodes", { count: conflict.localNodeCount })}</div>
                        </div>
                        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="mb-1 font-semibold text-foreground">{t("canvas.sync.conflict.remote")}</div>
                            <div className="text-stone-500">{t("canvas.sync.conflict.updatedAt", { time: new Date(conflict.remoteUpdatedAt).toLocaleString() })}</div>
                            <div className="text-stone-500">{t("canvas.sync.conflict.nodes", { count: conflict.remoteNodeCount })}</div>
                            <div className="text-stone-500">{t("canvas.sync.conflict.revision", { revision: conflict.remoteRevision })}</div>
                        </div>
                    </div>
                    <div className="text-xs text-stone-500">{t("canvas.sync.conflict.manualNote")}</div>
                    {hasPendingCanvasChanges() ? <div className="text-xs text-amber-600">{t("canvas.sync.conflict.pendingNote")}</div> : null}
                </div>
            ) : null}
        </Modal>
    );
}
