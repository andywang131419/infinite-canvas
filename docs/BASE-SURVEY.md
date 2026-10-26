# BASE-SURVEY：infinite-canvas 只读基座探查

> 探查对象：`C:\Users\Administrator\WorkBuddy\2026-10-25-16-13-31\ic-user2`（用户 fork）
> 探查方式：**只读**。未修改任何源文件、未安装依赖、未执行任何 git 写操作。
> 目的：为后续「持久化替换 + AI 调用收口服务端」改造提供落点清单。

---

## 0. 结论速览（先看这 5 条）

| # | 结论 | 影响 |
|---|---|---|
| 1 | **不是 Next.js**。`web/` 是纯前端 SPA：Vite 7 + React 19 + antd 6 + Zustand 5 + react-router 7 + Tailwind 4 | 无 SSR、无 Node 运行时、**没有任何服务端代码**可用 |
| 2 | 镜像 = **nginx 静态站**（多阶段 bun build → nginx serve `web/dist`），无后端进程 | 新增服务端需要**从零加一个新 service**，不是改造现有后端 |
| 3 | 画布数据在 **zustand persist → localforage(IndexedDB)**，key `infinite-canvas:canvas_store` | 持久化改造的真实落点是**一个文件**：`web/src/stores/canvas/use-canvas-store.ts` |
| 4 | **AI 调用是浏览器直连 provider**（默认 `proxyEnabled: false`），可选经 `canvas-proxy` 本地转发；apiKey 明文存 localStorage | 收口服务端需要改 `web/src/services/api/*`（image/video/audio/model-plugin）+ `buildApiUrl`/`withLocalProxy` |
| 5 | **R5 风险成立，但形态与预期不同**：画布 JSON **不**内联 base64，而是存 `blob:` URL + `storageKey`，真实字节在同库 IndexedDB 的 `image_files`/`media_files`。**持久化的是死链，跨设备/跨浏览器一律取不到图** | 必须新增"媒体对象存储 + storageKey→URL 解析"一层；但不需要做 base64 大字段迁移 |

---

## 1. web 源码结构

### 1.1 目录分层

`web/` 是独立前端工程（有自己独立的 `package.json`、`tsconfig.json`、`vite.config.ts`），根目录**没有** workspace 配置。

```
web/
├── index.html                 Vite 入口 HTML（含 config.js 运行时注入）
├── vite.config.ts             Vite 配置（base / alias @ / __APP_VERSION__）
├── package.json               依赖与脚本
├── bun.lock / package-lock.json / pnpm-lock.yaml   三份 lock 并存
├── pnpm-workspace.yaml        仅 allowBuilds 占位，非真 workspace
├── docker-entrypoint.sh       容器启动时生成 config.js
├── public/
│   ├── config.js              运行时配置占位
│   └── icons/*.svg            模型厂商图标
├── tests/                     3 个 bun test 用例
└── src/
    ├── main.tsx               浏览器入口
    ├── router.tsx             ★ 路由定义
    ├── pages/                 页面（按路由一一对应）
    ├── components/            UI 组件（canvas/ agent/ layout/ prompts/ ui/）
    ├── stores/                ★ Zustand 状态（含 canvas/ 子目录）
    ├── services/              ★ 数据/IO 层（api/ 子目录为 AI 调用）
    ├── lib/                   纯函数工具（canvas/ 子目录为画布几何与数据）
    ├── hooks/                 自定义 hook
    ├── layouts/               布局壳
    ├── types/                 类型定义
    ├── constant/              常量与运行时配置读取
    ├── i18n/                  中英双语
    └── styles/globals.css     Tailwind + 主题变量
```

### 1.2 路由定义

唯一路由表：`web/src/router.tsx:15-35`

| path | 组件 | 源文件 |
|---|---|---|
| `/` | `HomePage` | `web/src/pages/home/index.tsx` |
| `/image` | `ImagePage` | `web/src/pages/image/index.tsx`（48KB） |
| `/video` | `VideoPage` | `web/src/pages/video/index.tsx`（44KB） |
| `/assets` | `AssetsPage` | `web/src/pages/assets/index.tsx`（30KB） |
| `/prompts` | `PromptsPage` | `web/src/pages/prompts/index.tsx` |
| `/canvas` | `CanvasPage`（项目列表） | `web/src/pages/canvas/index.tsx`（7.7KB） |
| `/canvas/:id` | `CanvasProjectPage` | `web/src/pages/canvas/project.tsx`（**198KB，全仓最大文件**） |
| `/config` | `ConfigPage` | `web/src/pages/config/index.tsx` |
| `*` | `NotFound` | `web/src/pages/not-found/index.tsx` |

外壳：`web/src/router.tsx:16-22` 用 `UserLayout` 包 `AnalyticsTracker` + `Outlet`；`UserLayout` = 顶栏 + 内容 + 右侧 `AgentPanel`（`web/src/layouts/user-layout.tsx:6-16`）。

浏览器入口：`web/src/main.tsx:17-23`（`createRoot` → `AppProviders` → `RouterProvider`）。`AppProviders` 串联 antd `ConfigProvider` → `ProConfigProvider` → `App` → `QueryClientProvider` → `ClientRootInit`（`web/src/components/layout/app-providers.tsx:45-55`）。

### 1.3 需要注意的三个"巨物"文件

| 文件 | 大小 | 说明 |
|---|---|---|
| `web/src/pages/canvas/project.tsx` | 198 KB | 画布工作区全部业务：生成、裁剪、切分、上采样、mask、导出、agent 桥接 |
| `web/src/components/agent/local-agent-panel.tsx` | 94 KB | 本地 Codex agent 侧边栏 |
| `web/src/components/canvas/canvas-node.tsx` | 55 KB | 单节点渲染（含多图槽位、视频/音频播放器） |

`project.tsx` 是后续任何画布相关改造的**主要冲突面**，建议改造时只做"关键行替换"而非重构。

---

## 2. 画布状态与持久化

### 2.1 谁管理画布数据

**唯一天然源（SOT）**：`web/src/stores/canvas/use-canvas-store.ts`

- 类型 `CanvasProject`：`use-canvas-store.ts:10-22`
  ```
  { id, title, createdAt, updatedAt, nodes[], connections[], chatSessions[],
    activeChatId, backgroundMode, showImageInfo, viewport }
  ```
- store 创建：`use-canvas-store.ts:69-146`（`create<CanvasStore>()(persist(...))`）
- 持久化 key：`use-canvas-store.ts:43` → `const CANVAS_STORE_KEY = "infinite-canvas:canvas_store"`
- 自定义 `PersistStorage`：`use-canvas-store.ts:48-67`
  - **400ms 防抖写盘**：`use-canvas-store.ts:61-64`（`saveTimer` + `setTimeout(..., 400)`）
  - 引用相等短路：`use-canvas-store.ts:58`（`projects`/`deletedProjects` 引用未变则跳过）
- `partialize` 只落 `projects` + `deletedProjects`：`use-canvas-store.ts:136-140`
- 水合完成标记：`use-canvas-store.ts:141-143`（`hydrated: true`）

只读入口（`openProject`）：`use-canvas-store.ts:112-114`。
写入入口（`updateProject`，被 `project.tsx` 大量调用）：`use-canvas-store.ts:128-131`。

**其他相关 store**：
- `web/src/stores/canvas/use-canvas-ui-store.ts`（1.4KB）—— 纯 UI 态，不落盘
- `web/src/stores/canvas/use-plugin-store.ts:42` —— 插件启用态，`createJSONStorage(() => localForageStorage)`
- `web/src/stores/use-canvas-side-panel-store.ts:16,23,28,52,56,61` —— 面板宽度/开合/视图模式，**直接 localStorage**

### 2.2 本地存储实际用什么 —— grep 结果全量清单

`grep -n "localforage|indexedDB|idb|dexie|localStorage"` 结论：
- **没有** `idb`、**没有** `dexie`
- `localforage ^1.10.0`（`web/package.json:31`）是唯一的 IndexedDB 封装
- `localStorage` 只用于**轻量 UI 偏好 + AI 配置**

#### (a) localforage 实例（IndexedDB，db 名统一为 `infinite-canvas`）

| storeName | 用途 | 定义位置 |
|---|---|---|
| `app_state` | zustand 通用持久化后端 | `web/src/lib/localforage-storage.ts:4-7` |
| `image_files` | **图片 Blob 真身** | `web/src/services/image-storage.ts:17` |
| `image_previews` | 图片 WebP 缩略图（不参与导出/同步） | `web/src/services/image-storage.ts:18` |
| `image_generation_logs` | 图片生成日志 | `web/src/services/image-storage.ts:19`、`web/src/services/app-sync.ts:79`、`web/src/pages/image/index.tsx:68` |
| `video_generation_logs` | 视频生成日志 | `web/src/services/image-storage.ts:20`、`web/src/services/app-sync.ts:80`、`web/src/pages/video/index.tsx:68` |
| `media_files` | **视频/音频 Blob 真身** | `web/src/services/file-storage.ts:8` |
| `prompt_cache` | 提示词源缓存 | `web/src/services/api/prompts.ts:49` |
| `<pluginId>`（库 `infinite-canvas-plugins`） | 插件私有存储 | `web/src/lib/canvas/canvas-event-bus.ts:35` |

#### (b) localforage → 文字数据的读写点

| 文件:行 | 行为 |
|---|---|
| `web/src/lib/localforage-storage.ts:9-34` | `StateStorage` 三方法 `getItem/setItem/removeItem`，**异常时降级 localStorage**（`:15`、`:23`、`:31`） |
| `web/src/stores/canvas/use-canvas-store.ts:6,50,63,66` | 画布项目 JSON 读写（经上面封装） |
| `web/src/stores/use-asset-store.ts:5,47,107` | "我的素材" JSON，自定义 `assetStorage`（`:47` 定义，`:49` 复用 `localForageStorage`，`:52-62` 水合时重建图片/视频 URL） |
| `web/src/stores/canvas/use-plugin-store.ts:4,42` | 插件启用态 |
| `web/src/services/image-storage.ts:59,147,217,238,254,258,179,197,213` | 图片 Blob / 缩略图读写删 |
| `web/src/services/file-storage.ts:14,25,37,49,57` | 媒体 Blob 读写删 |
| `web/src/services/app-sync.ts:216-219,235` | WebDAV 同步时读写 Blob |
| `web/src/services/local-storage-usage.ts:21` | `indexedDB.open(name)` 只读统计各 store 记录数（用量面板） |

#### (c) 直接 `localStorage` 读写点（全部）

| 文件:行 | key / 用途 |
|---|---|
| `web/index.html:11` | `infinite-canvas:theme_store` 首屏暗色防闪烁 |
| `web/src/i18n/index.ts:16,25` | 语言偏好 |
| `web/src/stores/use-config-store.ts:75` + `:215-250` | ★ **`infinite-canvas:ai_config_store` —— AI 渠道配置，含 baseUrl/apiKey 明文** |
| `web/src/stores/use-agent-store.ts:99,104,105,125,127,128,158,159` | `canvas-agent-*` 地址/token/model/permission |
| `web/src/components/agent/local-agent-panel.tsx:344,345,609,610,893,1430,1431,1435` | 同上（agent 面板写回） |
| `web/src/components/agent/agent-panel.tsx:31` | `canvas-agent-panel-width` |
| `web/src/stores/use-canvas-side-panel-store.ts:16,23,28,52,56,61` | 侧栏宽度/开合/视图模式 |
| `web/src/components/canvas/canvas-side-panel.tsx:75` | `canvas-side-panel-width` |
| `web/src/components/canvas/canvas-node-hover-toolbar.tsx:92,99,181` | 图片快捷工具栏配置 |

> ⚠️ **安全提示**：`use-config-store.ts:215-250` 的 `persist` **没有传 `storage` 选项**，zustand 默认走 `localStorage`。因此**所有 AI 渠道的 apiKey 以明文 JSON 常驻 localStorage**（key `infinite-canvas:ai_config_store`）。这是改造前既有的安全债，收口到服务端时应一并解决。

---

## 3. AI 调用点

### 3.1 统一 URL 构造与代理开关（收口的关键切入点）

全部集中在一个文件：`web/src/stores/use-config-store.ts`

| 函数 | 行号 | 逻辑 |
|---|---|---|
| `buildApiUrl(baseUrl, path)` | `:487-492` | baseUrl 去尾斜杠 → 补 `/v1` → `withLocalProxy(...)` |
| `normalizeLocalProxyUrl(value)` | `:494-498` | 去尾斜杠、无协议补 `http://` |
| `withLocalProxy(url)` | `:500-507` | 读 `proxyEnabled`；开启时把 `https://api.x.com/v1/...` 拼成 `http://127.0.0.1:23210/https://api.x.com/v1/...` |
| `DEFAULT_LOCAL_PROXY_URL` | `:80` | `http://127.0.0.1:23210` |
| `defaultConfig.proxyEnabled` | `:124` | **`false`（默认直连）** |

即：**默认 = 浏览器直连 provider；只有用户在「配置 → 本地代理」里打开开关才走 canvas-proxy。**

### 3.2 各能力的具体调用点

#### 图片 / 文本（`web/src/services/api/image.ts`，40KB）

| 位置 | 内容 |
|---|---|
| `:313-315` `aiApiUrl` | `buildApiUrl(config.baseUrl, path)` |
| `:317-322` `aiHeaders` | `Authorization: Bearer ${config.apiKey}` |
| `:324-338` `geminiBaseUrl` / `geminiApiUrl` | Gemini 走 `/v1beta/models/...:generateContent`，**强制 `withLocalProxy`**（`:336-337`） |
| `:340-345` `geminiHeaders` | `x-goog-api-key` |
| `:473` `fetch(aiApiUrl(config, "/responses"))` | OpenAI Responses API（多模态/文生图） |
| `:580` `fetch(${geminiApiUrl(config,"streamGenerateContent")}?alt=sse)` | Gemini SSE 流式 |
| `:869-872` `axios.get(buildApiUrl(config.baseUrl,"/models"))` + Bearer | 拉模型列表（**唯一使用 axios 的 AI 调用**） |
| 导出：`:694 requestGeneration` | 文生图 |
| 导出：`:754 requestEdit` | 图生图 / 编辑 |
| 导出：`:821 requestImageQuestion` | 视觉问答（流式） |
| 导出：`:859 fetchImageModels` / `:883 fetchChannelModels` | 模型发现 |
| `:215`、`:539`、`:685` | 响应里的 `b64_json` / Gemini `inlineData.data` → **拼成 `data:image/...;base64,...`** |

#### 视频（`web/src/services/api/video.ts`，23KB）

| 位置 | 内容 |
|---|---|
| `:36` `buildApiUrl(config.baseUrl, path)` | URL 构造 |
| `:41` `Authorization: Bearer ${config.apiKey}` | OpenAI 风格鉴权 |
| `:94-95`、`:269-270` | baseUrl/apiKey 空值校验 |
| `:273-288` `geminiVideoBaseUrl/Url/OperationUrl/Headers` | Gemini Veo 系列，`x-goog-api-key` |
| `:260` | 给远端 uri 拼 `key=<apiKey>` 查询参数 |
| `:297` | data URL 解析（首帧/尾帧上传） |
| `:311` `fetch(url)` | 下载生成结果成 Blob |

#### 音频（`web/src/services/api/audio.ts`，7.6KB）

| 位置 | 内容 |
|---|---|
| `:13` `buildApiUrl` | URL 构造 |
| `:18` `Authorization: Bearer` | 鉴权 |
| `:30-31`、`:90-91` | 配置校验 |
| `:78` | `data:${mime};base64,${source}` 兜底（服务端返回裸 base64） |
| `:79` `fetch(withLocalProxy(url))` | 音频下载 |

#### 模型插件（`web/src/services/api/model-plugin.ts`，30KB）

用户可写脚本定义的自定义 provider，能力最强、最难收口：

| 位置 | 内容 |
|---|---|
| `:44` `buildApiUrl(config.baseUrl, path)` | 插件内请求封装 |
| `:55` `Authorization: Bearer ${config.apiKey}` | 插件请求头 |
| `:126-127`、`:147-148`、`:178-179` | 把 `baseUrl`/`apiKey` 作为变量暴露给插件脚本 |
| `:265,268` / `:301,303` | OpenAI `/v1/images/generations`、`/v1/images/edits` |
| `:391,394` | Gemini `/v1beta/models/{model}:generateContent` |
| `:511,520,532` | OpenAI `/v1/videos`、`/v1/videos/{id}`、`/v1/videos/{id}/content` |
| `:669,686` | Gemini `predictLongRunning`、operation 轮询 |
| `:297,489,492,496` | `fetch(dataUrl)` → FormData（图片转 multipart 上传，**在浏览器里做**） |

#### 代理连通性探测

`web/src/services/api/local-proxy.ts:8` → `fetch(`${base}/`)`，用根路径 identity 响应判断可用性（对应 `canvas-proxy/index.js:101`）。

### 3.3 结论：直连，还是经 proxy？

**两者都有，默认是直连。**
- `proxyEnabled: false`（`use-config-store.ts:124`）→ `withLocalProxy` 原样返回（`:503`）→ 浏览器直接 `fetch("https://api.openai.com/v1/...")`
- 直连必然受 CORS 限制，因此官方提供 `canvas-proxy` 作为**可选**的本地 CORS 中转（用户手动开开关 + 手动 `npx` 跑进程）
- **任何请求都不经过本项目自己的服务器**——因为本项目根本没有服务器

---

## 4. 画布文档结构（R5 关键）

### 4.1 结论（重要）

**画布 JSON 里图片不是"以 base64 内联存储"的。**

实际结构是「**双字段 + 旁路 Blob 库**」：

```ts
// web/src/types/canvas.ts:28-38
type CanvasNodeImage = {
  id: string;
  status: "idle" | "success" | "loading" | "error";
  errorDetails?: string;
  content: string;          // ← 展示用 URL：通常是 blob:http://... （会话级，刷新即失效）
  storageKey?: string;      // ← 长期标识：形如 "image:<nanoid>"，指向 IndexedDB 里的 Blob
  naturalWidth: number;
  naturalHeight: number;
  bytes: number;
  mimeType: string;
};
```

节点级同构字段：`web/src/types/canvas.ts:47-88` `CanvasNodeMetadata` 里也是 `content?: string` + `storageKey?: string` + `images?: CanvasNodeImage[]`。

### 4.2 写入链路（证据）

`web/src/services/image-storage.ts:37-69` `uploadImage(input)`：

1. `:38` 非字符串直接 `storeImage(blob)`
2. `:42` 字符串先 `fetchImageBlob`（`:82` 走 `withLocalProxy`）
3. `:53` `const storageKey = "image:" + nanoid()`
4. `:54` `URL.createObjectURL(blob)` → **`blob:` 形式的内存 URL**
5. `:59` `await store.setItem(storageKey, blob)` → **Blob 落 IndexedDB `image_files`**
6. `:62` 生成缩略图存 `image_previews`
7. `:63` 返回 `{ url, storageKey, width, height, bytes, mimeType }`

写入节点时（如 `web/src/pages/canvas/project.tsx:2481`）：
```ts
const item: CanvasNodeImage = { id, status: "success",
  content: uploaded.url,          // blob: 死链
  storageKey: uploaded.storageKey, // image:xxx
  naturalWidth, naturalHeight, bytes, mimeType };
```

### 4.3 打开画布时的"补水"（证明 content 不可靠）

`web/src/lib/canvas/canvas-generation-helpers.ts:45-67` `hydrateCanvasImages(nodes)`：

- `:50` 视频/音频：有 `storageKey` → `resolveMediaUrl(storageKey, content)` 重建 URL
- `:56` 多图槽位：`resolveImageUrl(image.storageKey, image.content)`
- `:61` 节点级：`resolveImageUrl(metadata.storageKey, content)`
- `:63-64` **兼容旧数据**：无 `storageKey` 但 `content` 是 `data:image/...` → `uploadImage(content)` 迁移
- 助手会话图片同逻辑：`:69-89`

`resolveImageUrl`：`web/src/services/image-storage.ts:143-152`（内存 `objectUrls` 命中 → 否则读 IndexedDB → `createObjectURL`）。

**这就证明了：持久化 JSON 里的 `content` 是"当前会话的临时 URL"，真正的数据在 IndexedDB。**

### 4.4 base64 出现的全部位置（都是为了"发给 AI"或"画布编辑"，不是持久化）

| 文件:行 | 场景 | 是否落盘 |
|---|---|---|
| `web/src/lib/image-utils.ts:26-31,56` | data URL 体积估算 / mime 解析 | 否 |
| `web/src/services/api/image.ts:215,539,685` | 把 provider 返回的 `b64_json`/`inlineData` 拼成 data URL | 否（随后 uploadImage） |
| `web/src/services/api/model-plugin.ts:282,309,361,416,604,616,984` | 插件脚本收发 base64 | 否 |
| `web/src/services/api/audio.ts:78` | 裸 base64 → data URL | 否 |
| `web/src/services/api/video.ts:297` | data URL → multipart | 否 |
| `web/src/lib/canvas/canvas-image-data.ts:109,132,153` | `canvas.toDataURL()` 裁剪/上采样/切分产物 | 否（随即 `uploadImage`） |
| `web/src/components/canvas/canvas-node-mask-edit-dialog.tsx:424,430,437` | 蒙版 `toDataURL` | 否（`uploadImage(payload.maskDataUrl)`） |
| `web/src/stores/use-asset-store.ts:64-66` | 素材库水合时把旧 `data:image/...` 迁移成 `storageKey` | 迁移后以 storageKey 为准 |
| `web/src/components/canvas/canvas-node-hover-toolbar.tsx:230-231` | 调试展示时把 base64 脱敏成 `[base64 image]` | 否 |
| `web/src/services/webdav-sync.ts:120` | `btoa` 仅用于 **HTTP Basic Auth** | 否 |

### 4.5 导出与同步也没有内联 base64

- **导出 ZIP**：`web/src/lib/canvas/canvas-export.ts:11-32`
  - `projects.json` 只含元数据 + `files[]` 清单（`:29`，含 `storageKey/path/mimeType/bytes`）
  - 二进制单独放 `projects/<id>/files/<key>.<ext>`（`:20-22`）
- **WebDAV 同步**：`web/src/services/app-sync.ts:225-268`
  - `manifest.json` 存索引，媒体逐文件 `PUT`（`web/src/services/webdav-sync.ts:33-44`）
  - 下载时按 `storageKey` 回填 IndexedDB（`app-sync.ts:216-219`）

### 4.6 官方文档的权威表述（同结论）

`docs/content/docs/development/canvas-data-structure.zh-CN.mdx`

- `:19`「画布 JSON **不直接长期保存**大体积 base64 图片或视频。图片节点…只保存展示 URL、`storageKey` 和元信息」
- `:117`「`content` 是当前可展示的图片 URL，成功保存本地时**通常是 `blob:` URL**…`storageKey` 仅在图片已经写入本地 Blob 时存在」
- `:209`「已保存图片的 `content` 只适合当前浏览器会话展示，**长期标识是 `storageKey`**」
- `:213-217`「打开画布时会执行图片补水」——有 `storageKey` 走 resolve；无 `storageKey` 的旧 `data:image/...` 走迁移

### 4.7 残留风险（改造时必须处理的边界）

1. **CORS 不可读的远程图**：`web/src/services/image-storage.ts:44-47` —— fetch 失败但能显示时，返回 `{ url: input, bytes: 0, mimeType: "", storageKey: undefined }`。这类节点**只有远程 URL，没有 Blade 落库**，跨域/过期后彻底丢失。
2. **旧数据 inline base64**：`canvas-generation-helpers.ts:63`、`:72`、`use-asset-store.ts:64`。需要保留迁移分支。
3. **`metadata.references?: string[]` 存的是 storageKey 而非图片**：`web/src/lib/canvas/canvas-generation-helpers.ts:38`（`url.startsWith("image:")`）。
4. **video 的 `videoTaskId`**：`web/src/types/canvas.ts:84-85` —— OpenAI 式异步视频任务 ID 会写进节点，刷新后靠它续查。服务端化时这个轮询也应该挪到服务端。

---

## 5. canvas-proxy / canvas-agent 的职责

### 5.1 `canvas-proxy/` —— 极简 CORS 转发代理（**与画布数据无关**）

- 包：`@basketikun/canvas-proxy@0.1.0`（`canvas-proxy/package.json:8-9`），零依赖，单文件 `index.js`（5.5KB）
- 默认监听：`127.0.0.1:23210`（`canvas-proxy/index.js:126-127`）
- 本质：`GET http://127.0.0.1:23210/<完整的 target URL>` → 转发到该 URL → 回写 `access-control-allow-*: *`（`:8-14`）
- 关键实现：
  - `:35-47` `readTarget` —— 从 path 里解出目标 URL（`decodeURI` + 修复被折叠的 `//`）
  - `:76-90` `forward` —— `fetch` 上游 + **流式 pipe 回浏览器**（`:86-88`，为 SSE 文本流准备）
  - `:17-19` 剥离 hop-by-hop 头
  - `:101` 根路径返回 `{ app:"infinite-canvas", proxy, version }` 作为身份/探活
- **配置项填写位置**：前端「配置 → 本地代理」
  - UI：`web/src/components/layout/config-local-proxy.tsx`
    - `:55` placeholder = `DEFAULT_LOCAL_PROXY_URL`
    - `:57` onBlur 时 `normalizeLocalProxyUrl(...)`
    - `:75-76` 生成 `npx ... --port <port>` 命令提示
  - 存储：`use-config-store.ts` 的 `config.proxyEnabled` / `config.proxyUrl`（`:124-125`）

### 5.2 `canvas-agent/` —— 本地 Codex/Claude 编排服务（**与 AI 生图/生视频无关**）

- 包：`@basketikun/canvas-agent@0.6.0`（`canvas-agent/package.json:2-3`），独立版本号，不跟仓库 `VERSION` 绑定
- 默认监听 `127.0.0.1:17371`（`canvas-agent/src/config.ts:6`）
- 技术栈：Express 5 + `@openai/codex@0.146.0`（`codex app-server --stdio`）+ `@modelcontextprotocol/sdk` + `zod`
- 职责：把网页右侧边栏的指令发给本机 Codex CLI，暴露 MCP 工具（`canvas_get_state` / `canvas_apply_ops` / `canvas_create_image_prompt_flow` 等，见 `canvas-agent/README.md:110-118`）
- 服务端主体：`canvas-agent/src/server/http.ts`（36KB）、`canvas-agent/src/canvas/session.ts`（29KB）、`canvas-agent/src/agent/codex.ts`（29KB）
- 配置与 token：`~/.infinite-canvas/canvas-agent.json`（`canvas-agent/src/config.ts:7-8`），权限强制 0700/0600（`:33-38`）
- **web 侧如何调用**：`web/src/services/api/canvas-agent.ts`
  - `:44-55` `POST ${endpoint}/canvas/state?token=...&clientId=...`（推送画布快照）
  - `:57-61` `POST /canvas/activate`
  - `:63-65` `POST /canvas/result`（工具回填）
  - `:67-77` Codex 审批 / 中断 / 历史 ack
  - `:83-88` `agent-asset:<sha>/<file>` → `${endpoint}/agent/message-assets/...?token=`
  - `:90-116` skills CRUD
  - `:126-135` `GET ${endpoint}/config` 发现配置
- **地址与 token 填写位置**：`localStorage` 的 `canvas-agent-url` / `canvas-agent-token`
  - 默认值：`web/src/stores/use-agent-store.ts:104-105`（`http://127.0.0.1:17371`）
  - 写入：`use-agent-store.ts:158-159`、`web/src/components/agent/local-agent-panel.tsx:344-345`

> 对本项目改造的意义：`canvas-agent` 是**用户本机进程**，端点也不经服务器。它不承载 AI 生图能力，**不需要收口**；但它是"服务端也可做的能力"的现成参考实现（Express + SSE + token 鉴权）。

---

## 6. 部署链

### 6.1 `Dockerfile` —— 两阶段，产物是静态站

```dockerfile
# 阶段 1：构建
FROM oven/bun:1.3.13 AS web-build          # :2
WORKDIR /app/web                            # :4
COPY web/package.json web/bun.lock ./        # :5
RUN bun install --cache-dir=...              # :6
COPY VERSION /app/VERSION                    # :7
COPY CHANGELOG.md /app/CHANGELOG.md          # :8
COPY web ./                                 # :9
RUN bun run build                            # :10  → /app/web/dist

# 阶段 2：运行
FROM nginx:1.27-alpine                       # :13
COPY --from=web-build /app/web/dist /usr/share/nginx/html   # :15
COPY nginx.conf /etc/nginx/conf.d/default.conf              # :16
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh  # :17
EXPOSE 3000                                  # :20
```

**关键事实**：
- 注释直接写明「运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口」（`Dockerfile:12`）
- **没有 Node/Python 进程**，只有 nginx
- 构建期注入 `VERSION` 与 `CHANGELOG.md`（对应 `web/vite.config.ts:10-11` 读 `../VERSION`、`../CHANGELOG.md`，`:49-52` define `__APP_VERSION__`/`__APP_RELEASES__`）

### 6.2 `docker-compose.yml` —— 单 service，无卷

```yaml
services:
  app:
    image: ghcr.io/basketikun/infinite-canvas:latest   # :3
    container_name: infinite-canvas                    # :4
    ports: ["3000:3000"]                               # :5-6
    restart: unless-stopped                            # :7
    # environment: ANALYTICS_GA4_ID / ANALYTICS_BAIDU_ID（默认注释掉）  # :8-11
```

**没有 volumes、没有 depends_on、没有第二个 service。** 这是"新增后端"必须改动的地方。
`docker-compose.local.yml`（175B）为本地构建变体。

### 6.3 `nginx.conf` —— 只有 2 个 location

```nginx
server {
    listen 3000;                       # :2
    root /usr/share/nginx/html;        # :4
    index index.html;                  # :5

    location / { try_files $uri $uri/ /index.html; }   # :7-9   SPA fallback
    location = /config.js { add_header Cache-Control "no-store"; }  # :12-14
}
```

**没有 `location /api/`**——新增后端 API 时要在这里加反向代理（或改用 Vite dev proxy + 独立域名）。

### 6.4 运行时配置注入

`web/docker-entrypoint.sh`：容器启动时由 nginx 官方 entrypoint 执行，用环境变量生成 `/usr/share/nginx/html/config.js`：

```js
window.__RUNTIME_CONFIG__ = { ANALYTICS_GA4_ID: "...", ANALYTICS_BAIDU_ID: "..." };
```

- 只 sanitize 字母数字连字符（`:10-12`），防注入
- 前端读取：`web/src/constant/runtime-config.ts:19-29`（优先级 `window.__RUNTIME_CONFIG__` > `VITE_*` > 默认）
- HTML 引入：`web/index.html:20`
- **这是现成的"运行时配置注入"机制，新增后端地址/开关可直接复用，无需重新构建镜像。**

### 6.5 其他部署平台

| 文件 | 说明 |
|---|---|
| `vercel.json`（根，225B） | Vercel 部署 |
| `render.yaml`（196B） | Render 部署 |
| `web/vercel.json` | web 子目录 Vercel 配置 |
| `.github/workflows/docker-image.yml` | 构建推 ghcr.io |
| `.github/workflows/docs-docker-image.yml` | 文档站镜像 |
| `.github/workflows/github-pages.yml` | Pages |
| `.github/workflows/publish-plugins.yml` | 插件分发到 `plugins-dist` 分支（供 jsDelivr 引用，见 `web/src/constant/env.ts:6`） |

---

## 7. 包管理

### 7.1 `web/package.json` 脚本

```json
"dev":       "vite --host 0.0.0.0 --port 3000"
"build":     "vite build"          // 注意：build 不含 typecheck
"typecheck": "tsc --noEmit"
"test":      "bun test"
"start":     "vite preview --host 0.0.0.0 --port 3000"
"format":    "prettier --write ."
"format:check": "prettier --check ."
```
证据：`web/package.json:6-14`

### 7.2 包管理器：**bun 是权威**

- **三个 lock 文件同时存在**：`web/bun.lock`、`web/package-lock.json`、`web/pnpm-lock.yaml`
- **Dockerfile 明确只用 bun**：`Dockerfile:5`（`COPY web/package.json web/bun.lock ./`）+ `:6`（`bun install`）+ `:10`（`bun run build`）
- `web/package.json:10` 测试用 `bun test`
- `web/pnpm-workspace.yaml` 只有 `allowBuilds: esbuild` 占位（`:1-2`），**不是真正的 workspace 定义**
- **根目录没有 `package.json`**（无 monorepo workspace）——`web/`、`canvas-agent/`、`canvas-proxy/`、`docs/`、`plugins/*` 各自独立

> 结论：**本地开发用 bun（`bun install` / `bun run dev`），不要用 npm 装**，否则会与 `bun.lock` 漂移。

### 7.3 核心依赖版本（`web/package.json:15-58`）

| 包 | 版本 | 作用 |
|---|---|---|
| `vite` | `^7.3.0` | 构建 |
| `react` / `react-dom` | `19.2.5`（锁定） | UI |
| `antd` | `^6.4.2` | 主组件库 |
| `@ant-design/pro-components` | `3.0.0-beta.3` | Pro 组件（beta，注意兼容） |
| `@ant-design/icons` | `^6.1.1` | 图标 |
| `zustand` | `^5.0.12` | 状态 + persist |
| `@tanstack/react-query` | `^5.100.9` | 服务端态缓存（目前仅 `AppProviders` 挂载，AI 调用未走它） |
| `react-router` / `react-router-dom` | `^7.12.0` | 路由 |
| `tailwindcss` + `@tailwindcss/postcss` | `^4` | 样式 |
| `localforage` | `^1.10.0` | ★ IndexedDB 封装 |
| `axios` | `^1.16.0` | 仅 `image.ts` 拉模型列表用 |
| `nanoid` | `^5.1.11` | ID 生成（含 `storageKey`） |
| `fflate` | `^0.8.3` | ZIP 导出 |
| `file-saver` | `^2.0.5` | 下载 |
| `i18next` / `react-i18next` | `^26.3.6` / `^17.0.11` | 国际化 |
| `motion` | `^12.38.0` | 动画 |
| `radix-ui` / `shadcn` / `lucide-react` / `streamdown` | — | 与 antd 混用的第二 UI 体系 |
| `@uiw/react-codemirror` + `@codemirror/*` | — | 插件脚本编辑器 |

> 注意存在**双 UI 体系混用**：antd 6 + radix/shadcn/tailwind。改 UI 前先确认目标文件属于哪一套。

### 7.4 已有测试

只有 3 个用例（`bun test`）：
- `web/tests/canvas-focus-viewport.test.ts`
- `web/tests/image-thumbnail.test.ts`
- `web/tests/model-selection.test.ts`

`canvas-agent/` 测试覆盖反而更完整（`src/**/*.test.ts` 共 7 个）。

---

## 8. 版本确认

| 项 | 值 | 证据 |
|---|---|---|
| `VERSION` 文件 | **`v0.20.0`** | 根目录 `VERSION`（7 字节） |
| 基线 commit | **`9cd3deacbcc598361807afc16c059a80dd18b6f9`** | `git log -1` |
| commit 标题 | `feat(README): add KunrouAI logo and description to the README` | `git log -1` |
| 提交时间 | `Sun Oct 25 19:21:15 2026 +0800`（作者 HouYunFei） | `git log -1 --pretty=fuller` |
| tag | **无**（`git tag --points-at HEAD` 空） | 浅克隆未拉 tag |
| 克隆类型 | **浅克隆**（depth=1，`git rev-list --count HEAD` = 1，`.git/shallow` 存在） | — |
| 分支 | 仅 `main` | `git branch -a` |
| remote | `https://ghfast.top/https://github.com/andywang131419/infinite-canvas.git` | `git remote -v` |
| `web/package.json` version | `0.1.0`（**与 VERSION 不同步**） | `web/package.json:3` |
| 实际构建版本号来源 | 读 `../VERSION` → `__APP_VERSION__` | `web/vite.config.ts:10`、`:50` |
| `canvas-proxy` version | `0.1.0` | `canvas-proxy/package.json:9` |
| `canvas-agent` version | `0.6.0`（独立发版） | `canvas-agent/package.json:3` |

> 因是浅克隆，`git describe` / `git tag` 拿不到上游 tag 历史，**只能以 `VERSION` 文件和 HEAD commit 作为基线标识**。

---

## 9. 对改造的影响

### (a) 持久化要改的真实文件

**核心只有 1 个文件，但有 5 个必须同步处理的伴生点。**

| 优先级 | 文件 | 要做什么 |
|---|---|---|
| **P0** | `web/src/stores/canvas/use-canvas-store.ts` | 替换 `canvasStorage`（`:48-67`）为服务端读写。保留 `persist` 接口形状（`getItem/setItem/removeItem`）即可最小侵入；400ms 防抖（`:61-64`）可改为"防抖 + 服务端 PATCH"。`CanvasProject` 类型（`:10-22`）建议不动 |
| **P0** | `web/src/lib/localforage-storage.ts` | 若要保留"离线优先"，把它扩展成"先写 IndexedDB，再异步同步服务端"的双写层；`StateStorage` 接口（`:9-34`）已是抽象点，改这里即可覆盖画布/素材/插件三个 store |
| **P1** | `web/src/services/image-storage.ts` | `uploadImage`（`:37-69`）与 `resolveImageUrl`（`:143-152`）必须改为服务端对象存储：`storageKey` → 上传后返回的 CDN/对象 URL。`content` 语义从 `blob:` 改为 `https://...`，可**顺带消灭 4.7 的死链问题** |
| **P1** | `web/src/services/file-storage.ts` | 同上，`media_files`（`:8`）→ 对象存储；`UploadedFile.storageKey`（`:6`）语义沿用 |
| **P2** | `web/src/services/app-sync.ts` + `web/src/services/webdav-sync.ts` | 已有"manifest + 逐文件 PUT"的成熟同步骨架（`app-sync.ts:225-268`），可直接复用作服务端同步的参考实现，甚至整体替换为服务端 API |
| **P2** | `web/src/services/local-storage-usage.ts` / `web/src/components/layout/config-local-storage.tsx` | 存储用量面板需要改成查服务端配额 |

**不需要改的**：`CanvasProject` / `CanvasNodeData` / `CanvasNodeImage` 类型（`web/src/types/canvas.ts`）——`storageKey` 字段已存在，天然兼容对象存储化。

### (b) AI 调用收口到服务端的真实文件

**好消息：URL/鉴权是高度收敛的，改造面比预想小。**

| 优先级 | 文件 | 落点 |
|---|---|---|
| **P0** | `web/src/stores/use-config-store.ts` | 这是**总闸门**。`buildApiUrl`（`:487-492`）+ `withLocalProxy`（`:500-507`）只要改为"指向自己的 `/api/ai/*` 并去掉 apiKey 头"，所有 OpenAI 风格调用立即收口。`AiConfig.channels[].apiKey`（`:18-26`）应改为不落前端 |
| **P0** | `web/src/services/api/image.ts` | `aiApiUrl`（`:313-315`）、`aiHeaders`（`:317-322`）、`geminiApiUrl`（`:334-338`）、`geminiHeaders`（`:340-345`）、`fetch` 点（`:473`、`:580`）、`axios.get`（`:869-872`）。Gemini 分支已**强制**走 `withLocalProxy`，改一处即生效 |
| **P1** | `web/src/services/api/video.ts` | `:36`、`:41`、`:273-288`（Gemini）、`:260`（`key=` 查询参数） |
| **P1** | `web/src/services/api/audio.ts` | `:13`、`:18` |
| **P1** | `web/src/services/api/model-plugin.ts` | **最难**。插件脚本拿到 `baseUrl`/`apiKey` 变量（`:126-127`、`:147-148`、`:178-179`、`:258-259` 等）并在浏览器里自己拼 URL、`fetch(dataUrl)` 转 multipart（`:297`、`:489-496`）。收口需要把插件执行**整体搬到服务端 sandbox**，或给插件注入"服务端 baseUrl + 代理 apiKey" |
| **P2** | `web/src/services/api/local-proxy.ts` | `canvas-proxy` 的角色被服务端取代，可保留为"自建有代理需求"的可选项；`testLocalProxy`（`:5-12`）可改为探测自家 `/api/health` |
| **P2** | `web/src/components/layout/config-local-proxy.tsx` / `config-local-storage.tsx` / `app-config-modal.tsx` | 「配置」面板的 tabs（`ConfigTabKey`，`use-config-store.ts:68`）需去掉 `channels`（apiKey 编辑）、`local-proxy` |
| **P2** | `web/src/stores/use-config-store.ts:124` `proxyEnabled: false` | 语义反转：从"要不要走本地代理"变为"后端是否已托管 provider 调用" |

**需要新建的**：
- 后端服务（当前项目**完全没有**）：建议 `server/`（与 `web/`、`canvas-agent/` 平级），Node/Express 或 Fastify，复用 `canvas-agent` 的技术选型（Express 5 + SSE）以减少认知成本
- `Dockerfile` 新增后端 build stage；`docker-compose.yml` 新增第二个 service
- `nginx.conf` 新增 `location /api/ { proxy_pass http://server:PORT; }`

**关键约束（必须遵守，否则会崩）**：
1. **SSE 流式**：`image.ts:580`（Gemini `alt=sse`）与 OpenAI Responses 流式都依赖逐 chunk 传输。反代必须关闭 `proxy_buffering`（`canvas-proxy/index.js:86-88` 已有正确实现可抄）。
2. **10 分钟超时**：`image-storage.ts:27-29` 定义了 10 分钟下载超时，视频生成同理。nginx / 服务端 / 反代超时需要调到 ≥ 10min。
3. **30MB 请求体**：`canvas-agent/README.md:141` 提到单次请求体限制 30MB（agent 侧）。图片/视频 base64 上行需要相应放宽 `client_max_body_size`。

### (c) R5 是否真存在 base64 内联图片

**结论：不存在"base64 内联持久化"这一风险；但存在一个同等严重、形态不同的风险。**

**不存在的那部分**：
- 画布 JSON（`infinite-canvas:canvas_store`）里图片**不是** base64，而是 `content: "blob:http://..."` + `storageKey: "image:<nanoid>"`
- 证据：`web/src/types/canvas.ts:28-38`、`web/src/services/image-storage.ts:53-63`、`docs/content/docs/development/canvas-data-structure.zh-CN.mdx:19` 与 `:209`
- 因此**不需要**做"base64 大字段抽取 / 文档体积治理"这类迁移，改造量显著小于预期

**真正存在的风险（更严重）**：
- **`content` 是会话级 `blob:` URL，刷新或换浏览器即失效**；真实字节只活在当前浏览器的 IndexedDB `image_files` / `media_files` 里
- 所以现状是：**画布 JSON 本身可序列化、可导出，但"画布 JSON + 图"这个整体不可跨设备**。同一份 JSON 拿到另一台机器上打开，所有图片都是空
- 副作用：任何"把画布文档上云"的方案，**必须先解决对象存储**，否则上云后用户看到的是满屏碎图
- 佐证：`canvas-export.ts:11-32` 之所以要打包成"JSON + 独立二进制文件"的 ZIP，正是因为 JSON 不能自包含；`app-sync.ts:225-268` 之所以要"manifest + 逐文件 PUT"，同理

**必须处理的 4 个边界**（否则迁移会静默丢图）：
1. `web/src/services/image-storage.ts:44-47` —— CORS 不可读时**根本没有 storageKey**，只有远程 URL。这类节点无法迁移，需要在迁移时单独枚举并降级处理
2. `web/src/lib/canvas/canvas-generation-helpers.ts:63`、`:72` —— 旧数据 inline `data:image/...` 分支必须保留
3. `web/src/stores/use-asset-store.ts:64-66` —— 素材库的 base64 迁移分支同样必须保留
4. `web/src/lib/canvas/canvas-generation-helpers.ts:38` —— `metadata.references` 里存的是 `image:xxx` storageKey 字符串（不是图片对象），批量迁移时容易漏

**一句话**：R5 从"要治理 base64 大字段"变成了"**要新建对象存储 + storageKey 解析层**"。工作量性质变了（不是清洗数据，而是补一层基础设施），量级相当，甚至略大——因为必须顺带解决历史数据的 4 类边界。
