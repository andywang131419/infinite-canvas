/**
 * 对象存储驱动接口（ARCH Rev2 §R4.2）。
 *
 * T02 只实现 `LocalDiskDriver`（`/data/media`）；
 * `cos` / `oss` / `minio` 在 T06+ 按同一接口补齐，业务代码零改动。
 *
 * 为什么接口是"路径式"而不是"key 式"：
 * storageKey（`image:xxx`）是**逻辑键**，由 assets 表负责映射；
 * 驱动层只认**内容寻址的相对路径**（`2026/10/<sha256>.png`）。
 * 这条边界保证：任何来自用户的 key 都不会进入文件系统调用（见 `key.ts` 顶部说明）。
 */

/** 驱动名，与 `assets.storage_driver` 的 CHECK 约束一致。 */
export type StorageDriverName = "local" | "cos" | "oss" | "minio";

/** 写入入参。 */
export type PutObjectInput = {
    /** 原始字节。 */
    bytes: Uint8Array;
    /** MIME（决定扩展名）。 */
    mime: string;
    /** 时间基准，决定 `{yyyy}/{mm}` 分桶；默认当前时间。 */
    createdAt?: string;
};

/** 写入结果。 */
export type PutObjectResult = {
    /** 内容寻址相对路径，例如 `2026/10/<sha256>.png`。 */
    relPath: string;
    /** 内容 sha256（64 位小写十六进制）。 */
    sha256: string;
    /** 字节数。 */
    bytes: number;
    /** 落库时使用的 MIME。 */
    mime: string;
    /** 该对象此前是否已存在（内容去重命中）。 */
    deduplicated: boolean;
};

/** 对象元信息。 */
export type ObjectStat = {
    relPath: string;
    bytes: number;
    /** 文件最后修改时间（ISO8601）。 */
    modifiedAt: string;
};

/** 字节区间（闭开区间 `[start, end)`，与 HTTP Range 语义一致）。 */
export type ByteRange = {
    start: number;
    /** 结束位置（不含）；`undefined` 表示到文件末尾。 */
    end?: number;
};

/** 读取结果。 */
export type ObjectBody = {
    /** 实际返回的字节数。 */
    bytes: number;
    /** 本次响应对应的区间。 */
    range: ByteRange;
    /** 可流式消费的响应体。 */
    stream: ReadableStream<Uint8Array>;
};

/**
 * 存储驱动。
 *
 * 实现者需保证：
 * - `put` 幂等（同一内容重复写不报错、不产生第二份文件）；
 * - `get` 支持 `ByteRange`，越界时抛 `StorageRangeError`；
 * - `delete` 幂等（不存在也返回成功）；
 * - 所有路径入参都经过 `isSafeRelPath` 二次校验（拿不到根目录之外的路径）。
 */
export interface StorageDriver {
    /** 驱动名。 */
    readonly name: StorageDriverName;
    /** 根目录（本地驱动为绝对路径；云驱动为 bucket 前缀，仅用于日志）。 */
    readonly root: string;
    /** 写入（内容寻址 + 去重）。 */
    put(input: PutObjectInput): Promise<PutObjectResult>;
    /** 查元信息；不存在返回 `null`。 */
    stat(relPath: string): Promise<ObjectStat | null>;
    /** 读取（支持区间）。 */
    get(relPath: string, range?: ByteRange): Promise<ObjectBody>;
    /** 删除（幂等）。 */
    delete(relPath: string): Promise<void>;
}

/** 区间非法（`start < 0` 或 `start >= size` 或 `end < start`）。http 层转 416。 */
export class StorageRangeError extends Error {
    readonly size: number;
    readonly requested: ByteRange;

    constructor(size: number, requested: ByteRange) {
        super(`Range 不可满足：size=${size}, start=${requested.start}, end=${requested.end ?? "EOF"}`);
        this.name = "StorageRangeError";
        this.size = size;
        this.requested = requested;
    }
}

/** 对象不存在。http 层转 404。 */
export class StorageObjectNotFoundError extends Error {
    readonly relPath: string;

    constructor(relPath: string) {
        super(`对象不存在：${relPath}`);
        this.name = "StorageObjectNotFoundError";
        this.relPath = relPath;
    }
}

/** 驱动写盘失败。http 层转 500 `STORAGE_WRITE_FAILED`。 */
export class StorageWriteError extends Error {
    /** 原始异常（不叫 `cause`，避免与 ES2022 `Error.cause` 的声明冲突）。 */
    readonly detail?: unknown;

    constructor(message: string, detail?: unknown) {
        super(message);
        this.name = "StorageWriteError";
        this.detail = detail;
    }
}
