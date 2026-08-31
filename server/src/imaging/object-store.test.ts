import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalFilesystemImagingObjectStore, sha256Hex } from "./object-store.js";

describe("LocalFilesystemImagingObjectStore", () => {
    let root: string;
    let store: LocalFilesystemImagingObjectStore;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "imaging-object-store-test-"));
        store = new LocalFilesystemImagingObjectStore(root, randomBytes(32));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it("round-trips data through put/get, with a matching checksum", async () => {
        const data = Buffer.from("some dicom-shaped bytes, not really");
        const { checksumSha256, sizeBytes } = await store.put("org-1/study-1/instance-1.dcm", data, "application/dicom");
        expect(checksumSha256).toBe(sha256Hex(data));
        expect(sizeBytes).toBe(data.length);

        const retrieved = await store.get("org-1/study-1/instance-1.dcm");
        expect(retrieved.equals(data)).toBe(true);
    });

    it("stores data encrypted at rest — the raw file on disk is not the plaintext", async () => {
        const data = Buffer.from("a very recognizable plaintext marker string");
        await store.put("org-1/study-1/instance-1.dcm", data, "application/dicom");
        const rawFile = await fs.readFile(path.join(root, "org-1/study-1/instance-1.dcm"));
        expect(rawFile.includes(data)).toBe(false);
        expect(rawFile.equals(data)).toBe(false);
    });

    it("a wrong encryption key fails to decrypt rather than returning garbage silently", async () => {
        await store.put("org-1/k.dcm", Buffer.from("secret"), "application/dicom");
        const wrongKeyStore = new LocalFilesystemImagingObjectStore(root, randomBytes(32));
        await expect(wrongKeyStore.get("org-1/k.dcm")).rejects.toThrow();
    });

    it("exists() reflects put/absence correctly", async () => {
        expect(await store.exists("org-1/nope.dcm")).toBe(false);
        await store.put("org-1/yes.dcm", Buffer.from("x"), "application/dicom");
        expect(await store.exists("org-1/yes.dcm")).toBe(true);
    });

    it("delete() removes an object", async () => {
        await store.put("org-1/gone.dcm", Buffer.from("x"), "application/dicom");
        await store.delete("org-1/gone.dcm");
        expect(await store.exists("org-1/gone.dcm")).toBe(false);
    });

    describe("path traversal", () => {
        it("rejects a key that escapes the storage root via '..'", async () => {
            await expect(store.put("../../../etc/passwd", Buffer.from("x"), "text/plain")).rejects.toThrow(/outside the imaging storage root/);
        });

        it("rejects an absolute-path key", async () => {
            const absolute = path.isAbsolute("/etc/passwd") ? "/etc/passwd" : "C:\\Windows\\System32\\config";
            await expect(store.get(absolute)).rejects.toThrow(/outside the imaging storage root/);
        });
    });

    it("constructor rejects a key that is not exactly 32 bytes", () => {
        expect(() => new LocalFilesystemImagingObjectStore(root, randomBytes(16))).toThrow(/32 bytes/);
    });

    it("healthCheck reports true when the root is writable", async () => {
        expect(await store.healthCheck()).toBe(true);
    });
});
