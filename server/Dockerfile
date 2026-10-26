# Infinite Canvas 自托管后端
#
# 设计约束（ARCH Rev2 §R2.3 / T01 第 4 条）：
#   - 运行时不需 **任何** 原生编译工具链：SQLite 用内建 `bun:sqlite`，
#     密码哈希用内建 `Bun.password`，因此镜像里 **没有也没必要** python3 / make / g++。
#   - Bun 直接执行 TypeScript，**没有构建阶段**（无 tsc emit、无 bundle）。
#   - 镜像内布局与仓库一致：/app/src + /app/migrations，迁移目录以 server/ 为基准解析。

FROM oven/bun:1.3.13

WORKDIR /app

ENV NODE_ENV=production \
    HTTP_PORT=8787 \
    HTTP_HOST=0.0.0.0 \
    DATABASE_PATH=/data/app.db \
    MIGRATIONS_DIR=migrations

# 先只拷 manifest 装依赖，最大化层缓存命中。
COPY package.json ./
# 注意：T01 阶段尚无 bun.lock（本机无 bun 可用于生成）。
#      一旦在 T02 生成并提交 server/bun.lock，应改为：
#      RUN bun install --frozen-lockfile --production
RUN bun install --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# 预建数据目录并交给非 root 用户；Docker 命名卷首次挂载会继承该目录的属主，
# 因此容器内以 bun 身份即可写入 /data（无需 root、无需额外 chown 步骤）。
RUN mkdir -p /data && chown -R bun:bun /data /app

USER bun

EXPOSE 8787

# 用 bun 自身做探针，避免为 curl/wget 额外安装包。
# 数据库不可用时 /api/health 返回 503 → r.ok 为 false → 容器标记 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD bun -e "const p = process.env.HTTP_PORT ?? 8787; fetch('http://127.0.0.1:' + p + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
