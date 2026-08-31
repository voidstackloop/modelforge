import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { describe, it, expect } from "vitest";
import { markBackendAttemptConfirmed, markBackendAttemptStarting, resolveStartupGpuBackend } from "./llamacpp-backend-health";

// The mocked app.getPath("userData") in src/test/electron-mock.ts is one
// real, shared temp directory for the whole test process — explicitly
// clearing this module's one file before each assertion (rather than
// relying on any assumed starting state) is what keeps these tests
// independent of whatever else in this suite also exercises
// llamacpp-manager.ts's real getLlamaInstance() against the same path.
const healthFilePath = path.join(app.getPath("userData"), "llamacpp-backend-health.json");
function clearHealthFile(): void {
    fs.rmSync(healthFilePath, { force: true });
}

describe("llamacpp-backend-health (crash-loop breaker for llama.cpp GPU backend init)", () => {
    it("resolveStartupGpuBackend returns the configured backend unchanged when no health record exists", () => {
        clearHealthFile();
        expect(resolveStartupGpuBackend("vulkan")).toBe("vulkan");
    });

    it("returns cpu when the last attempt for this exact backend never confirmed — the crash case", () => {
        clearHealthFile();
        markBackendAttemptStarting("vulkan");
        // No markBackendAttemptConfirmed call — simulates the process dying
        // during the real getLlama() initialization, exactly like a real
        // SIGILL would: this line of test code is the one that would never
        // have run had it been a real crash.
        expect(resolveStartupGpuBackend("vulkan")).toBe("cpu");
    });

    it("does not downgrade when the unconfirmed record is for a different backend than the one being checked", () => {
        clearHealthFile();
        markBackendAttemptStarting("vulkan");
        // The user (or a fresh launch) is now trying "cuda", not "vulkan" —
        // a past vulkan crash must never block an unrelated backend.
        expect(resolveStartupGpuBackend("cuda")).toBe("cuda");
    });

    it("does not downgrade once the attempt has been confirmed", () => {
        clearHealthFile();
        markBackendAttemptStarting("cuda");
        markBackendAttemptConfirmed("cuda");
        expect(resolveStartupGpuBackend("cuda")).toBe("cuda");
    });

    it("a fresh unconfirmed attempt for a backend that was previously confirmed working is treated as unconfirmed again", () => {
        // Real sequence: backend worked fine for a while (confirmed), then
        // something changed (a driver update, a different model) and the
        // *next* attempt crashed before reaching markBackendAttemptConfirmed
        // again. The file only ever reflects the single most recent attempt.
        clearHealthFile();
        markBackendAttemptStarting("vulkan");
        markBackendAttemptConfirmed("vulkan");
        markBackendAttemptStarting("vulkan");
        expect(resolveStartupGpuBackend("vulkan")).toBe("cpu");
    });

    it("treats the literal string 'auto' as trackable like any other configured value", () => {
        clearHealthFile();
        markBackendAttemptStarting("auto");
        expect(resolveStartupGpuBackend("auto")).toBe("cpu");
    });
});
