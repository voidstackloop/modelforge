import type { ElectronApplication } from "@playwright/test";

// llama.cpp runs in-process (node-llama-cpp, no spawned server, no HTTP
// surface) — unlike Ollama, there is no network boundary fake-ollama.ts's
// approach can intercept. Instead, app/src/llamacpp-manager.ts's own
// `loadNodeLlamaCpp()` swaps in a deterministic fake module entirely
// in-process whenever MODELFORGE_E2E_FAKE_LLAMACPP=1 is set in the Electron
// process's environment (see that file's own comment on why this is safe —
// nothing in a real launch ever sets that variable). This fixture's job is
// just wiring: setting the env var at launch (via LaunchOptions.env), and
// controlling the fake's next response from the Playwright test process via
// ElectronApplication.evaluate() reading a global llamacpp-manager.ts
// exposes for exactly this purpose (that callback runs in a bare V8 context
// with no `require` in scope, so re-require()-ing the compiled module from
// there — this fixture's old approach — no longer works).

/** Environment for launchApp({ env: FAKE_LLAMACPP_ENV }) to activate the fake
 * module. Combine with settings like `{ preferredRuntime: "llamacpp" }` /
 * `{ llamaCppModelsDir: ... }` as needed so the app actually dispatches chat
 * through llamacpp-manager.ts rather than defaulting to Ollama. */
export const FAKE_LLAMACPP_ENV: Record<string, string> = { MODELFORGE_E2E_FAKE_LLAMACPP: "1" };

export interface FakeLlamaCppChatTurn {
    tokens?: string[];
    toolCall?: { name: string; arguments: Record<string, unknown> };
    delayMs?: number;
}

export interface FakeLlamaCppController {
    setNextChatTurn(turn: FakeLlamaCppChatTurn): Promise<void>;
    getChatRequestCount(): Promise<number>;
}

/** Call once after launchApp() when the launch used FAKE_LLAMACPP_ENV — the
 * returned controller drives the fake exactly like FakeOllamaServer drives
 * fake-ollama.ts's real HTTP server, just via evaluate() instead of a URL. */
export function controlFakeLlamaCpp(app: ElectronApplication): FakeLlamaCppController {
    return {
        async setNextChatTurn(turn: FakeLlamaCppChatTurn): Promise<void> {
            await app.evaluate((_electron, nextTurn: FakeLlamaCppChatTurn) => {
                (globalThis as unknown as { __modelforgeFakeLlamaCppTestHooks: { __setFakeLlamaCppNextChatTurnForTests(t: FakeLlamaCppChatTurn): void } }).__modelforgeFakeLlamaCppTestHooks.__setFakeLlamaCppNextChatTurnForTests(nextTurn);
            }, turn);
        },
        async getChatRequestCount(): Promise<number> {
            return app.evaluate(() => {
                return (globalThis as unknown as { __modelforgeFakeLlamaCppTestHooks: { __getFakeLlamaCppChatRequestCountForTests(): number } }).__modelforgeFakeLlamaCppTestHooks.__getFakeLlamaCppChatRequestCountForTests();
            });
        },
    };
}
