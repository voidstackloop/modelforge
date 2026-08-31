import * as path from "node:path";
import type { ElectronApplication } from "@playwright/test";

// llama.cpp runs in-process (node-llama-cpp, no spawned server, no HTTP
// surface) — unlike Ollama, there is no network boundary fake-ollama.ts's
// approach can intercept. Instead, app/src/llamacpp-manager.ts's own
// `loadNodeLlamaCpp()` swaps in a deterministic fake module entirely
// in-process whenever MODELFORGE_E2E_FAKE_LLAMACPP=1 is set in the Electron
// process's environment (see that file's own comment on why this is safe —
// nothing in a real launch ever sets that variable). This fixture's job is
// just wiring: setting the env var at launch (via LaunchOptions.env), and
// controlling the fake's next response from the Playwright test process by
// re-requiring the same compiled module inside the already-running main
// process via ElectronApplication.evaluate() — Node's require cache
// guarantees that resolves to the exact same module instance
// chat-dispatch.ts already loaded, not a second copy.

const APP_DIR = path.resolve(__dirname, "../../app");
const LLAMACPP_MANAGER_JS = path.join(APP_DIR, "dist", "llamacpp-manager.js");

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
            await app.evaluate(
                (_electron, args: { managerPath: string; turn: FakeLlamaCppChatTurn }) => {
                    const manager = require(args.managerPath);
                    manager.__setFakeLlamaCppNextChatTurnForTests(args.turn);
                },
                { managerPath: LLAMACPP_MANAGER_JS, turn }
            );
        },
        async getChatRequestCount(): Promise<number> {
            return app.evaluate((_electron, managerPath: string) => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const manager = require(managerPath);
                return manager.__getFakeLlamaCppChatRequestCountForTests();
            }, LLAMACPP_MANAGER_JS);
        },
    };
}
