import * as http from "node:http";
import type { AddressInfo } from "node:net";

// A minimal stand-in for a real Ollama server, just enough of the surface
// app/src/ollama-manager.ts talks to (GET /api/version, GET /api/tags, POST
// /api/chat streaming ndjson) that the e2e suite can exercise chat send/
// stream/cancel without depending on a real Ollama install being present in
// CI.
export interface FakeOllamaChatTurn {
    // Tokens streamed one ndjson line at a time, mimicking Ollama's own
    // token-by-token /api/chat chunks.
    tokens?: string[];
    // Emitted for one specific model to trigger a tool-call turn instead of
    // this being the final response, mirroring the shape app/src/
    // ollama-manager.ts's toOllamaTools()/chat() expects on the way back.
    toolCall?: { name: string; arguments: Record<string, unknown> };
    // Milliseconds to wait between each streamed token. Defaults to a small
    // but non-zero delay (see DEFAULT_DELAY_MS below) rather than 0 — writing
    // every ndjson line in the same synchronous tick lets Electron coalesce
    // the resulting rapid-fire webContents.send() calls, so the renderer can
    // observe only the *first* IPC chunk of a burst and never see the rest.
    // Real Ollama never triggers this because token generation itself takes
    // real time between chunks; this fixture has to manufacture that gap.
    // Set explicitly to a larger value for a cancellation test's wide click
    // window, or override DEFAULT_DELAY_MS's effect with 0 only if a test
    // specifically wants to probe the zero-delay burst behavior.
    delayMs?: number;
}

const DEFAULT_DELAY_MS = 15;

export interface FakeOllamaServer {
    url: string;
    setNextChatTurn(turn: FakeOllamaChatTurn): void;
    getChatRequestCount(): number;
    close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startFakeOllama(): Promise<FakeOllamaServer> {
    const defaultTurn: FakeOllamaChatTurn = { tokens: ["Hello", " from", " the", " fake", " model."] };
    // One-shot: a test arranges exactly the turn it wants for the request its
    // action is about to trigger. Without resetting to defaultTurn after
    // serving it, a tool-call turn would keep firing on every follow-up
    // request the agent loop makes after Allow/Deny — an infinite loop
    // instead of the single continuation turn the test expects.
    let oneShotTurn: FakeOllamaChatTurn | null = null;
    let chatRequestCount = 0;

    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/api/version") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ version: "0.0.0-fake" }));
                return;
            }

            if (req.method === "GET" && req.url === "/api/tags") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        models: [{ name: "fake-model:latest", size: 1, modified_at: new Date().toISOString() }],
                    })
                );
                return;
            }

            if (req.method === "GET" && req.url === "/api/ps") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ models: [] }));
                return;
            }

            if (req.method === "POST" && req.url === "/api/chat") {
                chatRequestCount++;
                const turn = oneShotTurn ?? defaultTurn;
                oneShotTurn = null;
                res.writeHead(200, { "Content-Type": "application/x-ndjson" });

                let aborted = false;
                req.on("close", () => {
                    aborted = true;
                });
                const delayMs = turn.delayMs ?? DEFAULT_DELAY_MS;

                if (turn.toolCall) {
                    if (delayMs) await sleep(delayMs);
                    if (aborted) return void res.end();
                    res.write(
                        JSON.stringify({
                            model: "fake-model:latest",
                            created_at: new Date().toISOString(),
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [{ function: { name: turn.toolCall.name, arguments: turn.toolCall.arguments } }],
                            },
                            done: true,
                            prompt_eval_count: 5,
                            eval_count: 1,
                        }) + "\n"
                    );
                    res.end();
                    return;
                }

                const tokens = turn.tokens ?? [];
                for (let i = 0; i < tokens.length; i++) {
                    if (aborted) return void res.end();
                    if (delayMs) await sleep(delayMs);
                    if (aborted) return void res.end();
                    res.write(
                        JSON.stringify({
                            model: "fake-model:latest",
                            created_at: new Date().toISOString(),
                            message: { role: "assistant", content: tokens[i] },
                            done: false,
                        }) + "\n"
                    );
                }
                if (aborted) return void res.end();
                if (delayMs) await sleep(delayMs);
                if (aborted) return void res.end();
                res.write(
                    JSON.stringify({
                        model: "fake-model:latest",
                        created_at: new Date().toISOString(),
                        message: { role: "assistant", content: "" },
                        done: true,
                        prompt_eval_count: tokens.join("").length,
                        eval_count: tokens.length,
                    }) + "\n"
                );
                res.end();
                return;
            }

            res.writeHead(404).end();
        } catch {
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        setNextChatTurn(turn: FakeOllamaChatTurn) {
            oneShotTurn = turn;
        },
        getChatRequestCount() {
            return chatRequestCount;
        },
        close() {
            return new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        },
    };
}
