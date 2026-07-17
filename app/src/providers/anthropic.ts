import { streamSSE } from "./sse";
import type { ChatFn } from "./types";

export const chat: ChatFn = async (apiKey, model, messages, options, onToken, signal) => {
    // Anthropic's Messages API takes the system prompt as a top-level field,
    // not as a message with role "system".
    const systemPrompt = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
    const conversation = messages
        .filter((m) => m.role !== "system")
        .map((m) => {
            if (!m.images || m.images.length === 0) return { role: m.role, content: m.content };
            return {
                role: m.role,
                content: [
                    ...(m.content ? [{ type: "text", text: m.content }] : []),
                    ...m.images.map((img) => ({
                        type: "image",
                        source: { type: "base64", media_type: img.mimeType, data: img.data },
                    })),
                ],
            };
        });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
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
        }),
        signal,
    });

    if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Anthropic request failed: ${res.status} ${errText}`);
    }

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    await streamSSE(res, (payload) => {
        try {
            const parsed = JSON.parse(payload);
            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                onToken({ message: { role: "assistant", content: parsed.delta.text }, done: false });
            } else if (parsed.type === "message_start") {
                promptTokens = parsed.message?.usage?.input_tokens;
                completionTokens = parsed.message?.usage?.output_tokens;
            } else if (parsed.type === "message_delta") {
                completionTokens = parsed.usage?.output_tokens ?? completionTokens;
            } else if (parsed.type === "message_stop") {
                onToken({ done: true, usage: { promptTokens, completionTokens } });
            }
        } catch {
            // ignore malformed payload
        }
    });
};
