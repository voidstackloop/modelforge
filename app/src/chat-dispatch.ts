import * as path from "node:path";
import { createHash } from "node:crypto";
import * as settingsStore from "./settings-store";
import * as secretsStore from "./secrets-store";
import * as llamacpp from "./llamacpp-manager";
import * as localServers from "./local-server-manager";
import * as powerMonitor from "./power-monitor";
import * as auditLogStore from "./audit-log-store";
import * as telemetry from "./telemetry";
import * as openaiProvider from "./providers/openai";
import * as anthropicProvider from "./providers/anthropic";
import * as geminiProvider from "./providers/gemini";
import { createOpenAiCompatibleChat } from "./providers/openai-compatible";
import type { ChatMessage, ChatChunk, ChatOptions, ProviderId, ToolDefinition } from "./providers/types";
import { PROVIDER_SECRET_KEYS, customProviderSecretKey, getLlamaCppModelsDir, getEnergyMonitorSettings } from "./app-state";
import { mainResourceOrchestrator } from "./resource-orchestrator";
import type { ResourcePriority } from "./resource-contracts";
import { logger } from "./logger";
import { sanitizeChatHistory } from "./chat-history-sanitizer";
import { applyRuntimeProfile } from "./resource-profiles";

/** Local-provider generation priority (item 19: "prioritize interactive
 * viewing over ... background jobs"). "active-inference" outranks every
 * background workload kind in RESOURCE_PRIORITY_RANK; "scheduled-inference"
 * sits below explicit user actions so a scheduled task never queues ahead of
 * (or gets admitted alongside, contending for the same GPU as) a live chat.
 * Never nested with a model-load lease: by the point each branch below
 * acquires this lease, loadModel()/ensureServer()'s own model-load lease has
 * already been acquired AND released (see llamacpp-manager.ts's chat() and
 * local-server-manager.ts's acquireServer()) — acquiring this one earlier,
 * around the load step too, would deadlock on the single exclusive-
 * accelerator admission slot. */
export type ChatDispatchPriority = Extract<ResourcePriority, "active-inference" | "scheduled-inference">;

// Bounded, non-clinical identifier for the local-inference audit trail (see
// docs/LOCAL_INFERENCE_HARDENING_PLAN.md §5) — a provider-qualified model
// reference only (e.g. "llamacpp:some-model.gguf"), never prompt/response
// content. Truncated defensively: nothing about a model id should ever need
// to be this long, but audit-log-store.ts's own convention for `detail`-style
// fields is "short".
function auditModelIdentifier(provider: ProviderId, model: string): string {
    const id = `${provider}:${model}`;
    return id.length > 200 ? `${id.slice(0, 200)}…` : id;
}

// Coarse circuit breaker (docs/LOCAL_INFERENCE_HARDENING_PLAN.md §4), not a
// real token-budget mechanism — context-length settings already govern that
// per-model. This exists only to refuse a pathological/malicious request
// (e.g. a bug or bad actor assembling a multi-hundred-MB message) before it
// ever reaches a local model process, at a size far beyond any realistic
// clinical conversation or any current local model's practical context
// window (roughly 1M tokens at 4 chars/token). Remote providers already
// enforce their own request-size limits server-side, so this only applies to
// local inference, where an oversized request is this app's own problem to
// catch.
const MAX_LOCAL_INFERENCE_REQUEST_CHARS = 4_000_000;

// Watchdog default (docs/LOCAL_INFERENCE_HARDENING_PLAN.md §3): previously no
// timeout existed for an in-flight generation at all, only explicit
// user-initiated cancel — and since every local workload competes for the
// single exclusive-accelerator admission slot, a hung generation could block
// every other local-inference workload behind it indefinitely. Deliberately
// generous rather than tuned to a real SLO (none is defined yet — see the
// plan's §3.3/§8): a hard backstop, not a latency target, so it should
// essentially never fire for a legitimately slow-but-progressing generation
// on constrained hardware. Overridable per-deployment without a code change,
// matching llamacpp-manager.ts's own MODELFORGE_LLAMACPP_IDLE_MINUTES
// precedent.
const configuredWatchdogMinutes = Number(process.env.MODELFORGE_LOCAL_INFERENCE_TIMEOUT_MINUTES ?? 10);
const LOCAL_INFERENCE_TIMEOUT_MS = Number.isFinite(configuredWatchdogMinutes) && configuredWatchdogMinutes > 0
    ? configuredWatchdogMinutes * 60_000
    : 10 * 60_000;

// Composes the caller's own cancel signal with an independent timeout so
// either can abort generation — a hung local model previously had no other
// backstop at all. Not built on the newer `AbortSignal.any()` to avoid a hard
// dependency on a specific Node version this app's bundled Electron runtime
// might not carry.
function createWatchdogSignal(callerSignal: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    return {
        signal: controller.signal,
        didTimeOut: () => timedOut,
        cleanup: () => {
            clearTimeout(timer);
            callerSignal?.removeEventListener("abort", onCallerAbort);
        },
    };
}

function generationLeaseRequest(priority: ChatDispatchPriority) {
    return {
        workloadKind: priority,
        priority,
        requirements: { cpuThreads: 1, ramMB: 0, accelerator: "preferred" as const, allowCpuFallback: true, exclusiveAccelerator: true },
    };
}

// Shared by chat:send (renderer-driven, streams tokens back over IPC) and
// the scheduled-task runner (background, wants the full text once done) —
// same provider dispatch and error handling either way.
export async function dispatchChat(
    provider: ProviderId,
    model: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
    priority: ChatDispatchPriority = "active-inference",
    diagnosticId?: string,
    conversationId?: string
): Promise<void> {
    const traceId = (diagnosticId || (priority === "scheduled-inference" ? "scheduled" : "interactive")).slice(0, 64);
    const rawMessageCount = messages.length;
    const sanitized = sanitizeChatHistory(messages);
    messages = sanitized.messages;
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const latestUserFingerprint = latestUser
        ? createHash("sha256").update(latestUser.content).digest("hex").slice(0, 12)
        : "none";
    const exclusionSummary = sanitized.exclusions.length === 0
        ? "none"
        : [...new Set(sanitized.exclusions.map((item) => item.reason))]
            .map((reason) => `${reason}:${sanitized.exclusions.filter((item) => item.reason === reason).length}`)
            .join(",");
    const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    // PHI-safe diagnostic record: never writes prompt or response text. The
    // short SHA-256 fingerprint lets two requests be correlated without
    // making clinical content recoverable from the log.
    logger.info(
        `[inference:${traceId}] start provider=${provider} model=${auditModelIdentifier(provider, model)} ` +
        `messages=${rawMessageCount}->${messages.length} roles=${messages.map((message) => message.role[0]).join("")} ` +
        `chars=${promptChars} latestUserChars=${latestUser?.content.length ?? 0} latestUserSha256=${latestUserFingerprint} ` +
        `excluded=${exclusionSummary} contextReset=${sanitized.resetApplied} context=${options?.contextLength ?? "auto"} maxTokens=${options?.maxTokens ?? "default"} ` +
        `temperature=${options?.temperature ?? "default"} tools=${tools?.length ?? 0}`
    );
    const currentSettings = settingsStore.getSettings();
    const customLocal = provider === "custom"
        && currentSettings.customProviders?.find((item) => model.startsWith(`${item.id}::`))?.localGpuBackend;
    const localProvider = ["llamacpp", "mlx", "rocm", "vllm"].includes(provider) || !!customLocal;
    if (localProvider) {
        const profile = currentSettings.resourceRuntimeProfile ?? (priority === "active-inference" ? "interactive" : "balanced");
        options = applyRuntimeProfile(options, profile, {
            maxCpuThreads: currentSettings.llamaCppMaxThreads,
            maxBatchSize: currentSettings.llamaCppBatchSize,
        });
    }
    const energySettings = getEnergyMonitorSettings();
    energySettings.enabled = energySettings.enabled && localProvider;
    const backend = provider === "llamacpp"
        ? currentSettings.llamaCppGpuBackend ?? "auto"
        : provider === "rocm" ? "rocm" : provider;
    const initialPromptTokens = Math.max(1, Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4));
    const activity = powerMonitor.beginRequest(provider, model, backend, energySettings, initialPromptTokens);
    const downstreamToken = onToken;
    onToken = (chunk) => {
        activity.onChunk(chunk);
        downstreamToken(chunk);
    };
    const startedAt = Date.now();
    let outcome: "success" | "cancelled" | "failed" | "timed-out" = "success";
    const watchdog = localProvider ? createWatchdogSignal(signal, LOCAL_INFERENCE_TIMEOUT_MS) : null;
    const effectiveSignal = watchdog?.signal ?? signal;
    try {
    if (localProvider) {
        const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
        if (totalChars > MAX_LOCAL_INFERENCE_REQUEST_CHARS) {
            throw new Error(
                `This request (${totalChars.toLocaleString()} characters) exceeds the local-inference safety limit of ${MAX_LOCAL_INFERENCE_REQUEST_CHARS.toLocaleString()} characters.`
            );
        }
    }
    if (provider === "llamacpp") {
        // Same containment rule as the rocm branch below: the model ref is a
        // renderer-supplied relative path (may include subfolders), and
        // path.join would happily walk ".." segments out of the models dir.
        const root = path.resolve(getLlamaCppModelsDir());
        const modelPath = path.resolve(root, model);
        if (modelPath === root || !modelPath.startsWith(root + path.sep)) {
            throw new Error(`Model file "${model}" is outside the models directory.`);
        }
        // priority threads into llamacpp.chat() itself rather than wrapping
        // the call here: that function's own loadModel() takes the exclusive
        // accelerator slot on a cache miss, and it must fully release it
        // before this module acquires it again for generation.
        await llamacpp.chat(modelPath, messages, options, onToken, effectiveSignal, tools, priority, traceId, conversationId);
    } else if (provider === "mlx" || provider === "rocm" || provider === "vllm") {
        const settings = settingsStore.getSettings();
        // ROCm serves the same GGUF files as the llama.cpp backend, so the
        // model ref is a filename that must stay inside the models dir; MLX
        // models are HF repo ids the server resolves itself.
        let serverModel = model;
        if (provider === "rocm") {
            const root = path.resolve(getLlamaCppModelsDir());
            const resolved = path.resolve(root, model);
            // Was `resolved !== root && !startsWith(...)` (AND) — that only
            // threw when BOTH conditions held, so a ref resolving to exactly
            // the models dir itself (e.g. "rocm:.") satisfied neither and
            // slipped through, handing the whole directory to llama-server
            // -m as if it were a single model file.
            if (resolved === root || !resolved.startsWith(root + path.sep)) {
                throw new Error(`Model file "${model}" is outside the models directory.`);
            }
            serverModel = resolved;
        }
        const lease = await localServers.acquireServer(provider, serverModel, {
            mlxPythonPath: settings.mlxPythonPath,
            rocmServerPath: settings.rocmServerPath,
            vllmCommand: settings.vllmCommand,
        });
        try {
            const providerLabel = provider === "mlx" ? "MLX" : provider === "vllm" ? "vLLM" : "ROCm llama-server";
            await mainResourceOrchestrator.withLease(generationLeaseRequest(priority), () => createOpenAiCompatibleChat(`${lease.baseUrl}/v1`, providerLabel)(
                lease.apiKey,
                model,
                messages,
                options,
                onToken,
                effectiveSignal,
                tools
            ));
        } finally {
            lease.release();
        }
    } else if (provider === "custom") {
        // model is "<customProviderId>::<actual model id>" — see
        // frontend/src/lib/providers.ts's formatCustomModelRef.
        const sep = model.indexOf("::");
        if (sep === -1) throw new Error(`Malformed custom model reference: ${model}`);
        const customProviderId = model.slice(0, sep);
        const actualModel = model.slice(sep + 2);
        const config = settingsStore.getSettings().customProviders?.find((p) => p.id === customProviderId);
        if (!config) throw new Error(`Custom provider "${customProviderId}" is no longer configured.`);
        const apiKey = secretsStore.getSecret(customProviderSecretKey(customProviderId));
        if (!apiKey && !config.localGpuBackend) throw new Error(`No API key set for ${config.name}. Add one in Settings.`);
        await createOpenAiCompatibleChat(config.baseUrl, config.name)(
            apiKey ?? "local-gpu-backend",
            actualModel,
            messages,
            options,
            onToken,
            effectiveSignal,
            tools
        );
    } else {
        const secretKey = PROVIDER_SECRET_KEYS[provider];
        const apiKey = secretsStore.getSecret(secretKey);
        if (!apiKey) throw new Error(`No API key set for ${provider}. Add one in Settings.`);
        const providerFn =
            provider === "openai" ? openaiProvider.chat : provider === "anthropic" ? anthropicProvider.chat : geminiProvider.chat;
        await providerFn(apiKey, model, messages, options, onToken, effectiveSignal, tools);
    }
    } catch (error) {
        outcome = watchdog?.didTimeOut() ? "timed-out" : signal?.aborted ? "cancelled" : "failed";
        throw error;
    } finally {
        watchdog?.cleanup();
        await activity.finish();
        // Local-inference accountability (docs/LOCAL_INFERENCE_HARDENING_PLAN.md
        // §5) — bounded metadata only (provider-qualified model id, outcome,
        // duration), matching this store's PHI-free-by-construction design.
        // Never gated on success: a rejected/failed call is exactly the kind
        // of anomaly an audit trail exists to capture.
        if (localProvider) {
            const durationMs = Date.now() - startedAt;
            logger.info(`[inference:${traceId}] finish provider=${provider} outcome=${outcome} durationMs=${durationMs}`);
            auditLogStore.recordEvent("model-call-local", {
                targetType: "model",
                targetId: auditModelIdentifier(provider, model),
                detail: outcome,
                durationMs,
            });
            // Operational telemetry (docs/LOCAL_INFERENCE_HARDENING_PLAN.md
            // §5) — a separate system from the audit trail above (see
            // telemetry/schema.ts's own doc comment on why): this feeds
            // performance-regression tracking and incident visibility, not
            // accountability. The cast is safe: `localProvider` is only ever
            // true for exactly the values telemetry's local-provider enum
            // covers (a plain `.includes()` check isn't a type guard TS can
            // narrow on by itself).
            telemetry.recordEvent("inference_completed", {
                provider: provider as Extract<ProviderId, "llamacpp" | "mlx" | "rocm" | "vllm" | "custom">,
                outcome,
                durationMs,
            });
        }
    }
}

// Runs a single-turn prompt to completion and returns the full text —
// what the scheduled-task runner needs, as opposed to chat:send's
// token-by-token streaming back to the renderer.
export async function completePrompt(provider: ProviderId, model: string, prompt: string): Promise<string> {
    let text = "";
    await dispatchChat(provider, model, [{ role: "user", content: prompt }], undefined, (chunk) => {
        text += chunk.message?.content ?? "";
    }, undefined, undefined, "scheduled-inference");
    return text;
}
