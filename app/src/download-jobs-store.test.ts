import { describe, it, expect } from "vitest";
import { listJobs, getJob, createJob, updateJob, deleteJob, type DownloadShard } from "./download-jobs-store";

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

describe("download-jobs-store", () => {
    it("starts with an empty list", () => {
        expect(listJobs()).toEqual([]);
    });

    it("creates a job with generated id, default state, and timestamps", () => {
        const job = createJob({
            kind: "huggingface",
            modelName: "Test Model",
            publisher: "test-org",
            backend: "llamacpp",
            destinationDir: "/models",
            modelId: "test-org/test-model",
            shards: [shard()],
        });
        expect(job.id).toBeTruthy();
        expect(job.state).toBe("queued");
        expect(job.retryCount).toBe(0);
        expect(job.createdAt).toBeTruthy();
        expect(job.updatedAt).toBe(job.createdAt);
        expect(listJobs().map((j) => j.id)).toContain(job.id);
    });

    it("round-trips a job through getJob", () => {
        const created = createJob({
            kind: "huggingface",
            modelName: "Another Model",
            publisher: "org",
            backend: "llamacpp",
            destinationDir: "/models",
            modelId: "org/another-model",
            shards: [shard()],
        });
        expect(getJob(created.id)).toEqual(created);
    });

    it("returns null for an unknown job id", () => {
        expect(getJob("does-not-exist")).toBeNull();
    });

    it("updates state, error, retryCount, and shards while bumping updatedAt", async () => {
        const created = createJob({
            kind: "huggingface",
            modelName: "M",
            publisher: "org",
            backend: "llamacpp",
            destinationDir: "/models",
            modelId: "org/m",
            shards: [shard()],
        });
        await new Promise((r) => setTimeout(r, 5));
        const updatedShards = [shard({ receivedBytes: 500 })];
        const updated = updateJob(created.id, { state: "downloading", shards: updatedShards, retryCount: 1 });
        expect(updated?.state).toBe("downloading");
        expect(updated?.shards).toEqual(updatedShards);
        expect(updated?.retryCount).toBe(1);
        expect(updated?.updatedAt).not.toBe(created.updatedAt);
    });

    it("returns null when updating an unknown job", () => {
        expect(updateJob("does-not-exist", { state: "ready" })).toBeNull();
    });

    it("sets a typed error with kind and retryable flags", () => {
        const created = createJob({
            kind: "huggingface",
            modelName: "M",
            publisher: "org",
            backend: "llamacpp",
            destinationDir: "/models",
            modelId: "org/m",
            shards: [shard()],
        });
        const updated = updateJob(created.id, {
            state: "failed",
            error: { message: "Gated repo — accept the license first.", kind: "license_required", retryable: false },
        });
        expect(updated?.error).toEqual({ message: "Gated repo — accept the license first.", kind: "license_required", retryable: false });
    });

    it("deletes a job", () => {
        const created = createJob({
            kind: "huggingface",
            modelName: "M",
            publisher: "org",
            backend: "llamacpp",
            destinationDir: "/models",
            modelId: "org/m",
            shards: [shard()],
        });
        deleteJob(created.id);
        expect(getJob(created.id)).toBeNull();
    });

    it("deleting an unknown job is a harmless no-op", () => {
        expect(() => deleteJob("does-not-exist")).not.toThrow();
    });
});
