import { describe, it, expect, vi } from "vitest";
import { createJob, updateJob, listJobs, type DownloadShard, type DownloadJobState } from "./download-jobs-store";
import { init, broadcast, configure, resumeInterruptedJobs } from "./download-queue";

function shard(overrides: Partial<DownloadShard> = {}): DownloadShard {
    return {
        filename: "model.gguf",
        path: "/models/model.gguf",
        expectedBytes: 1000,
        receivedBytes: 0,
        state: "queued",
        ...overrides,
    };
}

function makeJob(state: DownloadJobState) {
    const job = createJob({
        kind: "huggingface",
        modelName: "M",
        publisher: "org",
        backend: "llamacpp",
        destinationDir: "/models",
        modelId: "org/m",
        shards: [shard()],
    });
    updateJob(job.id, { state });
    return job.id;
}

describe("download-queue: broadcast plumbing", () => {
    it("normalizes controls without crashing when a plain dev build has no native addon", () => {
        expect(configure({ concurrency: 99, bandwidthMbps: -5 })).toEqual({ concurrency: 8, bandwidthMbps: 0 });
    });

    it("does nothing when no window has been registered via init()", () => {
        expect(() => broadcast()).not.toThrow();
    });

    it("sends the current job list to the registered window's webContents on broadcast", () => {
        const send = vi.fn();
        init(() => ({ webContents: { send } }) as never);
        broadcast();
        expect(send).toHaveBeenCalledWith("downloads:update", listJobs());
    });
});

describe("resumeInterruptedJobs", () => {
    it("requeues jobs stuck in downloading or resolving back to queued", () => {
        const downloadingId = makeJob("downloading");
        const resolvingId = makeJob("resolving");

        resumeInterruptedJobs();

        expect(listJobs().find((j) => j.id === downloadingId)?.state).toBe("queued");
        expect(listJobs().find((j) => j.id === resolvingId)?.state).toBe("queued");
    });

    it("leaves jobs in paused, ready, failed, or cancelled untouched", () => {
        const pausedId = makeJob("paused");
        const readyId = makeJob("ready");

        resumeInterruptedJobs();

        expect(listJobs().find((j) => j.id === pausedId)?.state).toBe("paused");
        expect(listJobs().find((j) => j.id === readyId)?.state).toBe("ready");
    });
});
