import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VaultService, PathSecurityError } from "./vault.js";

/**
 * Adversarial coverage for vault.ts's own stated security boundary: "nothing
 * here can touch a path outside vaultRoot, including via `..` traversal or a
 * symlink that resolves out of the tree." docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md
 * named this exact area ("MasterVault write/search symlink handling") as
 * needing hardening — reading the implementation found every method already
 * confines lexically (confine()) and re-checks the realpath
 * (assertRealPathInside/isRealPathInside) after resolving symlinks, but
 * there was no test file anywhere in this package (no test framework was
 * even installed) to prove it. These tests create *real* symlinks on disk
 * (this suite only runs on POSIX — WSL/Linux/macOS CI — where
 * fs.symlink works without elevation) and assert the escape is actually
 * blocked, not just that the code looks right on read-through.
 */
describe("VaultService — symlink-escape and path-traversal hardening", () => {
    let vaultRoot: string;
    let outsideDir: string;
    let vault: VaultService;

    beforeEach(async () => {
        const base = await fs.mkdtemp(path.join(os.tmpdir(), "mastervault-test-"));
        vaultRoot = path.join(base, "vault");
        outsideDir = path.join(base, "outside");
        await fs.mkdir(vaultRoot, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(path.join(outsideDir, "secret.txt"), "top secret outside content");
        vault = new VaultService(vaultRoot);
    });

    afterEach(async () => {
        await fs.rm(path.dirname(vaultRoot), { recursive: true, force: true });
    });

    describe("a symlinked file inside the vault pointing outside it", () => {
        beforeEach(async () => {
            await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(vaultRoot, "escape-link.txt"));
        });

        it("read() refuses to follow it", async () => {
            await expect(vault.read("escape-link.txt")).rejects.toThrow(PathSecurityError);
        });

        it("search() never returns a hit from inside it, even though its content matches", async () => {
            const result = await vault.search("top secret");
            expect(result.hits).toHaveLength(0);
            expect(result.total).toBe(0);
        });

        it("move() refuses to move it as a source", async () => {
            await expect(vault.move("escape-link.txt", "renamed.txt")).rejects.toThrow(PathSecurityError);
        });
    });

    describe("a symlinked directory inside the vault pointing outside it", () => {
        beforeEach(async () => {
            await fs.mkdir(path.join(outsideDir, "nested"), { recursive: true });
            await fs.writeFile(path.join(outsideDir, "nested", "leak.txt"), "should never be reachable via the vault");
            await fs.symlink(path.join(outsideDir, "nested"), path.join(vaultRoot, "escape-dir"), "dir");
        });

        it("list() refuses to list into it", async () => {
            await expect(vault.list("escape-dir")).rejects.toThrow(PathSecurityError);
        });

        it("search() does not descend into it or return any file beneath it", async () => {
            const result = await vault.search("leak");
            expect(result.hits).toHaveLength(0);
            expect(result.total).toBe(0);
        });

        it("write() refuses to create a new file inside it", async () => {
            await expect(vault.write("escape-dir/new-file.txt", "content")).rejects.toThrow(PathSecurityError);
        });

        it("append() refuses to append into a file inside it", async () => {
            await expect(vault.append("escape-dir/new-file.txt", "content")).rejects.toThrow(PathSecurityError);
        });

        it("move() refuses to move a legitimate vault file into it", async () => {
            await vault.write("legit.txt", "fine");
            await expect(vault.move("legit.txt", "escape-dir/legit.txt")).rejects.toThrow(PathSecurityError);
        });
    });

    describe("lexical path traversal (no symlink involved)", () => {
        it("rejects '..' segments that would resolve above the vault root", async () => {
            await expect(vault.read("../outside/secret.txt")).rejects.toThrow(PathSecurityError);
        });

        it("rejects a deeply nested '..' escape", async () => {
            await expect(vault.read("a/b/c/../../../../outside/secret.txt")).rejects.toThrow(PathSecurityError);
        });

        it("treats a leading slash as vault-relative, not filesystem-absolute", async () => {
            await vault.write("real.txt", "hello");
            const result = await vault.read("/real.txt");
            expect(result.content).toBe("hello");
        });

        it("rejects a null byte in the path", async () => {
            await expect(vault.read("real.txt\0.md")).rejects.toThrow(PathSecurityError);
        });
    });

    describe("legitimate operations still work (the hardening isn't over-broad)", () => {
        it("reads, writes, lists, searches, and moves normally inside the vault", async () => {
            await vault.write("notes/todo.md", "find the needle here");
            const read = await vault.read("notes/todo.md");
            expect(read.content).toBe("find the needle here");

            const listing = await vault.list("notes");
            expect(listing.entries.map((e) => e.name)).toContain("todo.md");

            const search = await vault.search("needle");
            expect(search.hits).toHaveLength(1);
            expect(search.hits[0].path).toBe("notes/todo.md");

            const moved = await vault.move("notes/todo.md", "notes/done.md");
            expect(moved.to).toBe("notes/done.md");
            expect(await vault.exists("notes/todo.md")).toBe(false);
            expect(await vault.exists("notes/done.md")).toBe(true);
        });

        it("a broken symlink (target does not exist) is reported by list() but not treated as a security escape", async () => {
            await fs.symlink(path.join(outsideDir, "does-not-exist.txt"), path.join(vaultRoot, "broken-link.txt"));
            const listing = await vault.list(".");
            expect(listing.entries.some((e) => e.name === "broken-link.txt")).toBe(true);
        });
    });
});
