import * as path from "node:path";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";

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

export interface AppSettings {
    defaultModel: string | null;
    ollamaHost: string;
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
    // Text-to-speech: which browser/OS voice to use (voiceURI from
    // speechSynthesis.getVoices(), chosen client-side) and whether assistant
    // responses should be read aloud automatically as they finish.
    ttsVoiceURI?: string;
    ttsAutoRead?: boolean;
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
