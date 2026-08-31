import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";

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

describe("media.extractVideoFrames", () => {
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
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await extractVideoFrames(testVideoPath, 1);
        expect(withLeaseSpy).toHaveBeenCalledOnce();
        expect(withLeaseSpy.mock.calls[0][0]).toMatchObject({ workloadKind: "user-media", priority: "user-interactive" });
    }, 20_000);
});
