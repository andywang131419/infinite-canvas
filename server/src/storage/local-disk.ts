/**
 * 本地磁盘驱动 —— T02 唯一实现（`STORAGE_LOCAL_ROOT` 默认 `/data/media`）。
 *
 * 落盘布局（内容寻址，ARCH Rev2 §R4.2）：
 *   {root}/{yyyy}/{mm}/{sha256}.{ext}
 *   例：/data/media/2026/10/9f2c...c1.png
 *
 * 三个必须做到的点：
 * 1. **去重**：先 `stat`，已存在则不重复写（同一张图被 20 个节点引用时只占一份磁盘）。
 * 2. **原子写**：先写同目录下的 `.<sha256>.tmp-<rand>`，再 `rename` ——
 *    避免"进程在写一半时被杀"留下半张图，而半张图会因为内容寻址被误认为合法对象。
 * 3. **路径二次校验**：即便上层已用 `parseStorageKey` 挡过一遍，这里仍然
 *    对拼接结果做 `resolve` + `startsWith(root)` 断言，双保险防穿越。
 *
 * 说明：本文件的两处本地 import **带 `.ts` 后缀**。
 * 原因是 `scripts/verify-t02.mjs` 用 Node 的类型剥离直接 import 本文件跑真磁盘测试
 * （本机没有 Bun），而 Node 的 ESM 解析器不做"无后缀 → .ts"的补全。
 * tsconfig 已开启 `allowImportingTsExtensions`，Bun 也接受带后缀的写法，两边都成立。
 */

import { createReadStream, statSync } from "node:fs";
import { mkdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";

import { deriveObjectRelPath, isSafeRelPath, mimeFromExtension } from "./key.ts";
import {
    type ByteRange,
    type ObjectBody,
    type ObjectStat,
    type PutObjectInput,
    type PutObjectResult,
    type StorageDriver,
    type StorageDriverName,
    StorageObjectNotFoundError,
    StorageRangeError,
    StorageWriteError,
} from "./types.ts";

/** 本地磁盘驱动。 */
export class LocalDiskDriver implements StorageDriver {
    readonly name: StorageDriverName = "local";
    readonly root: string;

    /**
     * @param root 存储根目录绝对路径（`STORAGE_LOCAL_ROOT`）。
     */
    constructor(root: string) {
        this.root = resolve(root);
    }

    /** 写入（内容寻址 + 去重 + 原子 rename）。 */
    async put(input: PutObjectInput): Promise<PutObjectResult> {
        const createdAt = input.createdAt ?? new Date().toISOString();
        const sha256 = sha256Hex(input.bytes);
        const relPath = deriveObjectRelPath({ sha256, mime: input.mime, createdAt });
        const absolute = this.absolutePath(relPath);

        const existing = await this.stat(relPath);
        if (existing) {
            return { relPath, sha256, bytes: existing.bytes, mime: resolveMime(input.mime, relPath), deduplicated: true };
        }

        try {
            await mkdir(dirname(absolute), { recursive: true });

            // 原子写：同目录临时文件 → rename（同分区 rename 是原子操作）。
            const temp = join(dirname(absolute), `.${sha256}.tmp-${randomBytes(6).toString("hex")}`);
            try {
                await writeFile(temp, input.bytes);
                await rename(temp, absolute);
            } catch (error) {
                // 临时文件写失败/rename 失败都要清理，避免污染媒体目录。
                await unlink(temp).catch(() => undefined);
                throw error;
            }
        } catch (error) {
            throw new StorageWriteError(`写盘失败：${relPath}（${error instanceof Error ? error.message : String(error)}）`, error);
        }

        return { relPath, sha256, bytes: input.bytes.byteLength, mime: resolveMime(input.mime, relPath), deduplicated: false };
    }

    /** 查元信息。 */
    async stat(relPath: string): Promise<ObjectStat | null> {
        const absolute = this.absolutePath(relPath);
        try {
            const info = await stat(absolute);
            if (!info.isFile()) return null;
            return { relPath, bytes: info.size, modifiedAt: info.mtime.toISOString() };
        } catch {
            return null;
        }
    }

    /**
     * 读取（支持 Range）。
     *
     * 用 `createReadStream({ start, end })` 而不是"整文件读进内存"：
     * 200MB 视频若整读会直接把容器内存打满。`end` 是**闭**区间，故传 `end - 1`。
     */
    async get(relPath: string, range?: ByteRange): Promise<ObjectBody> {
        const absolute = this.absolutePath(relPath);
        const info = await this.stat(relPath);
        if (!info) throw new StorageObjectNotFoundError(relPath);

        const size = info.bytes;
        const resolved = normalizeRange(range, size);

        const nodeStream = createReadStream(absolute, {
            start: resolved.start,
            end: resolved.end === undefined ? undefined : resolved.end - 1,
        });

        // 显式监听 error：Readable.toWeb 的流在底层报错时会 reject，
        // 但提前绑定可避免"未处理的 error 事件"导致进程崩溃。
        nodeStream.on("error", () => undefined);

        return {
            bytes: (resolved.end ?? size) - resolved.start,
            range: resolved,
            // `Readable.toWeb` 在 @types/node 里返回 `ReadableStream<any>`，
            // 与 Bun/DOM 的 `ReadableStream<Uint8Array>` 属于不同声明来源，
            // 直接 `as` 会被 TS 判定为"可能误转"，故先过 unknown。
            stream: Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>,
        };
    }

    /** 删除（幂等）。 */
    async delete(relPath: string): Promise<void> {
        const absolute = this.absolutePath(relPath);
        try {
            await rm(absolute, { force: true });
        } catch (error) {
            // force 已经吞掉 ENOENT；其余错误（权限等）上抛，让调用方知道没删掉。
            throw new StorageWriteError(`删除失败：${relPath}`, error);
        }
    }

    /** 同步判断对象是否存在（供备份脚本/健康检查用）。 */
    existsSync(relPath: string): boolean {
        try {
            return statSync(this.absolutePath(relPath)).isFile();
        } catch {
            return false;
        }
    }

    /**
     * 相对路径 → 绝对路径，并**再次**断言没有逃出根目录。
     *
     * 这两行是本文件最关键的安全边界：
     * `resolve(root, relPath)` 会把 `../..` 规范化掉，随后 `startsWith(root + sep)`
     * 就能识别出"跑出去了"。任何异常一律按程序错误抛出（500），
     * 因为到这里还能拿到穿越路径，说明上游校验已被绕过。
     */
    private absolutePath(relPath: string): string {
        if (!isSafeRelPath(relPath)) {
            throw new StorageWriteError(`非法相对路径：${relPath}`);
        }

        const absolute = resolve(this.root, relPath);
        if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
            throw new StorageWriteError(`路径逃逸出存储根目录：${relPath}`);
        }
        return absolute;
    }
}

/**
 * 归一化区间，越界抛 {@link StorageRangeError}。
 *
 * 规则（RFC 7233）：
 * - 无 range → `[0, undefined)`（整份）
 * - `start >= size` → 416
 * - `end` 超出 → 截到 `size`
 * - `end <= start` → 416
 */
export function normalizeRange(range: ByteRange | undefined, size: number): ByteRange {
    if (!range) return { start: 0, end: undefined };

    const start = Math.trunc(range.start);
    if (!Number.isFinite(start) || start < 0 || start >= size) {
        throw new StorageRangeError(size, range);
    }

    if (range.end === undefined) return { start, end: undefined };

    const end = Math.min(Math.trunc(range.end), size);
    if (!Number.isFinite(end) || end <= start) {
        throw new StorageRangeError(size, range);
    }

    return { start, end };
}

/** sha256（十六进制）。 */
function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * MIME 兜底：客户端可能传 `application/octet-stream` 或空，
 * 此时按扩展名反推，避免存进库里的 mime 全是 octet-stream。
 */
function resolveMime(declared: string, relPath: string): string {
    const normalized = (declared || "").split(";")[0]!.trim().toLowerCase();
    if (normalized.length > 0 && normalized !== "application/octet-stream") return normalized;

    const ext = relPath.slice(relPath.lastIndexOf(".") + 1);
    return mimeFromExtension(ext);
}
