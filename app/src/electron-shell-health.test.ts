import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { describe, it, expect } from "vitest";
import {
    markShellAttemptConfirmed,
    markShellAttemptStarting,
    resolveStartupShellSafety,
    FULL_SHELL_SAFETY,
    SAFE_SHELL_SAFETY,
} from "./electron-shell-health";

// Same shared-temp-userData caveat as llamacpp-backend-health.test.ts —
// explicitly clear this module's one file before each assertion.
const healthFilePath = path.join(app.getPath("userData"), "electron-shell-health.json");
function clearHealthFile(): void {
    fs.rmSync(healthFilePath, { force: true });
}

describe("electron-shell-health (crash-loop breaker for Chromium GPU/sandbox)", () => {
    it("resolves to full protection by default when no history exists", () => {
        clearHealthFile();
        expect(resolveStartupShellSafety()).toEqual(FULL_SHELL_SAFETY);
    });

    it("falls back to fully safe when a full-protection attempt never confirmed — the crash case", () => {
        clearHealthFile();
        markShellAttemptStarting(FULL_SHELL_SAFETY);
        // No markShellAttemptConfirmed call — simulates the process dying
        // with SIGILL before this line, exactly like a real GPU/sandbox
        // crash would.
        expect(resolveStartupShellSafety()).toEqual(SAFE_SHELL_SAFETY);
    });

    it("keeps using full protection once it has confirmed working", () => {
        clearHealthFile();
        markShellAttemptStarting(FULL_SHELL_SAFETY);
        markShellAttemptConfirmed(FULL_SHELL_SAFETY);
        expect(resolveStartupShellSafety()).toEqual(FULL_SHELL_SAFETY);
    });

    it("stays in safe mode on later launches once safe mode has confirmed — does not re-attempt full mode", () => {
        clearHealthFile();
        markShellAttemptStarting(FULL_SHELL_SAFETY);
        // crashed — next launch downgrades and confirms safe mode
        expect(resolveStartupShellSafety()).toEqual(SAFE_SHELL_SAFETY);
        markShellAttemptStarting(SAFE_SHELL_SAFETY);
        markShellAttemptConfirmed(SAFE_SHELL_SAFETY);
        // a subsequent launch should keep replaying safe mode, not retry full
        expect(resolveStartupShellSafety()).toEqual(SAFE_SHELL_SAFETY);
    });

    it("keeps retrying safe mode when even safe mode hasn't confirmed yet — nothing safer to fall back to", () => {
        clearHealthFile();
        markShellAttemptStarting(SAFE_SHELL_SAFETY);
        // No confirmation — even the floor configuration hasn't proven itself yet.
        expect(resolveStartupShellSafety()).toEqual(SAFE_SHELL_SAFETY);
    });

    it("a fresh unconfirmed full-protection attempt after a previously confirmed one is treated as broken again", () => {
        clearHealthFile();
        markShellAttemptStarting(FULL_SHELL_SAFETY);
        markShellAttemptConfirmed(FULL_SHELL_SAFETY);
        markShellAttemptStarting(FULL_SHELL_SAFETY);
        expect(resolveStartupShellSafety()).toEqual(SAFE_SHELL_SAFETY);
    });
});
