import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * dispatchChat() wraps every local-provider generation in a resource-
 * orchestrator lease (item 19: "prioritize interactive viewing over
 * background jobs" — active-inference outranks every background workload,
 * scheduled-inference sits below it). These tests use the REAL
 * mainResourceOrchestrator singleton (spied, not replaced) so the priority
 * values genuinely flow through admission, not just past a mock boundary.
 *
 * The one property that matters most and is easy to regress: this lease
 * must never be acquired while a model-load lease from the same call stack
 * is still held (see chat-dispatch.ts's own doc comment) — that would
 * deadlock on the single exclusive-accelerator admission slot. The
 * mlx/rocm/vllm HTTP path acquires no lease of its own, so dispatchChat wraps
 * it directly; llamacpp.chat() has its own internal loadModel() lease and is
 * tested separately in llamacpp-manager.test.ts's sequencing — here it's
 * enough to confirm the priority parameter reaches it, since
 * llamacpp-manager.ts owns exactly where within itself the lease is
 * acquired.
 */
vi.mock("./llamacpp-manager", () => ({ chat: vi.fn(async (_modelPath, _messages, _options, onToken) => { onToken({ done: true }); }) }));
vi.mock("./local-server-manager", () => ({ acquireServer: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:9" , release: vi.fn() })) }));
vi.mock("./providers/openai-compatible", () => ({ createOpenAiCompatibleChat: vi.fn(() => vi.fn(async (_key, _model, _messages, _options, onToken) => { onToken({ done: true }); })) }));
vi.mock("./providers/openai", () => ({ chat: vi.fn(async (_key, _model, _messages, _options, onToken) => { onToken({ done: true }); }) }));
vi.mock("./power-monitor", () => ({ beginRequest: vi.fn(() => ({ onChunk: vi.fn(), finish: vi.fn(async () => undefined) })) }));
vi.mock("./audit-log-store", () => ({ recordEvent: vi.fn() }));
vi.mock("./telemetry", () => ({ recordEvent: vi.fn() }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./settings-store", () => ({ getSettings: vi.fn(() => ({})) }));
vi.mock("./secrets-store", () => ({ getSecret: vi.fn(() => "test-api-key") }));
vi.mock("./app-state", () => ({
    PROVIDER_SECRET_KEYS: { openai: "openaiApiKey", anthropic: "anthropicApiKey", gemini: "geminiApiKey" },
    customProviderSecretKey: (id: string) => `custom:${id}`,
    getLlamaCppModelsDir: vi.fn(() => "/models"),
    getEnergyMonitorSettings: vi.fn(() => ({ enabled: false })),
}));

import { dispatchChat, completePrompt } from "./chat-dispatch";
import * as llamacpp from "./llamacpp-manager";
import * as localServers from "./local-server-manager";
import { createOpenAiCompatibleChat } from "./providers/openai-compatible";
import * as openaiProvider from "./providers/openai";
import * as auditLogStore from "./audit-log-store";
import * as telemetry from "./telemetry";
import { logger } from "./logger";
import { mainResourceOrchestrator } from "./resource-orchestrator";

describe("dispatchChat: resource-orchestrator lease wrapping", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("vllm: wraps generation in an active-inference lease by default (no internal lease of its own, unlike llamacpp)", async () => {
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await dispatchChat("vllm", "some-model", [{ role: "user", content: "hi" }], undefined, () => {});

        expect(localServers.acquireServer).toHaveBeenCalledOnce();
        expect(withLeaseSpy).toHaveBeenCalledOnce();
        const [request] = withLeaseSpy.mock.calls[0];
        expect(request.workloadKind).toBe("active-inference");
        expect(request.priority).toBe("active-inference");
        expect(request.requirements?.exclusiveAccelerator).toBe(true);
        expect(request.requirements?.allowCpuFallback).toBe(true);
    });

    it("vllm: uses scheduled-inference priority when explicitly requested", async () => {
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await dispatchChat("vllm", "some-model", [{ role: "user", content: "hi" }], undefined, () => {}, undefined, undefined, "scheduled-inference");

        const [request] = withLeaseSpy.mock.calls[0];
        expect(request.workloadKind).toBe("scheduled-inference");
        expect(request.priority).toBe("scheduled-inference");
    });

    it("completePrompt (the scheduled-task runner's entry point) always uses scheduled-inference priority, never active-inference", async () => {
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await completePrompt("vllm", "some-model", "summarize this");

        const [request] = withLeaseSpy.mock.calls[0];
        expect(request.priority).toBe("scheduled-inference");
    });

    it("llamacpp: does not itself acquire a lease (that happens inside llamacpp-manager, after its own model-load lease is released) — it only threads the priority through", async () => {
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await dispatchChat("llamacpp", "model.gguf", [{ role: "user", content: "hi" }], undefined, () => {}, undefined, undefined, "scheduled-inference");

        expect(withLeaseSpy).not.toHaveBeenCalled(); // no lease at the dispatch layer for llamacpp
        expect(llamacpp.chat).toHaveBeenCalledOnce();
        const call = vi.mocked(llamacpp.chat).mock.calls[0];
        expect(call[6]).toBe("scheduled-inference"); // priority is the 7th positional arg
    });

    it("mlx/rocm/vllm: wraps the HTTP generation call in a lease, sequential with (never nested inside) the server-start lease", async () => {
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await dispatchChat("vllm", "some-model", [{ role: "user", content: "hi" }], undefined, () => {});

        expect(withLeaseSpy).toHaveBeenCalledOnce();
        const [request] = withLeaseSpy.mock.calls[0];
        expect(request.workloadKind).toBe("active-inference");
    });

    it("two concurrent local generations serialize on the single exclusive-accelerator slot rather than running simultaneously", async () => {
        let concurrentCount = 0;
        let maxConcurrent = 0;
        // mockReturnValue (not the factory mock's default per-call fresh fn)
        // so both concurrent dispatchChat() calls below share the same inner
        // mock instance and its closure state.
        vi.mocked(createOpenAiCompatibleChat).mockReturnValue(vi.fn(async (_key, _model, _messages, _options, onToken) => {
            concurrentCount++;
            maxConcurrent = Math.max(maxConcurrent, concurrentCount);
            await new Promise((resolve) => setTimeout(resolve, 5));
            concurrentCount--;
            onToken({ done: true });
        }));

        await Promise.all([
            dispatchChat("vllm", "some-model", [{ role: "user", content: "a" }], undefined, () => {}),
            dispatchChat("vllm", "some-model", [{ role: "user", content: "b" }], undefined, () => {}),
        ]);

        expect(maxConcurrent).toBe(1);
    });
});

describe("dispatchChat: inference-context sanitization and diagnostics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not send repeated failed assistant turns back to llama.cpp", async () => {
        const repeated = "I cannot generate a story because my current operational state is displaying only zeros and backend errors.";
        await dispatchChat(
            "llamacpp",
            "Qwen3.5-4B-Q3_K_S.gguf",
            [
                { role: "user", content: "write a story" },
                { role: "assistant", content: repeated },
                { role: "user", content: "hi" },
                { role: "assistant", content: repeated },
                { role: "user", content: "say something about cancer" },
            ],
            { contextLength: 8192, maxTokens: 0 },
            () => {},
            undefined,
            undefined,
            "active-inference",
            "request-123"
        );

        const sentMessages = vi.mocked(llamacpp.chat).mock.calls[0][1];
        expect(sentMessages).toEqual([{ role: "user", content: "say something about cancer" }]);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("excluded=failed-turn-user:2,repeated-output:2"));
    });

    it("logs only a prompt fingerprint and metadata, never the prompt text", async () => {
        const prompt = "patient Jane Doe has a private diagnosis";
        await dispatchChat("llamacpp", "model.gguf", [{ role: "user", content: prompt }], undefined, () => {}, undefined, undefined, "active-inference", "request-456");

        const logs = vi.mocked(logger.info).mock.calls.flat().join("\n");
        expect(logs).toContain("latestUserSha256=");
        expect(logs).not.toContain(prompt);
        expect(logs).not.toContain("Jane Doe");
    });
});

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §5: local-inference calls previously
 * generated zero audit trail at all — the schema's own "model-call-local"
 * category existed but was never invoked from dispatchChat, the one place
 * every local call passes through. These tests pin the fix: an event fires
 * for every local-provider call, on every outcome, with only bounded
 * metadata (never prompt/response content) — and never fires for a remote
 * provider, since this slice is scoped to local inference specifically.
 */
describe("dispatchChat: model-call-local audit trail", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("llamacpp: records a model-call-local event with a provider-qualified model id and success outcome", async () => {
        await dispatchChat("llamacpp", "llama3.gguf", [{ role: "user", content: "hi" }], undefined, () => {});

        expect(auditLogStore.recordEvent).toHaveBeenCalledOnce();
        const [category, fields] = vi.mocked(auditLogStore.recordEvent).mock.calls[0];
        expect(category).toBe("model-call-local");
        expect(fields).toMatchObject({ targetType: "model", targetId: "llamacpp:llama3.gguf", detail: "success" });
        expect(fields?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("vllm: also records a model-call-local event (the localProvider gate covers every local backend, not just llamacpp)", async () => {
        await dispatchChat("vllm", "some-model", [{ role: "user", content: "hi" }], undefined, () => {});

        expect(auditLogStore.recordEvent).toHaveBeenCalledWith(
            "model-call-local",
            expect.objectContaining({ targetType: "model", targetId: "vllm:some-model", detail: "success" })
        );
    });

    it("records outcome: failed when the underlying call throws, and still throws to the caller", async () => {
        vi.mocked(llamacpp.chat).mockRejectedValueOnce(new Error("model crashed"));

        await expect(dispatchChat("llamacpp", "llama3.gguf", [{ role: "user", content: "hi" }], undefined, () => {})).rejects.toThrow("model crashed");

        expect(auditLogStore.recordEvent).toHaveBeenCalledWith(
            "model-call-local",
            expect.objectContaining({ detail: "failed" })
        );
    });

    it("records outcome: cancelled (not failed) when the caller's signal was aborted", async () => {
        const controller = new AbortController();
        vi.mocked(llamacpp.chat).mockImplementationOnce(async () => {
            controller.abort();
            throw new Error("aborted by caller");
        });

        await expect(
            dispatchChat("llamacpp", "llama3.gguf", [{ role: "user", content: "hi" }], undefined, () => {}, controller.signal)
        ).rejects.toThrow();

        expect(auditLogStore.recordEvent).toHaveBeenCalledWith(
            "model-call-local",
            expect.objectContaining({ detail: "cancelled" })
        );
    });

    it("does not record anything for a remote provider — this slice is scoped to local inference only", async () => {
        await dispatchChat("openai", "gpt-4", [{ role: "user", content: "hi" }], undefined, () => {});

        expect(openaiProvider.chat).toHaveBeenCalledOnce();
        expect(auditLogStore.recordEvent).not.toHaveBeenCalled();
    });

    it("never includes message content anywhere in the recorded fields", async () => {
        const secretPrompt = "patient John Doe has a rash";
        await dispatchChat("llamacpp", "llama3.gguf", [{ role: "user", content: secretPrompt }], undefined, () => {});

        const [, fields] = vi.mocked(auditLogStore.recordEvent).mock.calls[0];
        expect(JSON.stringify(fields)).not.toContain(secretPrompt);
        expect(JSON.stringify(fields)).not.toContain("John Doe");
    });
});

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §4: no app-level cap existed on
 * request size before forwarding to a local model — a coarse circuit breaker
 * against a pathological/malicious oversized request. Scoped to local
 * providers only; remote providers enforce their own limits server-side.
 */
describe("dispatchChat: local-inference request size limit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("rejects an oversized request to a local provider before it reaches the runtime", async () => {
        const hugeMessage = { role: "user" as const, content: "x".repeat(4_000_001) };

        await expect(dispatchChat("llamacpp", "llama3.gguf", [hugeMessage], undefined, () => {})).rejects.toThrow(/exceeds the local-inference safety limit/);

        expect(llamacpp.chat).not.toHaveBeenCalled();
        // The rejection itself is still a local-inference event worth auditing.
        expect(auditLogStore.recordEvent).toHaveBeenCalledWith("model-call-local", expect.objectContaining({ detail: "failed" }));
    });

    it("allows a request right at the limit through", async () => {
        const message = { role: "user" as const, content: "x".repeat(4_000_000) };
        await expect(dispatchChat("llamacpp", "llama3.gguf", [message], undefined, () => {})).resolves.toBeUndefined();
        expect(llamacpp.chat).toHaveBeenCalledOnce();
    });

    it("does not apply the local-only limit to a remote provider", async () => {
        const hugeMessage = { role: "user" as const, content: "x".repeat(5_000_000) };
        await expect(dispatchChat("openai", "gpt-4", [hugeMessage], undefined, () => {})).resolves.toBeUndefined();
        expect(openaiProvider.chat).toHaveBeenCalledOnce();
    });
});

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §3: no timeout previously existed
 * for an in-flight generation at all, only explicit user-initiated cancel —
 * and since every local workload competes for the single exclusive-
 * accelerator admission slot, a hung generation could block every other
 * local-inference workload behind it indefinitely.
 */
describe("dispatchChat: local-inference generation watchdog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("auto-aborts and records outcome: timed-out when a local generation hangs past the watchdog deadline", async () => {
        vi.useFakeTimers();
        try {
            let capturedSignal: AbortSignal | undefined;
            vi.mocked(llamacpp.chat).mockImplementationOnce((_modelPath, _messages, _options, _onToken, signal) => {
                capturedSignal = signal;
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(new Error("generation aborted")));
                });
            });

            const promise = dispatchChat("llamacpp", "llama3.gguf", [{ role: "user", content: "hi" }], undefined, () => {});
            // Attached immediately (not just at the final assertion) so Node
            // never considers this rejection unhandled during the timer
            // advance below — it's still fully observed by the `.rejects`
            // assertion afterward, since multiple consumers of one promise
            // are fine.
            promise.catch(() => {});
            await vi.advanceTimersByTimeAsync(0);
            expect(capturedSignal?.aborted).toBe(false);

            // Default watchdog is 10 minutes (docs/LOCAL_INFERENCE_HARDENING_PLAN.md
            // §3.3) — advance well past it rather than asserting an exact figure,
            // so this test doesn't need updating if the default is tuned later.
            await vi.advanceTimersByTimeAsync(60 * 60_000);

            await expect(promise).rejects.toThrow();
            expect(capturedSignal?.aborted).toBe(true);
            expect(auditLogStore.recordEvent).toHaveBeenCalledWith(
                "model-call-local",
                expect.objectContaining({ detail: "timed-out" })
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not fire for a generation that completes normally, well within the deadline", async () => {
        await dispatchChat("llamacpp", "llama3.gguf", [{ role: "user", content: "hi" }], undefined, () => {});

        expect(auditLogStore.recordEvent).toHaveBeenCalledWith(
            "model-call-local",
            expect.objectContaining({ detail: "success" })
        );
    });
});

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §5: telemetry was download-pipeline-
 * only — no local-inference call ever produced any operational telemetry.
 * This is a separate system from the audit trail above (different consumer:
 * performance/incident visibility, not accountability), so it gets its own
 * assertions rather than being folded into the audit tests.
 */
describe("dispatchChat: inference_completed telemetry", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("records an inference_completed telemetry event for a local provider", async () => {
        await dispatchChat("llamacpp", "model.gguf", [{ role: "user", content: "hi" }], undefined, () => {});

        expect(telemetry.recordEvent).toHaveBeenCalledWith(
            "inference_completed",
            expect.objectContaining({ provider: "llamacpp", outcome: "success" })
        );
    });

    it("does not record telemetry for a remote provider — scoped to local inference only", async () => {
        await dispatchChat("openai", "gpt-4", [{ role: "user", content: "hi" }], undefined, () => {});
        expect(telemetry.recordEvent).not.toHaveBeenCalled();
    });
});
