import type { ProviderId } from "@/types/electron";

export interface CuratedModel {
    id: string;
    label: string;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
    ollama: "Ollama (local)",
    openai: "ChatGPT",
    anthropic: "Claude",
    llamacpp: "llama.cpp (local)",
    gemini: "Gemini",
    custom: "Custom",
    mlx: "MLX (Apple Silicon)",
    rocm: "ROCm (AMD)",
    vllm: "vLLM (managed)",
};

// Providers that run models on this machine — no API key, no per-token cost.
export const LOCAL_PROVIDERS: ProviderId[] = ["ollama", "llamacpp", "mlx", "rocm", "vllm"];

// Curated as of this app's last update — model lineups change often, so the
// model picker also lets you type a custom model ID directly.
export const OPENAI_MODELS: CuratedModel[] = [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "gpt-5-nano", label: "GPT-5 nano" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "o3", label: "o3" },
    { id: "o3-mini", label: "o3-mini" },
];

export const ANTHROPIC_MODELS: CuratedModel[] = [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const GEMINI_MODELS: CuratedModel[] = [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
];

// Base URL + a starting set of model IDs for one-click "add this provider"
// buttons — all speak the OpenAI-compatible chat-completions API, so no
// dedicated client code is needed per vendor, just its endpoint and models.
export interface CustomProviderPreset {
    name: string;
    baseUrl: string;
    modelIds: string[];
}

export const CUSTOM_PROVIDER_PRESETS: CustomProviderPreset[] = [
    { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", modelIds: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
    { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", modelIds: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"] },
    { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", modelIds: ["deepseek-chat", "deepseek-reasoner"] },
    { name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", modelIds: ["grok-4", "grok-4-fast", "grok-3"] },
    { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelIds: ["openai/gpt-5", "anthropic/claude-sonnet-5"] },
];

// Sessions store a single "model" string; encode the provider into it since
// Ollama model names already contain colons (e.g. "llama3.1:8b"). Custom
// providers encode a second identifier (which configured endpoint) ahead of
// the actual model id — see formatCustomModelRef.
export function formatModelRef(provider: ProviderId, modelId: string): string {
    return `${provider}:${modelId}`;
}

export function formatCustomModelRef(customProviderId: string, modelId: string): string {
    return formatModelRef("custom", `${customProviderId}::${modelId}`);
}

// Splits a "custom" provider's modelId portion back into which configured
// endpoint it targets and the actual model id sent to that endpoint.
export function parseCustomModelId(modelId: string): { customProviderId: string; actualModel: string } | null {
    const sep = modelId.indexOf("::");
    if (sep === -1) return null;
    return { customProviderId: modelId.slice(0, sep), actualModel: modelId.slice(sep + 2) };
}

const VALID_PROVIDERS: ProviderId[] = ["ollama", "openai", "anthropic", "llamacpp", "gemini", "custom", "mlx", "rocm", "vllm"];

export function parseModelRef(ref: string): { provider: ProviderId; modelId: string } | null {
    const sepIndex = ref.indexOf(":");
    if (sepIndex === -1) return null;
    const provider = ref.slice(0, sepIndex) as ProviderId;
    if (!VALID_PROVIDERS.includes(provider)) return null;
    return { provider, modelId: ref.slice(sepIndex + 1) };
}
