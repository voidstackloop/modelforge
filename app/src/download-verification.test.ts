import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { computeSha256, hasGgufMagic, getDiskSpace } from "./download-verification";

describe("computeSha256", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-verification-test-"));
    });

    it("matches Node's own synchronous hash of the same content", async () => {
        const file = path.join(dir, "data.bin");
        const content = Buffer.from("hello world".repeat(1000));
        fs.writeFileSync(file, content);
        const expected = createHash("sha256").update(content).digest("hex");
        expect(await computeSha256(file)).toBe(expected);
    });

    it("rejects when the file doesn't exist", async () => {
        await expect(computeSha256(path.join(dir, "missing.bin"))).rejects.toThrow();
    });
});

describe("hasGgufMagic", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-verification-test-"));
    });

    it("returns true for a file starting with the GGUF magic bytes", () => {
        const file = path.join(dir, "model.gguf");
        fs.writeFileSync(file, Buffer.concat([Buffer.from("GGUF"), Buffer.from([3, 0, 0, 0])]));
        expect(hasGgufMagic(file)).toBe(true);
    });

    it("returns false for a file without the magic bytes (e.g. an HTML error page)", () => {
        const file = path.join(dir, "not-a-model.gguf");
        fs.writeFileSync(file, "<html><body>404</body></html>");
        expect(hasGgufMagic(file)).toBe(false);
    });

    it("returns false for a file too short to contain the magic bytes", () => {
        const file = path.join(dir, "tiny.gguf");
        fs.writeFileSync(file, "GG");
        expect(hasGgufMagic(file)).toBe(false);
    });

    it("returns false when the file doesn't exist", () => {
        expect(hasGgufMagic(path.join(dir, "missing.gguf"))).toBe(false);
    });
});

describe("getDiskSpace", () => {
    it("reports positive free and total bytes for a real directory", () => {
        const { freeBytes, totalBytes } = getDiskSpace(os.tmpdir());
        expect(totalBytes).toBeGreaterThan(0);
        expect(freeBytes).toBeGreaterThan(0);
        expect(freeBytes).toBeLessThanOrEqual(totalBytes);
    });
});
