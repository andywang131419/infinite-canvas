/**
 * 备份「去向」相关的一小块逻辑：**审计行的 target 必须说真话**。
 *
 * 为什么单独成文件（而不是写在 `backup-service.ts` 里）：
 * 1. 这里只依赖 `node:child_process` / `../env`，**不碰数据库**。
 *    `backup-service.ts` 经 `db/client.ts` 传递依赖 `bun:sqlite`，
 *    而 `scripts/verify-*.mjs` 是跑在 Node 上的（`node:sqlite`），
 *    import 它会直接 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，等于这段逻辑永远测不到。
 *    （同理：本文件 import 内部模块必须带 `.ts` 后缀，Node 不做无后缀解析。）
 * 2. target 的取舍规则是纯函数，抽出来才能被真实执行而不是只做源码级断言。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

// 显式带 `.ts` 后缀：本项目里"会被 `scripts/verify-*.mjs` 在 Node 上直接 import"
// 的模块都这么写（`src/providers/http.ts` 同样），Node 的类型剥离不做无后缀解析。
import { getEnv } from "../env.ts";

const execFileAsync = promisify(execFile);

/** `resolveBackupTarget` 的入参。 */
export type BackupTargetInput = {
    /** `BACKUP_TARGET_LABEL`：人工指定的展示标签，非空则**原样返回**，绝不改写。 */
    label: string;
    /** `RCLONE_REMOTE`。 */
    remote: string;
    /** `RCLONE_DEST`。 */
    dest: string;
    /** 本地暂存目录 `BACKUP_STAGE_DIR`。 */
    stageDir: string;
    /**
     * 上传到底成没成：
     *   `true`  = 已确认传到远端
     *   `false` = 配了远端但**没传成**（含镜像里压根没装 rclone）
     *   `null`  = 还没轮到这一步（running 行）/ 压根没配远端
     */
    uploaded: boolean | null;
};

/**
 * 推导审计行里应该写的 `target`。
 *
 * 背景（QA R2 后续发现的同类第 3 例）：
 * 老代码是 `BACKUP_TARGET_LABEL || (RCLONE_REMOTE ? remote:dest : stageDir)`，
 * **只看配置、不看上传到底成没成**。于是「配了 RCLONE_REMOTE 但 server 镜像里
 * 没有 rclone」时，`uploadWithRclone` 吞掉 ENOENT 返回 false（这个设计是对的：
 * 本地至少有一份，不该判死这次备份），而审计行照样写 `remote:dest` + success ——
 * 看的人以为数据上了远端，实际只躺在 stageDir。**审计说谎**，与「备份失败必须
 * 可见」是同一条原则的反面，只是骗的是「传到哪了」而不是「成功了没」。
 *
 * 取舍：
 * - 人工标签优先且原样返回：那是运维显式写的，写什么就是什么，代码不替他改。
 * - 只有从 RCLONE_REMOTE **推导**出来的 target 才会在没传成时降级成 stageDir。
 *
 * @param input 见各字段注释
 * @returns 审计行要写的 target
 */
export function resolveBackupTarget(input: BackupTargetInput): string {
    if (input.label) return input.label;
    // uploaded === null 表示「还没轮到上传」（running 行）：此时写**意图**目的地。
    if (input.remote && input.uploaded !== false) return `${input.remote}:${input.dest}`;
    return input.stageDir;
}

/**
 * 把 stage 目录上传到 rclone 远端。
 *
 * 配了远端才做；**没装 rclone 不算失败**（ENOENT → false）—— 本地至少有一份，
 * 不该因为缺一个可选二进制就把整次备份判死。真相由 `uploaded` 列与
 * `resolveBackupTarget` 的降级共同承担，不靠"抛错"表达。
 *
 * @param stageDir 本地暂存目录
 * @returns 是否真的传到了远端；没配远端一律 false
 * @throws 上传过程出错（除"命令不存在"外）时抛出，由调用方记 failed
 */
export async function uploadWithRclone(stageDir: string): Promise<boolean> {
    const env = getEnv();
    if (!env.RCLONE_REMOTE) return false;

    try {
        await execFileAsync(
            "rclone",
            ["copy", stageDir, `${env.RCLONE_REMOTE}:${env.RCLONE_DEST}`, "--include", "app-*.sqlite.gz", "--stats-one-line"],
            { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
        );
        return true;
    } catch (error) {
        // 找不到 rclone 命令 = 部署时没装，按"未上传"处理；其他错误才算真失败。
        if (isMissingBinary(error)) {
            console.warn("[backup] 未找到 rclone 命令，跳过远端上传（本地备份仍有效）");
            return false;
        }
        throw new Error(`rclone 上传失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

/** 判断是否是"命令不存在"。 */
export function isMissingBinary(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: string }).code;
    return code === "ENOENT";
}
