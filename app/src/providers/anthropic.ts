import { streamSSE } from "./sse";
import { describeHttpError, describeNetworkError } from "./errors";
import type { ChatFn, ToolDefinition } from "./types";

function toAnthropicTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

export const chat: ChatFn = async (apiKey, model, messages, options, onToken, signal, tools) => {
    // Anthropic's Messages API takes the system prompt as a top-level field,
    // not as a message with role "system".
    const systemPrompt = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");

    const conversation = messages
        .filter((m) => m.role !== "system")
        .map((m) => {
            // Anthropic has no "tool" role — a tool result is a "user" message
            // containing a tool_result content block referencing the call's id.
            if (m.role === "tool") {
                return {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
                };
            }

            const toolUseBlocks =
                m.toolCalls?.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments })) ?? [];

            if ((!m.images || m.images.length === 0) && toolUseBlocks.length === 0) {
                return { role: m.role, content: m.content };
            }

            return {
                role: m.role,
                content: [
                    ...(m.content ? [{ type: "text", text: m.content }] : []),
                    ...(m.images ?? []).map((img) => ({
                        type: "image",
                        source: { type: "base64", media_type: img.mimeType, data: img.data },
                    })),
                    ...toolUseBlocks,
                ],
            };
        });

    let res: Response;
    try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model,
                system: systemPrompt || undefined,
                messages: conversation,
                max_tokens: options?.maxTokens ?? 4096,
                stream: true,
                temperature: options?.temperature ?? 0.7,
                top_p: options?.topP,
                top_k: options?.topK,
                stop_sequences: options?.stop && options.stop.length > 0 ? options.stop : undefined,
                ...(tools && tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
            }),
            signal,
        });
    } catch (err) {
        throw describeNetworkError("Anthropic", err);
    }

    if (!res.ok || !res.body) {
        throw new Error(await describeHttpError(res, "Anthropic"));
    }

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    // Tool-use content blocks stream their `input` as fragmented JSON text
    // deltas (input_json_delta), keyed by block index alongside interleaved
    // text blocks — accumulate per-index and only parse once the block closes.
    const blocksByIndex = new Map<number, { type: string; id?: string; name?: string; jsonText: string }>();
    const completedToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    await streamSSE(res, (payload) => {
        try {
            const parsed = JSON.parse(payload);

            if (parsed.type === "content_block_start") {
                const block = parsed.content_block;
                if (block?.type === "tool_use") {
                    blocksByIndex.set(parsed.index, { type: "tool_use", id: block.id, name: block.name, jsonText: "" });
                }
            } else if (parsed.type === "content_block_delta") {
                if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
                    onToken({ message: { role: "assistant", content: parsed.delta.text }, done: false });
                } else if (parsed.delta?.type === "input_json_delta") {
                    const block = blocksByIndex.get(parsed.index);
                    if (block) block.jsonText += parsed.delta.partial_json ?? "";
                }
            } else if (parsed.type === "content_block_stop") {
                const block = blocksByIndex.get(parsed.index);
                if (block?.type === "tool_use" && block.id && block.name) {
                    let args: Record<string, unknown> = {};
                    try {
                        args = JSON.parse(block.jsonText || "{}");
                    } catch {
                        // malformed arguments — surface as empty rather than crash the stream
                    }
                    completedToolCalls.push({ id: block.id, name: block.name, arguments: args });
                }
            } else if (parsed.type === "message_start") {
                promptTokens = parsed.message?.usage?.input_tokens;
                completionTokens = parsed.message?.usage?.output_tokens;
            } else if (parsed.type === "message_delta") {
                completionTokens = parsed.usage?.output_tokens ?? completionTokens;
            } else if (parsed.type === "message_stop") {
                if (completedToolCalls.length > 0) {
                    onToken({ done: false, toolCalls: completedToolCalls.splice(0) });
                }
                onToken({ done: true, usage: { promptTokens, completionTokens } });
            }
        } catch {
            // ignore malformed payload
        }
    });
};
