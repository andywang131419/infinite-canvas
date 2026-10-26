/**
 * file-storage —— 视频 / 音频 / 通用附件的本地 + 服务端双层存储（T04-A4）。
 *
 * 与 `image-storage.ts` 同构：
 * - 本地 IndexedDB 保留一份 Blob（首屏秒开、离线可用、当参考图时零网络）；
 * - **同时**上传一份到服务端 `/api/assets`，渲染地址改用同源 `/api/assets/raw?key=...`
 *   —— 这样换设备打开画布也能出画面，不再是"本地有、别人那里是碎图"。
 *
 * 服务端地址是权威的：`resolveMediaUrl` 不再碰 IndexedDB（同步返回），
 * 只在后台排一次懒迁移把历史数据补传上去（见 `asset-bridge.ts`）。
 */

import localforage from "localforage";
import { nanoid } from "nanoid";

import { fetchStoredAssetBlob, putServerAsset, scheduleAssetMigration, serverAssetUrl } from "@/services/asset-bridge";
import { serverFetch } from "@/services/server-fetch";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();
const mediaListeners = new Set<() => void>();
let mediaRevision = 0;

/** 媒体资产迁移完成后通知界面重渲染（URL 会从 `?key=` 变成 `?key=&ready=1`）。 */
function notifyAssetMigrated(): void {
    mediaRevision += 1;
    mediaListeners.forEach((listener) => listener());
}

/** 订阅媒体资产迁移事件（用于让已有节点重新取图）。 */
export function subscribeMediaAssets(listener: () => void) {
    mediaListeners.add(listener);
    return () => {
        mediaListeners.delete(listener);
    };
}

/** 媒体资产版本号（配合 `useSyncExternalStore` 或普通 useState 强制重渲染）。 */
export function getMediaAssetRevision(): number {
    return mediaRevision;
}

/** 懒迁移一个媒体 key（只在本地有、服务端没有时才会真的上传）。 */
function migrateLocalMedia(storageKey: string): void {
    scheduleAssetMigration(storageKey, () => store.getItem<Blob>(storageKey), notifyAssetMigrated);
}

/**
 * 保存一份媒体文件。
 *
 * @param input 远端 URL（会被服务端代理取回）或现成的 Blob
 * @param prefix 存储命名空间：`video` / `audio` / `file`
 */
export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await serverFetch(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);

    const localUrl = URL.createObjectURL(blob);
    objectUrls.set(storageKey, localUrl);

    // 元数据（宽高/时长）必须靠本地 object URL 读 —— 服务端没有解码能力，
    // 而且这一步是同步可用的，不会因为上传失败而拿不到尺寸。
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(localUrl) : blob.type.startsWith("audio/") ? await readAudioMeta(localUrl) : {};

    const serverUrl = await putServerAsset(storageKey, blob);
    return { url: serverUrl ?? localUrl, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

/**
 * 由 storageKey 解析可播放地址。
 *
 * 有 key → 直接给服务端同源地址（同步、无 IO），并后台排一次懒迁移；
 * 没有 key → 回落到调用方给的 fallback（通常是历史数据里的远端 URL）。
 */
export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    if (!storageKey.includes(":")) return fallback;
    migrateLocalMedia(storageKey);
    return serverAssetUrl(storageKey);
}

/** 取本地 Blob（不做网络回源；需要"本地优先 + 服务端兜底"请用 `fetchStoredMediaBlob`）。 */
export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

/** 取一份媒体字节：本地优先，服务端兜底（导出 / 当参考素材时用）。 */
export function fetchStoredMediaBlob(storageKey: string): Promise<Blob | null> {
    return fetchStoredAssetBlob(storageKey, () => store.getItem<Blob>(storageKey));
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const localUrl = URL.createObjectURL(blob);
    objectUrls.set(storageKey, localUrl);
    const serverUrl = await putServerAsset(storageKey, blob);
    return serverUrl ?? localUrl;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
