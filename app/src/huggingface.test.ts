import { describe, it, expect, vi, beforeEach } from "vitest";
import { downloadGgufFile } from "./huggingface";
import { downloadGgufFileNative } from "./native-downloader";

// The actual HTTP/resume/verify logic now lives in the Rust native addon
// (lib/), covered by its own test suite there (mock-HTTP-server-based, see
// lib/src/download/tests.rs) — a JS-side `vi.stubGlobal("fetch", ...)` can't
// reach code that no longer runs in JS. What's left to verify from the TS
// side is just this file's adapter: does it call the native function with
// the right arguments, and does it translate the native progress/error
// shapes into what callers (main.ts's hf:downloadFile handler) expect.
vi.mock("./native-downloader", () => ({
    downloadGgufFileNative: vi.fn(),
}));

const nativeMock = vi.mocked(downloadGgufFileNative);

describe("downloadGgufFile (native adapter)", () => {
    beforeEach(() => {
        nativeMock.mockReset();
    });

    it("calls the native addon with modelId/filename/destPath and no token when none is given", async () => {
        nativeMock.mockResolvedValue(undefined);

        await downloadGgufFile("org/model", "model.gguf", "/tmp/model.gguf", () => {});

        expect(nativeMock).toHaveBeenCalledWith(
            "org/model",
            "model.gguf",
            "/tmp/model.gguf",
            undefined,
            expect.any(Function)
        );
    });

    it("passes a null token through as undefined, matching the native addon's Option<String> signature", async () => {
        nativeMock.mockResolvedValue(undefined);

        await downloadGgufFile("org/model", "model.gguf", "/tmp/model.gguf", () => {}, null);

        expect(nativeMock.mock.calls[0][3]).toBeUndefined();
    });

    it("passes a real token through unchanged", async () => {
        nativeMock.mockResolvedValue(undefined);

        await downloadGgufFile("org/model", "model.gguf", "/tmp/model.gguf", () => {}, "secret-token");

        expect(nativeMock.mock.calls[0][3]).toBe("secret-token");
    });

    it("adapts native progress events, mapping a missing totalBytes to null", async () => {
        const progress: { receivedBytes: number; totalBytes: number | null }[] = [];
        nativeMock.mockImplementation(async (_modelId, _filename, _dest, _token, onProgress) => {
            onProgress(null, { receivedBytes: 5, totalBytes: undefined });
            onProgress(null, { receivedBytes: 10, totalBytes: 10 });
        });

        await downloadGgufFile("org/model", "model.gguf", "/tmp/model.gguf", (p) => progress.push(p));

        expect(progress).toEqual([
            { receivedBytes: 5, totalBytes: null },
            { receivedBytes: 10, totalBytes: 10 },
        ]);
    });

    it("propagates the native call's rejection unchanged, so callers' error logging keeps working", async () => {
        const nativeError = new Error(
            'Download of "model.gguf" was incomplete (got 5 of 10 bytes) — try downloading it again to resume.'
        );
        nativeMock.mockRejectedValue(nativeError);

        await expect(downloadGgufFile("org/model", "model.gguf", "/tmp/model.gguf", () => {})).rejects.toBe(nativeError);
    });
});
