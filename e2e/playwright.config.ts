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
    // Each test launches its own Electron process; running many of those
    // concurrently on a CI runner is more likely to produce flaky timeouts
    // than to save wall-clock time.
    workers: 1,
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    timeout: 60_000,
    // CI runners (shared, no GPU, xvfb overhead on top of Electron's own
    // startup cost) are measurably slower than a local dev machine — a wait
    // that's comfortably generous locally can still time out there. Give CI
    // more headroom uniformly rather than chasing each timeout one at a time.
    expect: { timeout: process.env.CI ? 20_000 : 10_000 },
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
    use: {
        // Only kept for a run that actually failed — cheap on disk, and the
        // difference between "it broke somewhere" and "here's exactly what
        // the page looked like and every action leading up to it."
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        command: "npx vite preview --port 5173 --strictPort",
        cwd: path.resolve(__dirname, "../frontend"),
        port: 5173,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
