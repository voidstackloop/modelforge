import * as path from "node:path";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";
import type { McpServerConfig } from "./mcp-client";

export interface PromptVersion {
    prompt: string;
    savedAt: string;
}

export interface PromptPreset {
    id: string;
    name: string;
    prompt: string;
    // Previous versions of `prompt`, newest first, capped at 10 — pushed here
    // whenever an edit overwrites the current content, so a bad edit can be
    // undone.
    versions?: PromptVersion[];
    createdAt?: string;
    updatedAt?: string;
}

export interface CustomProviderConfig {
    id: string;
    name: string;
    // Base URL up to and including the version segment, e.g.
    // "https://api.groq.com/openai/v1" — "/chat/completions" is appended.
    baseUrl: string;
    modelIds: string[];
    // Local GPU runtimes such as vLLM, LocalAI, TGI, or custom llama-server
    // builds commonly expose an unauthenticated OpenAI-compatible endpoint.
    localGpuBackend?: boolean;
}

export interface AppSettings {
    defaultModel: string | null;
    ollamaHost: string;
    // undefined = Ollama's own default location. Only takes effect the next
    // time this app (re)starts a local `ollama serve` process.
    modelsDir?: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    contextLength: number;
    // undefined = auto (let Ollama decide how many layers to offload to GPU).
    gpuLayers?: number;
    seed?: number;
    topK?: number;
    repeatPenalty?: number;
    stop?: string[];
    systemPrompt: string;
    promptPresets: PromptPreset[];
    theme: "light" | "dark" | "system";
    language: "en" | "tr";
    uiDensity?: "comfortable" | "compact";
    reduceMotion?: boolean;
    agentMaxSteps?: number;
    llamaCppMaxCachedModels?: number;
    // Text-to-speech: which browser/OS voice to use (voiceURI from
    // speechSynthesis.getVoices(), chosen client-side) and whether assistant
    // responses should be read aloud automatically as they finish.
    ttsVoiceURI?: string;
    ttsAutoRead?: boolean;
    // MCP (Model Context Protocol) servers the user has configured. Only
    // configuration is persisted here — live connection state (process
    // handles, discovered tools) lives in mcp-client.ts and is rebuilt on
    // launch / reconnect, never serialized.
    mcpServers?: McpServerConfig[];
    // Where downloaded GGUF files for the llama.cpp backend are stored.
    // Separate from `modelsDir` (which configures Ollama's own OLLAMA_MODELS
    // directory) since the two backends use incompatible on-disk layouts.
    llamaCppModelsDir?: string;
    llamaCppGpuBackend?: "auto" | "vulkan" | "cuda" | "metal" | "cpu";
    // User-added OpenAI-compatible endpoints (Groq, Mistral, DeepSeek, xAI,
    // OpenRouter, or anything else that speaks the same API) — each one's
    // API key is stored separately via secretsStore, keyed by its id.
    customProviders?: CustomProviderConfig[];
    // Set once the first-run provider setup wizard has been completed (or
    // explicitly skipped), so it doesn't reappear on every launch.
    onboardingComplete?: boolean;
    // User-remapped shortcuts, keyed by action name, normalized as
    // "mod+shift+k" (mod = Ctrl/Cmd). Covers both menu-accelerator actions
    // (KeybindingAction, above) and renderer-only ones the frontend matches
    // in JS (command palette, shortcuts dialog) — this store doesn't
    // distinguish the two, it just persists whatever the renderer sends.
    keybindings?: Record<string, string>;
    // MLX backend (Apple Silicon): Hugging Face repo ids (e.g.
    // "mlx-community/Llama-3.2-3B-Instruct-4bit") or local paths served via
    // `python -m mlx_lm.server`.
    mlxModels?: string[];
    // Python interpreter used to launch mlx_lm.server. Default: python3.
    mlxPythonPath?: string;
    // Path to a ROCm/HIP build of llama.cpp's llama-server binary — enables
    // the "rocm" provider against the same GGUF dir as the llama.cpp backend.
    rocmServerPath?: string;
    // Hugging Face model ids or local model paths served by the app-managed
    // vLLM runtime. The `vllm` executable is discovered from PATH by default.
    vllmModels?: string[];
    vllmCommand?: string;
    // Agent-mode sandboxing. Network tools (web_search, fetch_url,
    // http_request, capture_page_screenshot, the GitHub tools) are gated by
    // this flag directly — 100% enforceable on every platform, since it's
    // just refusing to run the tool at all rather than trying to block
    // network access after the fact.
    networkToolsEnabled?: boolean;
    // Safety-net resource caps applied to run_command/run_code/background
    // commands (see resource-monitor.ts) — generous defaults, meant to catch
    // a runaway process rather than act as a real resource quota system.
    sandboxMaxMemoryMB?: number;
    sandboxMaxCpuPercent?: number;
}

const DEFAULTS: AppSettings = {
    defaultModel: null,
    ollamaHost: "http://127.0.0.1:11434",
    temperature: 0.7,
    topP: 1,
    maxTokens: 2048,
    frequencyPenalty: 0,
    presencePenalty: 0,
    contextLength: 4096,
    systemPrompt: "You are a helpful assistant.",
    promptPresets: [],
    theme: "system",
    language: "en",
    uiDensity: "comfortable",
    reduceMotion: false,
    agentMaxSteps: 25,
    llamaCppMaxCachedModels: 2,
    networkToolsEnabled: true,
    sandboxMaxMemoryMB: 2048,
};

function filePath(): string {
    return path.join(app.getPath("userData"), "settings.json");
}

export function getSettings(): AppSettings {
    return { ...DEFAULTS, ...readJson<Partial<AppSettings>>(filePath(), {}) };
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
    const merged = { ...getSettings(), ...partial };
    writeJson(filePath(), merged);
    return merged;
}
