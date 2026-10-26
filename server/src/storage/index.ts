/**
 * 存储驱动工厂。
 *
 * 进程级单例：驱动持有根目录与（未来）云厂商 SDK 客户端，重复 new 没有意义。
 * `STORAGE_DRIVER` 目前只允许 `local`；其余取值在 env 校验阶段已通过枚举，
 * 但实现未到位时会**明确抛错**而不是静默降级到 local ——
 * 静默降级会让"以为存进了 COS，其实存在本地盘"这种事故变得难以发现。
 */

import { getEnv } from "../env";
import { LocalDiskDriver } from "./local-disk";
import { type StorageDriver } from "./types";

let cached: StorageDriver | null = null;

/** 取当前存储驱动（首次调用时按 env 构建）。 */
export function getStorageDriver(): StorageDriver {
    if (cached) return cached;

    const env = getEnv();
    switch (env.STORAGE_DRIVER) {
        case "local":
            cached = new LocalDiskDriver(env.STORAGE_LOCAL_ROOT);
            return cached;
        case "cos":
        case "oss":
        case "minio":
            throw new Error(`STORAGE_DRIVER=${env.STORAGE_DRIVER} 尚未实现（T02 仅支持 local），请改用 local 或等待后续任务`);
        default: {
            // 穷尽性检查：新增驱动时 TS 会在这里报错，提醒同步实现。
            const exhaustive: never = env.STORAGE_DRIVER;
            throw new Error(`未知 STORAGE_DRIVER：${String(exhaustive)}`);
        }
    }
}

/** 仅在测试中使用：重置单例。 */
export function resetStorageDriver(): void {
    cached = null;
}
