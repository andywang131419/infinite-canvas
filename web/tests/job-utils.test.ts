import { describe, expect, it } from "bun:test";

import {
    buildImageJobIdempotencyKey,
    firstImageStorageKey,
    isImageJobType,
    isTerminalJobStatus,
    jobErrorMessage,
    mapJobStatusToNodeStatus,
} from "../src/services/api/job-utils";

describe("幂等键", () => {
    it("同 nodeId + 同 imageId 必须永远得到同一个键（刷新恢复靠它去重，不稳定会重复扣费）", () => {
        const a = buildImageJobIdempotencyKey("node_1", "img_1");
        const b = buildImageJobIdempotencyKey("node_1", "img_1");
        expect(a).toBe(b);
        expect(a).toBe("node_1:img_1");
    });

    it("同一次生成里的 N 张图必须是 N 个不同的键（否则失败的那张没法单独重试）", () => {
        const keys = ["img_1", "img_2", "img_3", "img_4"].map((imageId) => buildImageJobIdempotencyKey("node_1", imageId));
        expect(new Set(keys).size).toBe(4);
    });

    it("不同节点即使 imageId 相同也要区分开", () => {
        expect(buildImageJobIdempotencyKey("node_1", "img_1")).not.toBe(buildImageJobIdempotencyKey("node_2", "img_1"));
    });
});

describe("状态判定", () => {
    it("终态只有 succeeded / failed / canceled", () => {
        expect(isTerminalJobStatus("succeeded")).toBe(true);
        expect(isTerminalJobStatus("failed")).toBe(true);
        expect(isTerminalJobStatus("canceled")).toBe(true);
        expect(isTerminalJobStatus("queued")).toBe(false);
        expect(isTerminalJobStatus("running")).toBe(false);
    });

    it("未知状态按未完成处理（未知当终态会让还在排队的任务被提前放弃）", () => {
        expect(isTerminalJobStatus("weird")).toBe(false);
        expect(isTerminalJobStatus(undefined)).toBe(false);
    });

    it("job 状态 → 节点状态：只有 succeeded 是 success", () => {
        expect(mapJobStatusToNodeStatus("succeeded")).toBe("success");
        expect(mapJobStatusToNodeStatus("failed")).toBe("error");
        expect(mapJobStatusToNodeStatus("canceled")).toBe("error");
        expect(mapJobStatusToNodeStatus("queued")).toBe("loading");
        expect(mapJobStatusToNodeStatus("running")).toBe("loading");
        expect(mapJobStatusToNodeStatus(undefined)).toBe("loading");
    });

    it("阶段 1 只接管 image / image_edit", () => {
        expect(isImageJobType("image")).toBe(true);
        expect(isImageJobType("image_edit")).toBe(true);
        expect(isImageJobType("video")).toBe(false);
        expect(isImageJobType("llm")).toBe(false);
        expect(isImageJobType(undefined)).toBe(false);
    });
});

describe("结果解析", () => {
    it("只认 image: 前缀的结果键，跳过别的东西", () => {
        expect(firstImageStorageKey(["video:abc", "image:def"])).toBe("image:def");
        expect(firstImageStorageKey(["video:abc"])).toBe(null);
        expect(firstImageStorageKey([])).toBe(null);
        expect(firstImageStorageKey(null)).toBe(null);
    });

    it("失败文案优先 errorMessage，其次 errorCode，都没有则空串交给上层兜底", () => {
        expect(jobErrorMessage({ errorMessage: "上游限流", errorCode: "QUOTA_EXCEEDED" })).toBe("上游限流");
        expect(jobErrorMessage({ errorMessage: null, errorCode: "QUOTA_EXCEEDED" })).toBe("QUOTA_EXCEEDED");
        expect(jobErrorMessage({ errorMessage: null, errorCode: null })).toBe("");
        expect(jobErrorMessage(null)).toBe("");
    });
});
