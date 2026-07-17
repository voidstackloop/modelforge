// Minimal Server-Sent-Events line reader. Both OpenAI's and Anthropic's
// streaming APIs put a JSON payload (or "[DONE]") after each "data:" line;
// Anthropic's event name is redundant with the "type" field inside that JSON,
// so a single generic reader covers both without tracking "event:" lines.
export async function streamSSE(res: Response, onData: (payload: string) => void): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex).trimEnd();
            buffer = buffer.slice(newlineIndex + 1);
            if (line.startsWith("data:")) {
                const payload = line.slice(5).trim();
                if (payload) onData(payload);
            }
        }
    }
}
