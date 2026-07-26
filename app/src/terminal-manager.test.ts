import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    createTerminal,
    writeToTerminal,
    resizeTerminal,
    readTerminalOutput,
    closeTerminal,
    closeAllForWorkspace,
    closeAll,
    listTerminals,
} from "./terminal-manager";

// 5000ms was tight enough that a slow PTY spawn on Windows CI could still
// hit vitest's outer testTimeout (see app/vitest.config.ts) before this
// helper's own, more descriptive error had a chance to fire.
function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            if (predicate()) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
            setTimeout(check, 20);
        };
        check();
    });
}

describe("terminal-manager", () => {
    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-manager-test-"));
    });

    afterEach(() => {
        closeAll();
    });

    it("creates a terminal and reflects a typed command's output in scrollback", async () => {
        const { id } = createTerminal(workspace, {}, () => {}, () => {});
        writeToTerminal(id, "echo hello-from-pty\r");
        await waitFor(() => readTerminalOutput(id).includes("hello-from-pty"));
        expect(readTerminalOutput(id)).toContain("hello-from-pty");
    });

    it("streams data to the onData callback as it arrives, not just into scrollback", async () => {
        let received = "";
        const { id } = createTerminal(workspace, {}, (chunk) => (received += chunk), () => {});
        writeToTerminal(id, "echo streamed-chunk\r");
        await waitFor(() => received.includes("streamed-chunk"));
        expect(received).toContain("streamed-chunk");
        void id;
    });

    it("reports exit via onExit and marks the terminal as not alive", async () => {
        let exitCode: number | null = null;
        const { id } = createTerminal(workspace, {}, () => {}, (code) => (exitCode = code));
        writeToTerminal(id, "exit 0\r");
        await waitFor(() => exitCode !== null);
        expect(listTerminals(workspace).find((t) => t.id === id)?.alive).toBe(false);
    });

    it("closes and forgets only the terminals belonging to the given workspace", () => {
        const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-manager-test-other-"));
        createTerminal(workspace, {}, () => {}, () => {});
        const b = createTerminal(otherWorkspace, {}, () => {}, () => {});

        const closedCount = closeAllForWorkspace(workspace);

        expect(closedCount).toBe(1);
        expect(listTerminals(workspace)).toEqual([]);
        expect(listTerminals(otherWorkspace).map((t) => t.id)).toEqual([b.id]);
        closeTerminal(b.id);
        fs.rmSync(otherWorkspace, { recursive: true, force: true });
    });

    it("throws for an unknown terminal id", () => {
        expect(() => writeToTerminal("does-not-exist", "x")).toThrow(/No terminal/);
        expect(() => readTerminalOutput("does-not-exist")).toThrow(/No terminal/);
        expect(() => resizeTerminal("does-not-exist", 80, 24)).toThrow(/No terminal/);
    });

    it("caps the number of concurrently open terminals", () => {
        for (let i = 0; i < 5; i++) createTerminal(workspace, { name: `t-${i}` }, () => {}, () => {});
        expect(() => createTerminal(workspace, {}, () => {}, () => {})).toThrow(/Already have/);
    });

    it("treats closing an already-closed terminal as a harmless no-op", () => {
        const { id } = createTerminal(workspace, {}, () => {}, () => {});
        closeTerminal(id);
        expect(() => closeTerminal(id)).not.toThrow();
        expect(listTerminals(workspace)).toEqual([]);
    });
});
