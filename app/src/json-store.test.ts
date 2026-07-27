import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { readJson, readJsonWithSchema, writeJson } from "./json-store";

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

    describe("readJsonWithSchema", () => {
        const schema = z.object({ token: z.string() });

        it("returns the fallback when the file doesn't exist yet", () => {
            expect(readJsonWithSchema(file, { token: "default" }, schema)).toEqual({ token: "default" });
        });

        it("returns the parsed value when it matches the schema", () => {
            writeJson(file, { token: "abc" });
            expect(readJsonWithSchema(file, { token: "default" }, schema)).toEqual({ token: "abc" });
        });

        it("still backs up and falls back on plain JSON corruption", () => {
            fs.writeFileSync(file, "{ not valid json");
            expect(readJsonWithSchema(file, { token: "default" }, schema)).toEqual({ token: "default" });
            expect(fs.readdirSync(dir).filter((f) => f.includes(".corrupted-"))).toHaveLength(1);
        });

        // The case readJson() can't catch: valid JSON that simply isn't the
        // shape the caller asked for — e.g. a hand-edited settings.json with
        // a field typed wrong, or a secrets.json truncated/rewritten into
        // some other structure. Without schema validation this would flow
        // straight through JSON.parse's cast and into store code as if it
        // were trusted data.
        it("backs up and falls back when the JSON is valid but doesn't match the schema", () => {
            fs.writeFileSync(file, JSON.stringify({ token: 12345 })); // wrong type
            const result = readJsonWithSchema(file, { token: "default" }, schema);

            expect(result).toEqual({ token: "default" });
            const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupted-"));
            expect(backups).toHaveLength(1);
            expect(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), "utf-8"))).toEqual({ token: 12345 });
        });

        it("backs up and falls back when a required field is missing entirely", () => {
            fs.writeFileSync(file, JSON.stringify({ somethingElse: true }));
            expect(readJsonWithSchema(file, { token: "default" }, schema)).toEqual({ token: "default" });
        });

        it("does not destroy the schema-mismatch backup on a subsequent write", () => {
            fs.writeFileSync(file, JSON.stringify({ token: 12345 }));
            readJsonWithSchema(file, { token: "default" }, schema); // triggers the backup
            writeJson(file, { token: "recovered" });

            const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupted-"));
            expect(backups).toHaveLength(1);
            expect(readJsonWithSchema(file, { token: "default" }, schema)).toEqual({ token: "recovered" });
        });
    });
});
