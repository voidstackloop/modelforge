import { spawn, ChildProcess } from "node:child_process";
import type { ChatMessage, ChatChunk, ChatOptions } from "./providers/types";

const DEFAULT_HOST = "http://127.0.0.1:11434";
let HOST = DEFAULT_HOST;
let child: ChildProcess | null = null;
let weStartedIt = false;

export function setHost(url: string | null | undefined): void {
    HOST = url && url.trim() ? url.trim().replace(/\/+$/, "") : DEFAULT_HOST;
}

export function getHost(): string {
    return HOST;
}

function isLocalHost(): boolean {
    try {
        const { hostname } = new URL(HOST);
        return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    } catch {
        return true;
    }
}

export interface OllamaModel {
    name: string;
    size: number;
    modified_at: string;
}

export type { ChatMessage, ChatChunk };

export interface PullProgress {
    status: string;
    digest?: string;
    total?: number;
    completed?: number;
}

export interface OllamaStartResult {
    alreadyRunning?: boolean;
    started?: boolean;
    error?: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isRunning(): Promise<boolean> {
    try {
        const res = await fetch(`${HOST}/api/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

export async function start(): Promise<OllamaStartResult> {
    if (await isRunning()) {
        return { alreadyRunning: true };
    }

    // A remote/non-default host is someone else's server — don't try to spawn
    // a local `ollama serve` for it, just report that it's unreachable.
    if (!isLocalHost()) {
        return { started: false, error: "remote-unreachable" };
    }

    try {
        child = spawn("ollama", ["serve"], { stdio: "ignore" });
        weStartedIt = true;

        child.on("exit", () => {
            child = null;
        });

        for (let i = 0; i < 20; i++) {
            await sleep(500);
            if (await isRunning()) {
                return { started: true };
            }
        }
        return { started: false, error: "timeout" };
    } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
            return { started: false, error: "not-installed" };
        }
        return { started: false, error: nodeErr.message };
    }
}

export function stop(): void {
    if (weStartedIt && child) {
        child.kill();
        child = null;
        weStartedIt = false;
    }
}

export async function listModels(): Promise<OllamaModel[]> {
    const res = await fetch(`${HOST}/api/tags`);
    if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
    const data = await res.json();
    return data.models || [];
}

export async function deleteModel(name: string): Promise<{ deleted: boolean }> {
    const res = await fetch(`${HOST}/api/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name }),
    });
    if (!res.ok) throw new Error(`Failed to delete model: ${res.status}`);
    return { deleted: true };
}

async function streamNdjson<T>(res: Response, onChunk: (chunk: T) => void): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;
            try {
                onChunk(JSON.parse(line) as T);
            } catch {
                // ignore malformed line
            }
        }
    }
}

export async function pullModel(name: string, onProgress: (chunk: PullProgress) => void): Promise<void> {
    const res = await fetch(`${HOST}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`Failed to pull model: ${res.status}`);
    await streamNdjson<PullProgress>(res, onProgress);
}

export async function chat(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal
): Promise<void> {
    // Ollama wants images as a sibling `images: string[]` (raw base64, no
    // data-URI prefix and no mimeType) field on each message.
    const ollamaMessages = messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images && m.images.length > 0 ? { images: m.images.map((i) => i.data) } : {}),
    }));

    const res = await fetch(`${HOST}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages: ollamaMessages,
            stream: true,
            options: {
                temperature: options?.temperature ?? 0.7,
                top_p: options?.topP,
                num_predict: options?.maxTokens,
                frequency_penalty: options?.frequencyPenalty,
                presence_penalty: options?.presencePenalty,
                num_ctx: options?.contextLength,
            },
        }),
        signal,
    });
    if (!res.ok || !res.body) throw new Error(`Chat request failed: ${res.status}`);

    await streamNdjson<
        ChatChunk & { prompt_eval_count?: number; eval_count?: number }
    >(res, (raw) => {
        if (raw.done && (raw.prompt_eval_count !== undefined || raw.eval_count !== undefined)) {
            onToken({
                ...raw,
                usage: { promptTokens: raw.prompt_eval_count, completionTokens: raw.eval_count },
            });
        } else {
            onToken(raw);
        }
    });
}
