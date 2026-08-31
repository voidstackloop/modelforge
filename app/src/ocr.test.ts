import { describe, expect, it, vi, beforeEach } from "vitest";

// tesseract.js spins up a real WASM worker + downloads language data — far
// too heavy for a unit test. This file's only pre-existing coverage was
// none at all; the point of this file is specifically to verify the
// resource-orchestrator wrap added alongside item 1's "OCR/document
// processing" workload-table entry, not to re-verify tesseract.js itself.
const recognizeMock = vi.fn(async () => ({ data: { text: "  recognized text  " } }));
vi.mock("tesseract.js", () => ({ createWorker: vi.fn(async () => ({ recognize: recognizeMock })) }));

import { recognizeText } from "./ocr";
import { mainResourceOrchestrator } from "./resource-orchestrator";

describe("ocr.recognizeText", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        recognizeMock.mockResolvedValue({ data: { text: "  recognized text  " } });
    });

    it("returns the trimmed recognized text", async () => {
        const result = await recognizeText(Buffer.from("fake-image-bytes").toString("base64"));
        expect(result).toBe("recognized text");
    });

    it("runs as a user-interactive lease (item 1: OCR is user-triggered in this codebase, never scheduled)", async () => {
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await recognizeText(Buffer.from("fake-image-bytes").toString("base64"));
        expect(withLeaseSpy).toHaveBeenCalledOnce();
        expect(withLeaseSpy.mock.calls[0][0]).toMatchObject({ workloadKind: "user-ocr", priority: "user-interactive" });
    });

    it("two concurrent OCR requests both complete rather than deadlocking on the lease", async () => {
        const [a, b] = await Promise.all([
            recognizeText(Buffer.from("one").toString("base64")),
            recognizeText(Buffer.from("two").toString("base64")),
        ]);
        expect(a).toBe("recognized text");
        expect(b).toBe("recognized text");
    });
});
