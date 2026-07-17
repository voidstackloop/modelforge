import type { ProviderId } from "@/types/electron";

export interface CuratedModel {
    id: string;
    label: string;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
    ollama: "Ollama (local)",
    openai: "ChatGPT",
    anthropic: "Claude",
};

// Curated as of this app's last update — model lineups change often, so the
// model picker also lets you type a custom model ID directly.
export const OPENAI_MODELS: CuratedModel[] = [
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

// Sessions store a single "model" string; encode the provider into it since
// Ollama model names already contain colons (e.g. "llama3.1:8b").
export function formatModelRef(provider: ProviderId, modelId: string): string {
    return `${provider}:${modelId}`;
}

export function parseModelRef(ref: string): { provider: ProviderId; modelId: string } | null {
    const sepIndex = ref.indexOf(":");
    if (sepIndex === -1) return null;
    const provider = ref.slice(0, sepIndex) as ProviderId;
    if (provider !== "ollama" && provider !== "openai" && provider !== "anthropic") return null;
    return { provider, modelId: ref.slice(sepIndex + 1) };
}
