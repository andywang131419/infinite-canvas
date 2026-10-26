/**
 * 资产 MIME 白名单 —— **零依赖纯模块**（不 import 任何东西）。
 *
 * 为什么必须单独成文件：
 * 1. **同一个白名单要被两处使用**，且这两处不能互相 import：
 *    - `services/doc-sanitizer.ts`（内联 base64 落库前解码）
 *    - `services/asset-service.ts`（`PUT /api/assets` 与 T03 生成结果落库）
 *    而 `asset-service.ts` 已经 import 了 `doc-sanitizer.ts` 的类型，
 *    反向 import 会形成循环依赖。抽成叶子模块是唯一干净的解法。
 * 2. `doc-sanitizer.ts` 的设计前提是「可直接用 `node --experimental-strip-types`
 *    单测」，因此本文件必须零依赖。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要白名单（QA P0-2：同源直出 → 存储型 XSS）
 * ---------------------------------------------------------------------------
 * 资产与 SPA **同源**（`deploy/Caddyfile` 里 `/api` 与静态页同域）。
 * 若允许把请求头里的 `Content-Type` 原样落库并原样回写，那么：
 *
 *   PUT /api/assets?key=file:x   Content-Type: text/html   body: <script>...</script>
 *   GET /api/assets/raw?key=file:x  → 浏览器以本站 Origin 执行该脚本
 *
 * 同源脚本可以带着 `ic_session` Cookie 调任意 API（会话内越权：画布、渠道密钥全泄露）。
 * `X-Content-Type-Options: nosniff` **不起作用** —— 因为是我们自己声明了 `text/html`。
 *
 * 因此这里的取舍是**默认拒绝**：只有明确列出的、浏览器不会当成可执行文档的类型放行，
 * 其余一律归一为 `application/octet-stream`（并强制 `kind=file`、响应改 `attachment`）。
 *
 * 明确剔除（即使看起来"像图片"）：
 * - `image/svg+xml`：SVG 可内嵌 `<script>` / `<foreignObject>`，同源直出同样致命；
 * - `text/html` / `application/xhtml+xml` / `text/xml`：可直接执行；
 * - 任何 `text/*`：浏览器可能嗅探成 HTML（配合显式 `text/plain` 也不值得冒险）。
 */

/** 归一后的兜底类型（同时也是"不可内联展示"的标记）。 */
export const OCTET_STREAM_MIME = "application/octet-stream";

/**
 * 允许的资产 MIME（**归一后**的完整类型，不含参数）。
 *
 * 分组说明：
 * - `image/*`：浏览器按位图解码，不会执行脚本（**不含 svg**）；
 * - `video/*` / `audio/*`：媒体元素专用解码器；
 * - `application/pdf`：内联展示是常见需求，且 PDF 阅读器本身在沙箱内运行；
 * - `application/octet-stream`：兜底值本身（未知二进制，响应侧强制 `attachment`）。
 */
const ALLOWED_ASSET_MIME_PATTERN =
    /^(?:image\/(?:png|jpeg|webp|gif|avif|bmp|tiff)|video\/(?:mp4|webm|quicktime)|audio\/(?:mpeg|wav|ogg|aac|flac|webm)|application\/(?:octet-stream|pdf))$/;

/**
 * 常见"非标准写法" → 标准类型。
 *
 * 只做**等价归一**（同一容器/编码的不同写法），不借机把未知类型放进白名单：
 * 归一之后仍然要过 {@link ALLOWED_ASSET_MIME_PATTERN}。
 */
const MIME_ALIASES: Record<string, string> = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "audio/x-flac": "audio/flac",
    "video/mov": "video/quicktime",
};

/** 给错误信息 / 文档用的人话描述。 */
export const ALLOWED_ASSET_MIME_DESCRIPTION =
    "image/png|jpeg|webp|gif|avif|bmp|tiff、video/mp4|webm|quicktime、audio/mpeg|wav|ogg|aac|flac|webm、application/pdf";

/**
 * 取 MIME 的"主体"（去掉 `; charset=...` 参数并小写）。
 *
 * @param declared 原始 `Content-Type` 或 data URL 头里的类型。
 */
export function baseMimeOf(declared: string): string {
    return (declared || "").split(";")[0]!.trim().toLowerCase();
}

/**
 * 归一成标准 MIME；**不在白名单则返回 `null`**。
 *
 * 注意返回值可能是 {@link OCTET_STREAM_MIME} 本身 —— 它是白名单成员，
 * 但调用方通常要把它和"真正的媒体类型"区分对待（见 `isAllowedAssetMime`）。
 *
 * @param declared 原始 MIME 字符串（可带参数、可大小写混乱）。
 */
export function canonicalAssetMime(declared: string): string | null {
    const base = baseMimeOf(declared);
    if (base.length === 0) return null;

    const canonical = MIME_ALIASES[base] ?? base;
    return ALLOWED_ASSET_MIME_PATTERN.test(canonical) ? canonical : null;
}

/**
 * 是否是"可内联展示"的媒体类型（白名单命中且不是兜底的 octet-stream）。
 *
 * @param declared 原始 MIME 字符串。
 */
export function isAllowedAssetMime(declared: string): boolean {
    const canonical = canonicalAssetMime(declared);
    return canonical !== null && canonical !== OCTET_STREAM_MIME;
}
