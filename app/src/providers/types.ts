export interface UsageInfo {
    promptTokens?: number;
    completionTokens?: number;
}

export interface MessageImage {
    mimeType: string;
    data: string;
}

export interface ToolParameterSchema {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    usage?: UsageInfo;
    images?: MessageImage[];
    // Present on an assistant message that requested one or more tool calls.
    toolCalls?: ToolCall[];
    // Present on a "tool" role message: which call this is the result of.
    toolCallId?: string;
    toolName?: string;
}

export interface ChatChunk {
    message?: { role: string; content: string };
    done: boolean;
    usage?: UsageInfo;
    toolCalls?: ToolCall[];
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
    signal?: AbortSignal,
    tools?: ToolDefinition[]
) => Promise<void>;
