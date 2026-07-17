export interface UsageInfo {
    promptTokens?: number;
    completionTokens?: number;
}

export interface MessageImage {
    mimeType: string;
    data: string;
}

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
    usage?: UsageInfo;
    images?: MessageImage[];
}

export interface ChatChunk {
    message?: { role: string; content: string };
    done: boolean;
    usage?: UsageInfo;
}

export type ProviderId = "ollama" | "openai" | "anthropic";

export interface ChatOptions {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    // Ollama-only: how much conversation history the model actually processes
    // (num_ctx). Cloud providers fix this per-model and don't expose it via API.
    contextLength?: number;
}

export type ChatFn = (
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal
) => Promise<void>;
