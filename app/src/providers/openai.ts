import { streamSSE } from "./sse";
import { describeHttpError, describeNetworkError } from "./errors";
import type { ChatFn, ToolDefinition } from "./types";

function toOpenAiTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

export const chat: ChatFn = async (apiKey, model, messages, options, onToken, signal, tools) => {
    const openaiMessages = messages.map((m) => {
        if (m.role === "tool") {
            return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        }

        const toolCalls =
            m.toolCalls && m.toolCalls.length > 0
                ? m.toolCalls.map((tc) => ({
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                  }))
                : undefined;

        if (!m.images || m.images.length === 0) {
            return { role: m.role, content: m.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
        }
        return {
            role: m.role,
            content: [
                ...(m.content ? [{ type: "text", text: m.content }] : []),
                ...m.images.map((img) => ({
                    type: "image_url",
                    image_url: { url: `data:${img.mimeType};base64,${img.data}` },
                })),
            ],
        };
    });

    let res: Response;
    try {
        res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: openaiMessages,
                stream: true,
                stream_options: { include_usage: true },
                temperature: options?.temperature ?? 0.7,
                top_p: options?.topP,
                max_tokens: options?.maxTokens,
                frequency_penalty: options?.frequencyPenalty,
                presence_penalty: options?.presencePenalty,
                ...(tools && tools.length > 0 ? { tools: toOpenAiTools(tools) } : {}),
            }),
            signal,
        });
    } catch (err) {
        throw describeNetworkError("OpenAI", err);
    }

    if (!res.ok || !res.body) {
        throw new Error(await describeHttpError(res, "OpenAI"));
    }

    // Tool-call arguments arrive as fragmented JSON string deltas, indexed by
    // position in the tool_calls array, across many SSE events — only valid
    // to parse once the stream signals finish_reason "tool_calls".
    const pendingToolCalls = new Map<number, { id: string; name: string; argsText: string }>();

    function flushToolCalls(): void {
        if (pendingToolCalls.size === 0) return;
        const toolCalls = [...pendingToolCalls.values()].map((tc) => {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(tc.argsText || "{}");
            } catch {
                // malformed arguments — surface as empty rather than crash the stream
            }
            return { id: tc.id, name: tc.name, arguments: args };
        });
        pendingToolCalls.clear();
        onToken({ done: false, toolCalls });
    }

    await streamSSE(res, (payload) => {
        if (payload === "[DONE]") {
            flushToolCalls();
            onToken({ done: true });
            return;
        }
        try {
            const parsed = JSON.parse(payload);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            if (delta?.content) {
                onToken({ message: { role: "assistant", content: delta.content }, done: false });
            }

            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls as Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                }>) {
                    const existing = pendingToolCalls.get(tc.index) ?? { id: tc.id ?? "", name: "", argsText: "" };
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name = tc.function.name;
                    if (tc.function?.arguments) existing.argsText += tc.function.arguments;
                    pendingToolCalls.set(tc.index, existing);
                }
            }

            if (choice?.finish_reason === "tool_calls") {
                flushToolCalls();
            }

            if (parsed.usage) {
                onToken({
                    done: false,
                    usage: {
                        promptTokens: parsed.usage.prompt_tokens,
                        completionTokens: parsed.usage.completion_tokens,
                    },
                });
            }
        } catch {
            // ignore malformed payload
        }
    });
};
