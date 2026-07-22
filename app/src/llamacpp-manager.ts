import * as fs from "node:fs";
import * as path from "node:path";
import { getLlama, getLlamaGpuTypes, LlamaChatSession, type Llama, type LlamaModel } from "node-llama-cpp";
import type { ChatHistoryItem } from "node-llama-cpp";
import type { ChatMessage, ChatChunk, ChatOptions, ToolDefinition } from "./providers/types";

export type GpuBackend = "auto" | "vulkan" | "cuda" | "metal" | "cpu";

let llamaInstance: Llama | null = null;
let activeBackend: GpuBackend = "auto";
// Loaded model weights are the expensive, slow-to-load part (can be several
// GB) — kept warm across chat turns. The lightweight per-turn context/session
// below is deliberately NOT cached across turns; see chat() for why.
const modelCache = new Map<string, LlamaModel>();

export function setGpuBackend(backend: GpuBackend): void {
    if (backend === activeBackend) return;
    activeBackend = backend;
    // A running Llama instance is bound to whichever backend it was created
    // with — switching backends means starting over, and previously loaded
    // model weights are tied to the old instance too.
    llamaInstance = null;
    modelCache.clear();
}

async function getLlamaInstance(): Promise<Llama> {
    if (!llamaInstance) {
        llamaInstance = await getLlama({ gpu: activeBackend === "cpu" ? false : activeBackend });
    }
    return llamaInstance;
}

export async function getAvailableGpuBackends(): Promise<string[]> {
    try {
        const types = await getLlamaGpuTypes("supported");
        return types.filter((t): t is Exclude<typeof t, false> => t !== false);
    } catch {
        return [];
    }
}

async function loadModel(modelPath: string, gpuLayers?: number): Promise<LlamaModel> {
    const cached = modelCache.get(modelPath);
    if (cached) return cached;
    const llama = await getLlamaInstance();
    const model = await llama.loadModel({ modelPath, gpuLayers: gpuLayers ?? "auto" });
    modelCache.set(modelPath, model);
    return model;
}

export interface LocalGgufModel {
    name: string;
    path: string;
    sizeBytes: number;
}

export function listModels(modelsDir: string): LocalGgufModel[] {
    if (!fs.existsSync(modelsDir)) return [];
    return fs
        .readdirSync(modelsDir)
        .filter((f) => f.toLowerCase().endsWith(".gguf"))
        .map((f) => {
            const full = path.join(modelsDir, f);
            return { name: f, path: full, sizeBytes: fs.statSync(full).size };
        });
}

export function deleteModel(modelsDir: string, name: string): void {
    const root = path.resolve(modelsDir);
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error("Invalid model file name.");
    }
    fs.rmSync(target, { force: true });
    modelCache.delete(target);
}

// Maps this app's provider-agnostic ChatMessage[] (system/user/assistant,
// full history resent on every call — same shape every provider gets) onto
// node-llama-cpp's ChatHistoryItem[] shape. Tool/function-calling isn't
// wired up for this backend yet, so "tool" role messages and any tool calls
// on assistant messages are dropped rather than mistranslated.
function toHistory(messages: ChatMessage[]): ChatHistoryItem[] {
    const history: ChatHistoryItem[] = [];
    for (const m of messages) {
        if (m.role === "system") history.push({ type: "system", text: m.content });
        else if (m.role === "user") history.push({ type: "user", text: m.content });
        else if (m.role === "assistant") history.push({ type: "model", response: [m.content] });
        // "tool" messages are skipped — see note above.
    }
    return history;
}

export async function chat(
    modelPath: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal,
    tools?: ToolDefinition[]
): Promise<void> {
    if (tools && tools.length > 0) {
        throw new Error(
            "Agent mode isn't supported yet for the llama.cpp backend — switch to Ollama, OpenAI, or Claude for tool-calling, or turn Agent mode off."
        );
    }

    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            lastUserIndex = i;
            break;
        }
    }
    if (lastUserIndex === -1) throw new Error("No user message to respond to.");

    const model = await loadModel(modelPath, options?.gpuLayers);
    // A fresh context per call re-evaluates the whole conversation history
    // every turn instead of reusing a warm KV cache across turns — simpler
    // and always correct, at the cost of redoing prompt-processing work on
    // every message. Session-affinity caching (keeping a session alive
    // across turns of the same conversation) would fix that but needs a
    // stable conversation identity to key off of, which isn't threaded
    // through this call today.
    const context = await model.createContext({ contextSize: options?.contextLength });
    try {
        const sequence = context.getSequence();
        const priorMessages = messages.slice(0, lastUserIndex);
        const session = new LlamaChatSession({ contextSequence: sequence });
        if (priorMessages.length > 0) session.setChatHistory(toHistory(priorMessages));

        await session.prompt(messages[lastUserIndex].content, {
            signal,
            temperature: options?.temperature,
            topP: options?.topP,
            topK: options?.topK,
            maxTokens: options?.maxTokens,
            seed: options?.seed,
            customStopTriggers: options?.stop,
            onTextChunk: (text) => onToken({ message: { role: "assistant", content: text }, done: false }),
        });
        onToken({ done: true });
    } finally {
        await context.dispose();
    }
}
