import { describe, it, expect } from "vitest";
import { detectSandboxCapabilities, wrapCommand, applySandbox } from "./command-sandbox";

const has = (available: string[]) => (cmd: string) => available.includes(cmd);

describe("detectSandboxCapabilities", () => {
    it("prefers bubblewrap on Linux when available", () => {
        expect(detectSandboxCapabilities("linux", has(["bwrap"]))).toEqual({
            filesystemConfinement: true,
            networkDenial: true,
            mechanism: "bubblewrap",
        });
    });

    it("reports no containment on Linux without bubblewrap", () => {
        expect(detectSandboxCapabilities("linux", has([]))).toEqual({
            filesystemConfinement: false,
            networkDenial: false,
            mechanism: "none",
        });
    });

    it("uses sandbox-exec on macOS when available", () => {
        expect(detectSandboxCapabilities("darwin", has(["sandbox-exec"]))).toEqual({
            filesystemConfinement: true,
            networkDenial: true,
            mechanism: "sandbox-exec",
        });
    });

    it("reports no containment on macOS without sandbox-exec", () => {
        expect(detectSandboxCapabilities("darwin", has([]))).toEqual({
            filesystemConfinement: false,
            networkDenial: false,
            mechanism: "none",
        });
    });

    it("always reports no containment on Windows, regardless of PATH", () => {
        expect(detectSandboxCapabilities("win32", has(["bwrap", "sandbox-exec"]))).toEqual({
            filesystemConfinement: false,
            networkDenial: false,
            mechanism: "none",
        });
    });
});

describe("wrapCommand", () => {
    it("returns null when no sandbox mechanism is available", () => {
        expect(wrapCommand("echo hi", { workspaceRoot: "/ws", allowNetwork: false }, "win32", has([]))).toBeNull();
        expect(wrapCommand("echo hi", { workspaceRoot: "/ws", allowNetwork: false }, "linux", has([]))).toBeNull();
    });

    it("builds a bubblewrap invocation confining writes to the workspace, network denied by default", () => {
        const wrapped = wrapCommand("npm test", { workspaceRoot: "/home/user/project", allowNetwork: false }, "linux", has(["bwrap"]));
        expect(wrapped?.command).toBe("bwrap");
        expect(wrapped?.args).toContain("--unshare-all");
        expect(wrapped?.args).not.toContain("--share-net");
        expect(wrapped?.args).toEqual(expect.arrayContaining(["--bind", "/home/user/project", "/home/user/project"]));
        expect(wrapped?.args.slice(-3)).toEqual(["sh", "-c", "npm test"]);
    });

    it("adds --share-net to the bubblewrap invocation when network is explicitly allowed", () => {
        const wrapped = wrapCommand("npm install", { workspaceRoot: "/home/user/project", allowNetwork: true }, "linux", has(["bwrap"]));
        expect(wrapped?.args).toContain("--share-net");
    });

    it("builds a sandbox-exec invocation with a profile scoped to the workspace", () => {
        const wrapped = wrapCommand("npm test", { workspaceRoot: "/Users/me/project", allowNetwork: false }, "darwin", has(["sandbox-exec"]));
        expect(wrapped?.command).toBe("sandbox-exec");
        expect(wrapped?.args[0]).toBe("-p");
        expect(wrapped?.args[1]).toContain('(allow file-write* (subpath "/Users/me/project"))');
        expect(wrapped?.args[1]).toContain("(deny network*)");
        expect(wrapped?.args.slice(-3)).toEqual(["sh", "-c", "npm test"]);
    });

    it("allows network in the sandbox-exec profile when requested", () => {
        const wrapped = wrapCommand("curl example.com", { workspaceRoot: "/Users/me/project", allowNetwork: true }, "darwin", has(["sandbox-exec"]));
        expect(wrapped?.args[1]).toContain("(allow network*)");
        expect(wrapped?.args[1]).not.toContain("(deny network*)");
    });
});

describe("applySandbox", () => {
    it("returns the command unchanged when no sandbox mechanism is available", () => {
        expect(applySandbox("echo hi", { workspaceRoot: "/ws", allowNetwork: false }, "win32", has(["bwrap"]))).toBe("echo hi");
    });

    it("folds a bubblewrap-wrapped command into a single shell string ending in the original command", () => {
        const result = applySandbox("npm test", { workspaceRoot: "/home/user/project", allowNetwork: false }, "linux", has(["bwrap"]));
        expect(result.startsWith("'bwrap' ")).toBe(true);
        expect(result).toContain("'/home/user/project'");
        expect(result.endsWith("'sh' '-c' 'npm test'")).toBe(true);
    });

    it("shell-quotes a workspace path containing a single quote so it can't break out of the wrapper", () => {
        const result = applySandbox("echo hi", { workspaceRoot: "/home/user/it's-a-project", allowNetwork: false }, "linux", has(["bwrap"]));
        // A raw unescaped single quote here would terminate the shell string
        // early and let the rest of the path be interpreted as commands.
        expect(result).toContain("'/home/user/it'\\''s-a-project'");
    });
});
