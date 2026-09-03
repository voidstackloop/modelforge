import type { McpOperationProvenance } from "@modelforge/contracts";

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
    // MCP servers can supply arbitrary nested JSON Schema for their tools'
    // inputs, so this can't be narrowed further than `unknown` — providers
    // only ever pass it through opaquely to the model API, never inspect it.
    properties: Record<string, unknown>;
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
    // Immutable provenance for an assistant response. This is the full
    // provider-qualified ref (for example, "llamacpp:model.gguf") captured
    // before the request starts, not whichever model happens to be selected
    // in the UI when the message is rendered later.
    model?: string;
    // UI-visible messages with this marker remain in the saved transcript but
    // are never sent back to a model as conversation context. Used for local
    // runtime errors and other app-generated failure output.
    excludedFromContext?: boolean;
    usage?: UsageInfo;
    images?: MessageImage[];
    // Present on an assistant message that requested one or more tool calls.
    toolCalls?: ToolCall[];
    // Present on a "tool" role message: which call this is the result of.
    toolCallId?: string;
    toolName?: string;
    // User-set bookmark, purely a UI affordance — never sent to a provider.
    pinned?: boolean;
    // Set on the synthetic message the verification loop appends — a UI
    // affordance like `pinned`, never sent to a provider.
    isVerification?: boolean;
    mcpOperation?: McpOperationProvenance;
}

export interface ChatChunk {
    message?: { role: string; content: string };
    done: boolean;
    usage?: UsageInfo;
    toolCalls?: ToolCall[];
}

export type ProviderId = "openai" | "anthropic" | "llamacpp" | "gemini" | "custom" | "mlx" | "rocm" | "vllm";
export type GpuLayerMode = "auto" | "cpu" | "max" | "manual";
export type FlashAttentionMode = "auto" | "on" | "off";

export interface ChatOptions {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    // Local GGUF context window: the built-in llama.cpp runtime maps this to
    // createContext({ contextSize }). Cloud providers fix this per model and
    // don't expose it via API.
    contextLength?: number;
    // Local GGUF GPU placement — the built-in llama.cpp runtime's
    // resolveGpuLayers() also supports gpuLayerMode below.
    gpuLayers?: number;
    // Built-in node-llama-cpp controls. Other providers ignore these fields.
    gpuLayerMode?: GpuLayerMode;
    cpuThreads?: number;
    batchSize?: number;
    flashAttention?: FlashAttentionMode;
    performanceTracking?: boolean;
    // OpenAI only (Anthropic has no reproducibility param). Same seed + same
    // prompt should produce the same output, useful for testing.
    seed?: number;
    // Anthropic only (OpenAI doesn't expose top-k sampling).
    topK?: number;
    // No remaining provider consumes this (it was Ollama-only) — left in
    // place rather than removed outright since Settings/schemas.ts still
    // persist a user-facing value for it; a real cleanup candidate, not
    // wired to anything today.
    repeatPenalty?: number;
    // All providers: stop generation as soon as any of these strings appears.
    stop?: string[];
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
