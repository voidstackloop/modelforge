import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeAll, beforeEach, afterAll } from "vitest";

// extractVideoFrames shells out to a real ffmpeg binary (ffmpeg-static
// resolves it via a runtime CommonJS require() of a native-binary package,
// which vi.mock cannot intercept — it's resolved outside Vitest's module
// graph). Rather than fight that, this file generates a tiny REAL synthetic
// video with that same real ffmpeg binary and runs extractVideoFrames
// against it unmocked — a genuine integration test, not a weaker
// workaround. This file's only pre-existing coverage was none at all.
function ffmpegBinaryPath(): string {
    const ffmpegPath = require("ffmpeg-static") as string;
    return ffmpegPath.replace("app.asar", "app.asar.unpacked");
}

let testVideoPath: string;

beforeAll(async () => {
    testVideoPath = path.join(os.tmpdir(), `modelforge-media-test-${randomUUID()}.mp4`);
    await new Promise<void>((resolve, reject) => {
        execFile(
            ffmpegBinaryPath(),
            ["-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2:r=1", "-pix_fmt", "yuv420p", testVideoPath],
            { timeout: 20_000 },
            (err) => (err ? reject(err) : resolve())
        );
    });
}, 30_000);

afterAll(() => {
    fs.rmSync(testVideoPath, { force: true });
});

import { extractVideoFrames } from "./media";
import { mainResourceOrchestrator } from "./resource-orchestrator";

function mockWithLeaseBypassingRealAdmission() {
    // vitest's own hook-cleanup machinery invokes a spied-and-mocked
    // function once more, with zero arguments, as part of tearing it down
    // (observed directly via a stack trace rooted at callCleanupHooks) —
    // guard against that rather than assuming every call is a real one
    // from extractVideoFrames.
    return vi.spyOn(mainResourceOrchestrator, "withLease").mockImplementation((..._args: unknown[]) => {
        const task = _args[1] as ((lease: unknown) => unknown) | undefined;
        return typeof task === "function" ? Promise.resolve(task(undefined)) : Promise.resolve(undefined);
    });
}

describe("media.extractVideoFrames", () => {
    // extractVideoFrames acquires a real resource-orchestrator lease for
    // the ffmpeg extraction itself — none of these three tests are about
    // verifying real admission succeeds (the third only checks the
    // request's shape), so real admission is bypassed here rather than
    // left to depend on the host's actual spare CPU capacity. Observed
    // failing for real ("Requested 2 CPU threads, but only 1 are safely
    // available") on a macOS release-build runner.
    let withLeaseSpy: ReturnType<typeof mockWithLeaseBypassingRealAdmission>;
    beforeAll(() => {
        withLeaseSpy = mockWithLeaseBypassingRealAdmission();
    });
    // Same mock, fresh call history per test — the third test below asserts
    // toHaveBeenCalledOnce() and reads .mock.calls[0], which would otherwise
    // see accumulated calls from the two tests that already ran before it.
    beforeEach(() => withLeaseSpy.mockClear());
    afterAll(() => withLeaseSpy.mockRestore());

    it("returns the extracted frame(s) as base64 JPEG image data", async () => {
        const frames = await extractVideoFrames(testVideoPath, 2);
        expect(frames.length).toBeGreaterThan(0);
        expect(frames[0].mimeType).toBe("image/jpeg");
        // A real JPEG starts with the SOI marker 0xFFD8.
        const bytes = Buffer.from(frames[0].dataBase64, "base64");
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);
    }, 20_000);

    it("cleans up its own temp directory even after a successful extraction", async () => {
        const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("modelforge-frames-"));
        await extractVideoFrames(testVideoPath, 1);
        const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("modelforge-frames-"));
        expect(after.length).toBe(before.length);
    }, 20_000);

    it("runs as a user-interactive lease (item 1: media processing here is always a direct chat-attachment action)", async () => {
        // Reuses the describe-level spy (already mocked above) rather than
        // spying again — this only checks the request shape, same as
        // before, just against a mocked withLease instead of the real one.
        await extractVideoFrames(testVideoPath, 1);
        expect(withLeaseSpy).toHaveBeenCalledOnce();
        expect(withLeaseSpy.mock.calls[0][0]).toMatchObject({ workloadKind: "user-media", priority: "user-interactive" });
    }, 20_000);
});
