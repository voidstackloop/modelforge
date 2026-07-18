import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFile, writeFile, listDir, searchFiles, executeTool, runCommand } from "./agent-tools";

describe("agent-tools", () => {
    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-test-"));
    });

    describe("path traversal protection", () => {
        it("rejects a relative path that escapes the workspace via ..", () => {
            expect(() => readFile(workspace, "../../etc/passwd")).toThrow(/outside the workspace/);
        });

        it("rejects an absolute path outside the workspace", () => {
            const outsideFile = path.join(os.tmpdir(), "not-in-workspace.txt");
            fs.writeFileSync(outsideFile, "secret");
            expect(() => readFile(workspace, outsideFile)).toThrow(/outside the workspace/);
        });

        it("allows a path that resolves to exactly the workspace root", () => {
            expect(() => listDir(workspace, ".")).not.toThrow();
        });

        it("allows a nested path within the workspace", () => {
            fs.mkdirSync(path.join(workspace, "sub"));
            fs.writeFileSync(path.join(workspace, "sub", "file.txt"), "hi");
            expect(readFile(workspace, "sub/file.txt")).toBe("hi");
        });
    });

    describe("readFile", () => {
        it("reads a file's contents", () => {
            fs.writeFileSync(path.join(workspace, "a.txt"), "hello world");
            expect(readFile(workspace, "a.txt")).toBe("hello world");
        });

        it("refuses to read a directory as a file", () => {
            fs.mkdirSync(path.join(workspace, "adir"));
            expect(() => readFile(workspace, "adir")).toThrow(/directory, not a file/);
        });

        it("truncates very large files instead of returning them whole", () => {
            fs.writeFileSync(path.join(workspace, "big.txt"), "x".repeat(200_000));
            const result = readFile(workspace, "big.txt");
            expect(result.length).toBeLessThan(200_000);
            expect(result).toContain("truncated");
        });
    });

    describe("writeFile", () => {
        it("creates a new file with the given content", () => {
            const result = writeFile(workspace, "new.txt", "content here");
            expect(result.bytesWritten).toBe(12);
            expect(fs.readFileSync(path.join(workspace, "new.txt"), "utf-8")).toBe("content here");
        });

        it("creates parent directories as needed", () => {
            writeFile(workspace, "a/b/c.txt", "nested");
            expect(fs.readFileSync(path.join(workspace, "a", "b", "c.txt"), "utf-8")).toBe("nested");
        });

        it("overwrites an existing file", () => {
            writeFile(workspace, "x.txt", "first");
            writeFile(workspace, "x.txt", "second");
            expect(fs.readFileSync(path.join(workspace, "x.txt"), "utf-8")).toBe("second");
        });
    });

    describe("listDir", () => {
        it("lists files and marks directories with a trailing slash", () => {
            fs.writeFileSync(path.join(workspace, "file.txt"), "");
            fs.mkdirSync(path.join(workspace, "subdir"));
            const entries = listDir(workspace, ".");
            expect(entries).toContain("file.txt");
            expect(entries).toContain("subdir/");
        });
    });

    describe("searchFiles", () => {
        it("finds matching lines with file and line number", () => {
            fs.writeFileSync(path.join(workspace, "code.txt"), "line one\nfindme here\nline three");
            const results = searchFiles(workspace, "findme");
            expect(results).toEqual([{ file: "code.txt", line: 2, text: "findme here" }]);
        });

        it("skips ignored directories like node_modules", () => {
            fs.mkdirSync(path.join(workspace, "node_modules"));
            fs.writeFileSync(path.join(workspace, "node_modules", "lib.js"), "findme");
            const results = searchFiles(workspace, "findme");
            expect(results).toEqual([]);
        });
    });

    describe("executeTool", () => {
        it("dispatches to the right tool by name", async () => {
            writeFile(workspace, "y.txt", "z");
            expect(await executeTool(workspace, "read_file", { path: "y.txt" })).toBe("z");
        });

        it("throws for an unknown tool name", async () => {
            await expect(executeTool(workspace, "delete_everything", {})).rejects.toThrow(/Unknown tool/);
        });
    });

    describe("run_command", () => {
        it("captures stdout and a zero exit code from a successful command", async () => {
            const output = await executeTool(workspace, "run_command", { command: "echo hello" });
            expect(output).toContain("Exit code: 0");
            expect(output).toContain("hello");
        });

        it("captures a non-zero exit code", async () => {
            const output = await executeTool(workspace, "run_command", { command: "exit 3" });
            expect(output).toContain("Exit code: 3");
        });

        it("runs in the specified cwd within the workspace", async () => {
            fs.mkdirSync(path.join(workspace, "sub"));
            fs.writeFileSync(path.join(workspace, "sub", "marker.txt"), "");
            const output = await executeTool(workspace, "run_command", { command: "ls", cwd: "sub" });
            expect(output).toContain("marker.txt");
        });

        it("rejects a cwd that escapes the workspace", async () => {
            await expect(runCommand(workspace, "echo hi", "../../etc")).rejects.toThrow(/outside the workspace/);
        });
    });
});
