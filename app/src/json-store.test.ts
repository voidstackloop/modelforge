import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJson, writeJson } from "./json-store";

describe("json-store", () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-store-test-"));
        file = path.join(dir, "data.json");
    });

    it("returns the fallback when the file doesn't exist yet", () => {
        expect(readJson(file, { a: 1 })).toEqual({ a: 1 });
    });

    it("round-trips a write through a read", () => {
        writeJson(file, { hello: "world" });
        expect(readJson(file, {})).toEqual({ hello: "world" });
    });

    it("creates parent directories on write", () => {
        const nested = path.join(dir, "a", "b", "c.json");
        writeJson(nested, [1, 2, 3]);
        expect(fs.existsSync(nested)).toBe(true);
    });

    it("leaves no temp file behind after a successful write", () => {
        writeJson(file, { x: 1 });
        const entries = fs.readdirSync(dir);
        expect(entries).toEqual(["data.json"]);
    });

    // These files hold API keys and conversation history; the default umask
    // would leave them readable by other accounts on the machine.
    it.skipIf(process.platform === "win32")("writes owner-only files", () => {
        writeJson(file, { token: "value" });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === "win32")("keeps the file owner-only on rewrite", () => {
        writeJson(file, { token: "first" });
        writeJson(file, { token: "second" });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === "win32")("stays owner-only when a stale temp file exists", () => {
        const stale = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(stale, "leftover", { mode: 0o666 });
        writeJson(file, { token: "value" });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    // A file written by an older build is only ever read if its contents never
    // change, so tightening on write alone would never reach it.
    it.skipIf(process.platform === "win32")("tightens an existing world-readable file on read", () => {
        fs.writeFileSync(file, JSON.stringify({ token: "value" }), { mode: 0o644 });
        expect(readJson(file, {})).toEqual({ token: "value" });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it("backs up and falls back to the default when the file is corrupted", () => {
        fs.writeFileSync(file, "{ not valid json");
        const result = readJson(file, { safe: true });

        expect(result).toEqual({ safe: true });

        const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupted-"));
        expect(backups.length).toBe(1);
        expect(fs.readFileSync(path.join(dir, backups[0]), "utf-8")).toBe("{ not valid json");
    });

    it("does not destroy a corrupted file's backup on a subsequent write", () => {
        fs.writeFileSync(file, "not json at all");
        readJson(file, {}); // triggers the backup
        writeJson(file, { recovered: false });

        const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupted-"));
        expect(backups.length).toBe(1);
        expect(readJson(file, {})).toEqual({ recovered: false });
    });
});
