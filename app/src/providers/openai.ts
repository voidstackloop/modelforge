import { streamSSE } from "./sse";
import type { ChatFn } from "./types";

export const chat: ChatFn = async (apiKey, model, messages, options, onToken, signal) => {
    const openaiMessages = messages.map((m) => {
        if (!m.images || m.images.length === 0) return { role: m.role, content: m.content };
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

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
        }),
        signal,
    });

    if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`OpenAI request failed: ${res.status} ${errText}`);
    }

    await streamSSE(res, (payload) => {
        if (payload === "[DONE]") {
            onToken({ done: true });
            return;
        }
        try {
            const parsed = JSON.parse(payload);
            const delta: string | undefined = parsed.choices?.[0]?.delta?.content;
            if (delta) {
                onToken({ message: { role: "assistant", content: delta }, done: false });
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
