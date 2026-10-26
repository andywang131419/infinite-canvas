/**
 * 管理员建号 CLI —— **备用通道**（正常路径是 `/api/setup` 或后续的成员管理页）。
 *
 * 用法：
 *   cd server
 *   bun run user:create --email admin@local --password 'S0me-Long-Pass' --name 管理员
 *
 *   # 交互式（不传 --password 时从 stdin 读，且不回显）
 *   bun run user:create --email admin@local
 *
 * 为什么保留脚本（T02 第 2 条）：
 * - 部署在纯内网、完全不想暴露 `/api/setup` 时可以只用脚本；
 * - 忘记密码时可以就地重置（重复邮箱 + `--reset-password`）。
 *
 * 安全约束：
 * - 密码只从 argv 或 stdin 进来，**不写日志、不进历史记录**（提示用单引号包住）；
 * - 写入前用 `isPasswordHash` 自检，防止把明文误写进 `password_hash`。
 */

import { checkPasswordStrength, hashPassword, isPasswordHash } from "../src/auth/password";
import { getDb } from "../src/db/client";
import { createUser, findUserByEmail, isPlausibleEmail, normalizeEmail } from "../src/db/repos/users";

/** 解析后的命令行参数。 */
type Args = {
    email: string;
    password: string | null;
    name: string | null;
    role: "owner" | "member";
    resetPassword: boolean;
};

/** 打印用法。 */
function usage(): void {
    console.error(
        [
            "用法：bun run user:create --email <邮箱> [--password <密码>] [--name <显示名>] [--role owner|member] [--reset-password]",
            "",
            "  --password       省略则从 stdin 读取（不回显）",
            "  --reset-password 邮箱已存在时改为重置密码，而不是报错",
            "",
            "示例：",
            "  bun run user:create --email admin@local --password 'change-me-please' --name 管理员",
        ].join("\n"),
    );
}

/** 极简 argv 解析（避免为了一条命令引入依赖）。 */
function parseArgs(argv: string[]): Args {
    const args: Args = { email: "", password: null, name: null, role: "owner", resetPassword: false };

    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const next = argv[index + 1];

        switch (flag) {
            case "--email":
                args.email = next ?? "";
                index += 1;
                break;
            case "--password":
                args.password = next ?? "";
                index += 1;
                break;
            case "--name":
                args.name = next ?? "";
                index += 1;
                break;
            case "--role":
                args.role = next === "member" ? "member" : "owner";
                index += 1;
                break;
            case "--reset-password":
                args.resetPassword = true;
                break;
            case "--help":
            case "-h":
                usage();
                process.exit(0);
                break;
            default:
                break;
        }
    }

    return args;
}

/** 从 stdin 读一行（用于隐藏密码输入）。 */
async function readPasswordFromStdin(): Promise<string> {
    process.stderr.write("密码：");
    const reader = Bun.stdin.stream().getReader();
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);
            if (buffer.includes("\n")) break;
        }
    } finally {
        reader.releaseLock();
        process.stderr.write("\n");
    }

    return buffer.trim();
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!args.email) {
        usage();
        process.exit(1);
    }

    const email = normalizeEmail(args.email);
    if (!isPlausibleEmail(email)) {
        console.error(`邮箱格式不正确：${args.email}`);
        process.exit(1);
    }

    const password = args.password ?? (await readPasswordFromStdin());
    const strength = checkPasswordStrength(password);
    if (!strength.ok) {
        console.error(strength.message);
        process.exit(1);
    }

    // 触碰一次 DB：确保迁移已执行（脚本可以在空库上直接跑）。
    getDb();

    const passwordHash = await hashPassword(password);
    if (!isPasswordHash(passwordHash)) {
        console.error("哈希结果不符合 argon2 格式，已中止（避免写入明文）");
        process.exit(1);
    }

    const existing = findUserByEmail(email);

    if (existing) {
        if (!args.resetPassword) {
            console.error(`用户已存在：${email}。如要重置密码，请加 --reset-password`);
            process.exit(1);
        }

        getDb()
            .query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
            .run(passwordHash, new Date().toISOString(), existing.id);

        console.info(`已重置密码：${email}（id=${existing.id}）`);
        return;
    }

    const created = createUser({
        email,
        passwordHash,
        displayName: args.name ?? email.split("@")[0] ?? null,
        role: args.role,
    });

    console.info(`已创建用户：${created.email}（id=${created.id}, role=${created.role}）`);
}

main().catch((error) => {
    console.error("执行失败：", error instanceof Error ? error.message : error);
    process.exit(1);
});
