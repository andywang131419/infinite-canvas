/**
 * T04-A5 / A4 的行为测试。
 *
 * 覆盖三件事（都是"改了以后最容易悄悄退化"的点）：
 * 1. **对象引用比对**：同一个 project 对象没有被改动时，不产生第二次 PUT；
 * 2. **409 不自动覆盖**：冲突只登记、不重推、不改本地内容；
 * 3. **资产地址解析**：有 storageKey 给服务端同源地址，没有就回落 fallback。
 *
 * 用注入的假传输层（`setCanvasSyncTransport`）而不是 mock fetch，
 * 这样断言的是引擎的状态机，而不是 HTTP 细节。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getCanvasConflict, getCanvasSyncSnapshot, resetCanvasSyncState, setCanvasSyncTransport, startCanvasServerSync, flushCanvasSync, type CanvasSyncTransport } from "@/services/canvas-server-sync";
import { ServerApiError } from "@/services/server-api";
import { resolveImageUrl } from "@/services/image-storage";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

/** 造一个最小可用的画布。 */
function makeProject(id: string, title = "画布"): CanvasProject {
    const now = new Date().toISOString();
    return {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    };
}

/** 记录调用次数的假传输层。 */
function createTransport(options: { failWith?: () => Error } = {}) {
    const calls = { put: 0, remove: 0, list: 0, detail: 0, revision: 0 };
    const pushed: Array<{ id: string; baseRevision: number }> = [];

    const transport: CanvasSyncTransport = {
        put: async (id, body) => {
            calls.put += 1;
            if (options.failWith) throw options.failWith();
            pushed.push({ id, baseRevision: body.baseRevision });
            return { canvas: { id, title: body.title, revision: body.baseRevision + 1, nodeCount: 0, createdAt: "", updatedAt: "" }, sanitize: { dropped: 0 } };
        },
        remove: async () => {
            calls.remove += 1;
        },
        list: async () => {
            calls.list += 1;
            return { items: [], total: 0 };
        },
        detail: async (id) => {
            calls.detail += 1;
            return { canvas: { id, title: "", revision: 1, nodeCount: 0, createdAt: "", updatedAt: "", doc: {}, updatedByDevice: null } };
        },
        revision: async () => {
            calls.revision += 1;
            return { revision: 1, updatedAt: "" };
        },
    };

    return { transport, calls, pushed };
}

let dispose: (() => void) | null = null;

beforeEach(() => {
    resetCanvasSyncState();
    useCanvasStore.getState().replaceProjects([], []);
});

afterEach(() => {
    dispose?.();
    dispose = null;
    setCanvasSyncTransport(null);
    resetCanvasSyncState();
});

describe("canvas-server-sync", () => {
    it("对象引用没变就不重复推送，换对象才推", async () => {
        const { transport, calls, pushed } = createTransport();
        setCanvasSyncTransport(transport);

        const project = makeProject("c-ref");
        useCanvasStore.getState().replaceProjects([project], []);
        dispose = startCanvasServerSync();

        await flushCanvasSync();
        expect(calls.put).toBe(1);
        expect(pushed[0]).toEqual({ id: "c-ref", baseRevision: 0 });

        // 只换数组引用、project 对象还是同一个 → 引擎必须当成"没变"。
        useCanvasStore.getState().replaceProjects([project], []);
        await flushCanvasSync();
        expect(calls.put).toBe(1);

        // 换成新对象（模拟 updateProject 的写法）→ 必须再推一次。
        useCanvasStore.getState().replaceProjects([{ ...project, title: "改过标题" }], []);
        await flushCanvasSync();
        expect(calls.put).toBe(2);
        // 第二次推送带的是上次成功后的 revision（乐观锁基线）。
        expect(pushed[1]).toEqual({ id: "c-ref", baseRevision: 1 });
    });

    it("409 只登记冲突：不重推、不覆盖本地", async () => {
        const { transport, calls } = createTransport({
            failWith: () => new ServerApiError("REVISION_CONFLICT", "另一端已更新画布", 409, { latestRevision: 7, latestDoc: { title: "服务端版本", nodes: [], updatedAt: "2026-01-01T00:00:00.000Z" } }),
        });
        setCanvasSyncTransport(transport);

        const project = makeProject("c-conflict", "本机版本");
        useCanvasStore.getState().replaceProjects([project], []);
        dispose = startCanvasServerSync();

        await flushCanvasSync();

        expect(calls.put).toBe(1);
        const conflict = getCanvasConflict("c-conflict");
        expect(conflict).not.toBeNull();
        expect(conflict?.remoteRevision).toBe(7);
        expect(conflict?.localNodeCount).toBe(0);
        // 本地内容一个字都没被动过。
        expect(useCanvasStore.getState().projects[0]?.title).toBe("本机版本");
        expect(getCanvasSyncSnapshot().state).toBe("conflict");

        // 再 flush 一次也不会偷偷重试（等用户选）。
        await flushCanvasSync();
        expect(calls.put).toBe(1);
    });
});

describe("resolveImageUrl", () => {
    it("没有 storageKey 时回落到 fallback", async () => {
        expect(await resolveImageUrl(undefined, "data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
        expect(await resolveImageUrl("", "https://example.com/a.png")).toBe("https://example.com/a.png");
        // 非本命名空间的 key（远端地址）也原样回落。
        expect(await resolveImageUrl("https://cdn.example.com/a.png", "fallback.png")).toBe("fallback.png");
    });

    it("有 storageKey 时返回服务端同源地址", async () => {
        expect(await resolveImageUrl("image:abc123")).toBe("/api/assets/raw?key=image%3Aabc123");
    });
});
