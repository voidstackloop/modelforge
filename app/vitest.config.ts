import { defineConfig } from "vitest/config";
import * as path from "node:path";

export default defineConfig({
    resolve: {
        alias: {
            electron: path.resolve(__dirname, "src/test/electron-mock.ts"),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        // Several tests spawn a real child process or PTY and poll for
        // observable output (agent-tools.test.ts, resource-monitor.test.ts,
        // terminal-manager.test.ts). Vitest's 5000ms default has repeatedly
        // been too tight for that on Windows CI runners, where process/PTY
        // spawn is noticeably slower than on Linux/macOS — this raises the
        // floor for the whole suite instead of chasing each Windows-only
        // flake one file at a time as it turns up.
        testTimeout: 20_000,
    },
});
