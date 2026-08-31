import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatChunk, ChatMessage, ChatOptions, ProviderId } from "./providers/types";

const execFileAsync = promisify(execFile);
const SAMPLE_INTERVAL_MS = 250;

export interface BenchmarkRequest {
    provider: ProviderId;
    model: string;
    maxContextLength?: number;
    outputTokens?: number;
    compareCpuGpu?: boolean;
}

export interface RuntimeHealthCheck {
    healthy: boolean;
    latencyMs: number;
    error?: string;
}

export interface ResourcePeaks {
    peakSystemRamMB: number;
    peakAppRamMB: number;
    peakVramMB: number | null;
    vramMeasurement: "nvidia-smi" | "rocm-smi" | "unavailable";
}

export interface InferenceMeasurement {
    mode: "default" | "cpu" | "gpu";
    tokensPerSecond: number;
    promptTokensPerSecond: number;
    timeToFirstTokenMs: number;
    totalTimeMs: number;
    promptTokens: number;
    completionTokens: number;
    resources: ResourcePeaks;
}

export interface ContextTestResult {
    requestedTokens: number;
    accepted: boolean;
    elapsedMs: number;
    error?: string;
}

export interface BenchmarkResult {
    schemaVersion: 1;
    id: string;
    createdAt: string;
    provider: ProviderId;
    model: string;
    health: RuntimeHealthCheck;
    primary: InferenceMeasurement | null;
    comparison: { cpu?: InferenceMeasurement; gpu?: InferenceMeasurement; supported: boolean; note?: string };
    contextTests: ContextTestResult[];
    warnings: string[];
}

export type BenchmarkChatExecutor = (
    provider: ProviderId,
    model: string,
    messages: ChatMessage[],
    options: ChatOptions,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal
) => Promise<void>;

interface GpuSample {
    usedMB: number | null;
    source: ResourcePeaks["vramMeasurement"];
}

function round(value: number, digits = 1): number {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

export function approximateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}

export function contextTestSizes(maximum: number): number[] {
    const cap = Math.max(2048, Math.min(131072, Math.floor(maximum)));
    const sizes: number[] = [];
    for (let size = 2048; size <= cap; size *= 2) sizes.push(size);
    if (sizes[sizes.length - 1] !== cap) sizes.push(cap);
    return sizes;
}

export function buildContextPrompt(targetTokens: number): string {
    // A repeated four-character token-like unit keeps allocation predictable.
    // Provider tokenizers differ, so the result remains an approximation.
    return `Context capacity test. Return only OK.\n${"test ".repeat(Math.max(1, targetTokens - 12))}`;
}

// A benchmark requests placement semantics, not a magic layer count. For
// node-llama-cpp, "max" maps to its memory-safe automatic offload. CPU mode
// remains explicit. This deliberately avoids the old `999` sentinel,
// which could exceed a model's real layer count and is not a portable runtime
// contract.
export function benchmarkPlacementOptions(mode: InferenceMeasurement["mode"]): Pick<ChatOptions, "gpuLayerMode" | "gpuLayers"> {
    if (mode === "cpu") return { gpuLayerMode: "cpu", gpuLayers: 0 };
    if (mode === "gpu") return { gpuLayerMode: "max" };
    return {};
}

async function sampleGpuMemory(): Promise<GpuSample> {
    try {
        const { stdout } = await execFileAsync(
            "nvidia-smi",
            ["--query-compute-apps=used_memory", "--format=csv,noheader,nounits"],
            { timeout: 2000, windowsHide: true }
        );
        const values = stdout.split(/\r?\n/).map(Number).filter(Number.isFinite);
        return { usedMB: values.length ? values.reduce((sum, value) => sum + value, 0) : 0, source: "nvidia-smi" };
    } catch {
        // Continue with the ROCm probe below.
    }
    try {
        const { stdout } = await execFileAsync("rocm-smi", ["--showmemuse", "--json"], { timeout: 2000, windowsHide: true });
        const parsed = JSON.parse(stdout) as Record<string, Record<string, string | number>>;
        let usedMB = 0;
        let found = false;
        for (const card of Object.values(parsed)) {
            for (const [key, raw] of Object.entries(card)) {
                if (!/memory.*used/i.test(key)) continue;
                const value = Number(String(raw).replace(/[^0-9.]/g, ""));
                if (Number.isFinite(value)) {
                    usedMB += value > 1024 * 1024 ? value / 1024 / 1024 : value;
                    found = true;
                }
            }
        }
        return { usedMB: found ? usedMB : null, source: "rocm-smi" };
    } catch {
        return { usedMB: null, source: "unavailable" };
    }
}

async function startResourceSampler(): Promise<{ stop: () => Promise<ResourcePeaks> }> {
    let stopped = false;
    let peakSystemRamMB = 0;
    let peakAppRamMB = 0;
    let peakVramMB: number | null = null;
    let vramMeasurement: ResourcePeaks["vramMeasurement"] = "unavailable";
    let pending = Promise.resolve();
    let gpuSampleInFlight = false;
    const sample = () => {
        const mem = process.memoryUsage();
        peakAppRamMB = Math.max(peakAppRamMB, mem.rss / 1024 / 1024);
        peakSystemRamMB = Math.max(peakSystemRamMB, (os.totalmem() - os.freemem()) / 1024 / 1024);
        if (gpuSampleInFlight) return;
        gpuSampleInFlight = true;
        pending = (async () => {
            const gpu = await sampleGpuMemory();
            if (gpu.usedMB !== null) peakVramMB = Math.max(peakVramMB ?? 0, gpu.usedMB);
            if (gpu.source !== "unavailable") vramMeasurement = gpu.source;
            gpuSampleInFlight = false;
        })();
    };
    sample();
    const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
    timer.unref();
    return {
        async stop() {
            if (!stopped) {
                stopped = true;
                clearInterval(timer);
                sample();
            }
            await pending;
            return {
                peakSystemRamMB: round(peakSystemRamMB),
                peakAppRamMB: round(peakAppRamMB),
                peakVramMB: peakVramMB === null ? null : round(peakVramMB),
                vramMeasurement,
            };
        },
    };
}

async function measureInference(
    execute: BenchmarkChatExecutor,
    request: BenchmarkRequest,
    mode: InferenceMeasurement["mode"],
    signal?: AbortSignal
): Promise<InferenceMeasurement> {
    const outputTokens = Math.max(8, Math.min(512, request.outputTokens ?? 96));
    const prompt = "Explain in concise technical terms why GPU memory bandwidth affects local language-model inference. Use complete sentences.";
    const started = performance.now();
    let firstTokenAt: number | null = null;
    let text = "";
    let reportedPromptTokens: number | undefined;
    let reportedCompletionTokens: number | undefined;
    const sampler = await startResourceSampler();
    const placement = benchmarkPlacementOptions(mode);
    try {
        await execute(
            request.provider,
            request.model,
            [{ role: "user", content: prompt }],
            { temperature: 0, maxTokens: outputTokens, seed: 42, ...placement },
            (chunk) => {
                const piece = chunk.message?.content ?? "";
                if (piece && firstTokenAt === null) firstTokenAt = performance.now();
                text += piece;
                reportedPromptTokens = chunk.usage?.promptTokens ?? reportedPromptTokens;
                reportedCompletionTokens = chunk.usage?.completionTokens ?? reportedCompletionTokens;
            },
            signal
        );
    } catch (error) {
        await sampler.stop();
        throw error;
    }
    const finished = performance.now();
    const resources = await sampler.stop();
    const promptTokens = reportedPromptTokens ?? approximateTokens(prompt);
    const completionTokens = reportedCompletionTokens ?? approximateTokens(text);
    const ttftMs = Math.max(0.1, (firstTokenAt ?? finished) - started);
    const generationMs = Math.max(1, finished - (firstTokenAt ?? finished));
    return {
        mode,
        tokensPerSecond: round((completionTokens * 1000) / generationMs, 2),
        promptTokensPerSecond: round((promptTokens * 1000) / ttftMs, 2),
        timeToFirstTokenMs: round(ttftMs),
        totalTimeMs: round(finished - started),
        promptTokens,
        completionTokens,
        resources,
    };
}

async function runContextTests(
    execute: BenchmarkChatExecutor,
    request: BenchmarkRequest,
    signal?: AbortSignal
): Promise<ContextTestResult[]> {
    const results: ContextTestResult[] = [];
    for (const requestedTokens of contextTestSizes(request.maxContextLength ?? 8192)) {
        const started = performance.now();
        try {
            await execute(
                request.provider,
                request.model,
                [{ role: "user", content: buildContextPrompt(requestedTokens) }],
                { temperature: 0, maxTokens: 1, contextLength: requestedTokens },
                () => undefined,
                signal
            );
            results.push({ requestedTokens, accepted: true, elapsedMs: round(performance.now() - started) });
        } catch (error) {
            results.push({ requestedTokens, accepted: false, elapsedMs: round(performance.now() - started), error: (error as Error).message });
            break;
        }
    }
    return results;
}

export async function runBenchmark(
    execute: BenchmarkChatExecutor,
    request: BenchmarkRequest,
    signal?: AbortSignal
): Promise<BenchmarkResult> {
    const createdAt = new Date().toISOString();
    const result: BenchmarkResult = {
        schemaVersion: 1,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt,
        provider: request.provider,
        model: request.model,
        health: { healthy: false, latencyMs: 0 },
        primary: null,
        comparison: { supported: false },
        contextTests: [],
        warnings: [],
    };
    const healthStarted = performance.now();
    try {
        result.primary = await measureInference(execute, request, "default", signal);
        result.health = { healthy: true, latencyMs: result.primary.timeToFirstTokenMs };
    } catch (error) {
        result.health = { healthy: false, latencyMs: round(performance.now() - healthStarted), error: (error as Error).message };
        return result;
    }

    if (request.compareCpuGpu) {
        if (request.provider === "llamacpp") {
            result.comparison.supported = true;
            result.comparison.cpu = await measureInference(execute, request, "cpu", signal);
            result.comparison.gpu = await measureInference(execute, request, "gpu", signal);
        } else {
            result.comparison.note = "CPU/GPU layer control is available only for the built-in llama.cpp runtime.";
        }
    }
    result.contextTests = await runContextTests(execute, request, signal);
    if (result.primary.resources.peakVramMB === null) {
        result.warnings.push("VRAM usage was unavailable; install nvidia-smi or rocm-smi for measured VRAM peaks.");
    }
    result.warnings.push("Prompt-processing speed uses time-to-first-token and therefore includes model loading and request latency.");
    return result;
}
