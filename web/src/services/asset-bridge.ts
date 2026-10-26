/**
 * asset-bridge —— 本地 Blob ↔ 服务端资产的桥（T04-A4）。
 *
 * 背景：改造前所有图片/视频/音频都只存在浏览器 IndexedDB 里，`storageKey` 是个"本地代号"，
 * 换设备打开画布只能看到一片碎图。上云之后服务端成为**权威副本**，本地降级成两级缓存
 * （首屏秒开 + 离线可用）。
 *
 * 本模块只做四件事，供 `image-storage.ts` / `file-storage.ts` 共用（不重复实现）：
 *   1. `serverAssetUrl()`  —— 由 storageKey 拼出同源可渲染地址（同步、无 IO）；
 *   2. `putServerAsset()`  —— 上传一份 Blob，失败返回 `null`（调用方继续用本地 URL）；
 *   3. `scheduleAssetMigration()` —— 懒迁移：渲染到某张老图时，后台把它补传上去；
 *   4. `fetchStoredAssetBlob()` —— 本地优先、服务端兜底地取回字节（导出 / 当参考图）。
 *
 * 为什么懒迁移而不是启动时全量迁移：
 * 历史数据可能有几百 MB，启动即跑会把首屏一起拖死；而用户真正会看到的
 * 只有"当前画布里的那几张"，按需迁移的性价比高得多。
 */

import { apiUpload } from "@/services/server-api";
import { serverFetch } from "@/services/server-fetch";

/** 上传后的服务端资产 DTO（只取本模块用得到的字段）。 */
type ServerAssetDto = { storageKey: string; url: string; mime: string; bytes: number };

/** 已确认存在于服务端的资产 key（会话内记忆，避免重复 HEAD）。 */
const serverAssets = new Set<string>();

/** 已完成懒迁移的资产 key —— 这些 key 的 URL 会多带一个 `ready=1`。 */
const migratedAssets = new Set<string>();

/** 正在迁移中的 key → Promise（同一 key 只跑一次）。 */
const migratingAssets = new Map<string, Promise<void>>();

/** 迁移并发上限：同时最多 4 个 HEAD/上传，避免打开大画布时打爆网络。 */
const MAX_CONCURRENT_MIGRATIONS = 4;
let activeMigrations = 0;

/** 服务端资产地址（同源，`<img src>` / `<video src>` 可直接用，Cookie 自动带）。 */
export function serverAssetUrl(storageKey: string): string {
    const base = `/api/assets/raw?key=${encodeURIComponent(storageKey)}`;
    // `ready=1` 只有一个作用：迁移完成后让 URL 变一下，
    // 逼 React 重新设置 src，把迁移前那个 404 盖掉。
    return migratedAssets.has(storageKey) ? `${base}&ready=1` : base;
}

/** 该 key 是否确认已在服务端。 */
export function isServerAsset(storageKey: string): boolean {
    return serverAssets.has(storageKey);
}

/**
 * 上传一份资产。
 *
 * 刻意**不抛异常**：资产上传失败不该让"生成图片成功"变成"生成失败"。
 * 本地 Blob 还在，用户当下能看能导出，下次打开画布懒迁移会再试一次。
 */
export async function putServerAsset(storageKey: string, blob: Blob, canvasId?: string): Promise<string | null> {
    try {
        const query = `key=${encodeURIComponent(storageKey)}${canvasId ? `&canvasId=${encodeURIComponent(canvasId)}` : ""}`;
        const result = await apiUpload<{ asset: ServerAssetDto }>(`/api/assets?${query}`, blob, blob.type || "application/octet-stream");
        serverAssets.add(storageKey);
        return result.asset.url;
    } catch {
        return null;
    }
}

/**
 * 懒迁移一个 key（如果它只在本地）。
 *
 * @param storageKey 资产 key
 * @param loadLocal 从本地存储读 Blob（读不到就放弃）
 * @param onMigrated 迁移成功后的回调（用来触发一次界面重渲染）
 */
export function scheduleAssetMigration(storageKey: string, loadLocal: () => Promise<Blob | null>, onMigrated: () => void): void {
    if (serverAssets.has(storageKey) || migratingAssets.has(storageKey)) return;
    if (activeMigrations >= MAX_CONCURRENT_MIGRATIONS) return;

    activeMigrations += 1;
    const task = (async () => {
        try {
            // 先问服务端：已经有（200/304）就不用白传一遍。
            const head = await serverFetch(serverAssetUrl(storageKey), { method: "HEAD" });
            if (head.ok) {
                serverAssets.add(storageKey);
                return;
            }
            if (head.status !== 404) return;

            const blob = await loadLocal();
            if (!blob) return;
            if (!(await putServerAsset(storageKey, blob))) return;

            migratedAssets.add(storageKey);
            onMigrated();
        } catch {
            // 迁移是尽力而为：离线、服务端没起、权限不足都不该冒泡到 UI。
        } finally {
            migratingAssets.delete(storageKey);
            activeMigrations -= 1;
        }
    })();

    migratingAssets.set(storageKey, task);
}

/**
 * 取一份资产字节：本地优先，服务端兜底。
 *
 * 本地命中的意义是"零网络"（导出当前画布、把图片当参考图再生成一次都很常见）；
 * 本地没有则是换设备/清缓存的场景，此时服务端副本是唯一来源。
 */
export async function fetchStoredAssetBlob(storageKey: string, loadLocal: () => Promise<Blob | null>): Promise<Blob | null> {
    const local = await loadLocal().catch(() => null);
    if (local) return local;
    try {
        const response = await serverFetch(serverAssetUrl(storageKey));
        if (!response.ok) return null;
        return await response.blob();
    } catch {
        return null;
    }
}
