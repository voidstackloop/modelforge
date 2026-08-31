import { describe, it, expect } from "vitest";
import { telemetryEventSchema, TELEMETRY_SCHEMA_VERSION } from "./schema";

function baseEvent(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        eventName: "download_started",
        timestamp: new Date().toISOString(),
        shardCount: 3,
        ...overrides,
    };
}

describe("telemetry schema", () => {
    it("accepts a well-formed event", () => {
        expect(telemetryEventSchema.safeParse(baseEvent()).success).toBe(true);
    });

    it("accepts an optional correlationId", () => {
        expect(telemetryEventSchema.safeParse(baseEvent({ correlationId: "job-123" })).success).toBe(true);
    });

    it("rejects an unknown/unreviewed field", () => {
        const result = telemetryEventSchema.safeParse(baseEvent({ modelFilename: "llama-3.gguf" }));
        expect(result.success).toBe(false);
    });

    it("rejects a path-shaped extra field just as readily as any other unknown field", () => {
        const result = telemetryEventSchema.safeParse(baseEvent({ destinationDir: "/home/alice/models" }));
        expect(result.success).toBe(false);
    });

    it("rejects an eventName not in the catalog", () => {
        const result = telemetryEventSchema.safeParse(baseEvent({ eventName: "download_exploded" }));
        expect(result.success).toBe(false);
    });

    it("rejects a wrong schemaVersion", () => {
        const result = telemetryEventSchema.safeParse(baseEvent({ schemaVersion: 999 }));
        expect(result.success).toBe(false);
    });

    it("rejects a download_retry event with an out-of-enum errorKind", () => {
        const result = telemetryEventSchema.safeParse({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventName: "download_retry",
            timestamp: new Date().toISOString(),
            attempt: 1,
            errorKind: "server_is_on_fire",
        });
        expect(result.success).toBe(false);
    });

    it("rejects a download_completed event missing a required field (retryCount)", () => {
        const result = telemetryEventSchema.safeParse({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventName: "download_completed",
            timestamp: new Date().toISOString(),
            outcome: "ready",
            durationMs: 1234,
        });
        expect(result.success).toBe(false);
    });

    it("accepts every declared download_completed outcome", () => {
        for (const outcome of ["ready", "failed", "cancelled"]) {
            const result = telemetryEventSchema.safeParse({
                schemaVersion: TELEMETRY_SCHEMA_VERSION,
                eventName: "download_completed",
                timestamp: new Date().toISOString(),
                outcome,
                durationMs: 1000,
                retryCount: 0,
            });
            expect(result.success, `outcome "${outcome}" should be valid`).toBe(true);
        }
    });

    it("rejects a native_addon_capability event with an addon value outside its closed enum", () => {
        const result = telemetryEventSchema.safeParse({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventName: "native_addon_capability",
            timestamp: new Date().toISOString(),
            addon: "sqlite-audit-store", // not yet a declared value — must be a deliberate schema edit, not silent
            available: true,
        });
        expect(result.success).toBe(false);
    });

    // docs/LOCAL_INFERENCE_HARDENING_PLAN.md §5: inference_completed is the
    // first telemetry event for local inference at all — previously zero
    // inference calls generated any telemetry.
    it("accepts every declared inference_completed provider and outcome", () => {
        for (const provider of ["llamacpp", "mlx", "rocm", "vllm", "custom"]) {
            for (const outcome of ["success", "failed", "cancelled", "timed-out"]) {
                const result = telemetryEventSchema.safeParse({
                    schemaVersion: TELEMETRY_SCHEMA_VERSION,
                    eventName: "inference_completed",
                    timestamp: new Date().toISOString(),
                    provider,
                    outcome,
                    durationMs: 42,
                });
                expect(result.success, `provider "${provider}" / outcome "${outcome}" should be valid`).toBe(true);
            }
        }
    });

    it("rejects an inference_completed event with a provider outside its closed enum", () => {
        const result = telemetryEventSchema.safeParse({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventName: "inference_completed",
            timestamp: new Date().toISOString(),
            provider: "openai", // remote providers are deliberately out of scope for this event family
            outcome: "success",
            durationMs: 42,
        });
        expect(result.success).toBe(false);
    });

    it("rejects an inference_completed event missing a required field (durationMs)", () => {
        const result = telemetryEventSchema.safeParse({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventName: "inference_completed",
            timestamp: new Date().toISOString(),
            provider: "llamacpp",
            outcome: "success",
        });
        expect(result.success).toBe(false);
    });

    it("never accepts free-text fields (e.g. a prompt or model path) on inference_completed", () => {
        const result = telemetryEventSchema.safeParse({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventName: "inference_completed",
            timestamp: new Date().toISOString(),
            provider: "llamacpp",
            outcome: "success",
            durationMs: 42,
            prompt: "patient John Doe has a rash",
        });
        expect(result.success).toBe(false);
    });
});
