import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { readJsonFileNative, writeJsonFileAtomicNative, sha256HexNative, appendJsonArrayElementNative } from "./native-datastore";

// Whether the Rust addon is actually built (app/native/) varies by
// environment — CI's unit-test job and plain `npm test` run without it (see
// native-downloader.ts), but a local dev machine that ran `npm run
// build:native` or `build:debug` has it. Both are legitimate states this
// module must handle correctly, so these tests check real behavior in
// whichever state the current run is actually in, rather than assuming one.
const addonPresent = fs.existsSync(path.join(__dirname, "..", "native"));

describe(`native-datastore (addon ${addonPresent ? "present" : "unavailable"})`, () => {
    it("readJsonFileNative: undefined only when unavailable, otherwise null for a missing file", () => {
        const result = readJsonFileNative(path.join(os.tmpdir(), `native-datastore-test-missing-${randomUUID()}.json`));
        expect(result).toBe(addonPresent ? null : undefined);
    });

    it("writeJsonFileAtomicNative: false only when unavailable, otherwise actually writes the file", () => {
        const filePath = path.join(os.tmpdir(), `native-datastore-test-write-${randomUUID()}.json`);
        try {
            const wrote = writeJsonFileAtomicNative(filePath, '{"a":1}');
            expect(wrote).toBe(addonPresent);
            if (addonPresent) {
                expect(fs.readFileSync(filePath, "utf-8")).toBe('{"a":1}');
            }
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });

    it("sha256HexNative: undefined only when unavailable, otherwise matches Node's own crypto", () => {
        const result = sha256HexNative("hello");
        if (addonPresent) {
            expect(result).toBe(createHash("sha256").update("hello").digest("hex"));
        } else {
            expect(result).toBeUndefined();
        }
    });

    it("appendJsonArrayElementNative: undefined when unavailable, otherwise actually appends", () => {
        const filePath = path.join(os.tmpdir(), `native-datastore-test-append-${randomUUID()}.json`);
        try {
            fs.writeFileSync(filePath, "[1,2]");
            const result = appendJsonArrayElementNative(filePath, "3");
            if (addonPresent) {
                expect(result).toBe(true);
                expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual([1, 2, 3]);
            } else {
                expect(result).toBeUndefined();
            }
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });
});
