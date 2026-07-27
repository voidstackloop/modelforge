import { defineConfig } from "@playwright/test";
import * as path from "node:path";

// Electron loads the renderer from http://localhost:5173 whenever
// app.isPackaged is false (see app/src/main.ts's createWindow) — that's true
// for every unpacked `electron .` launch regardless of NODE_ENV, so the e2e
// suite needs *something* serving the built frontend on that port. `vite
// preview` over the production build (frontend/dist) is faster and more
// deterministic than the dev server, and matches what a packaged build
// actually ships.
export default defineConfig({
    testDir: "./tests",
    outputDir: "./test-results",
    // Each test launches its own Electron process (plus a fake Ollama HTTP
    // server); running many of those concurrently on a CI runner is more
    // likely to produce flaky timeouts than to save wall-clock time.
    workers: 1,
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
    webServer: {
        command: "npx vite preview --port 5173 --strictPort",
        cwd: path.resolve(__dirname, "../frontend"),
        port: 5173,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
