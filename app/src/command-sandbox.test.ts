import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { detectSandboxCapabilities, wrapCommand, applySandbox, shellQuote } from "./command-sandbox";

const has = (available: string[]) => (cmd: string) => available.includes(cmd);

// wrapCommand resolves paths with the real (host-native) path.resolve
// regardless of the `platform` argument used to simulate capability
// detection — that argument only picks which sandbox mechanism to build for,
// it doesn't make path.resolve itself POSIX. So these tests build their
// expected paths the same way, via path.resolve, rather than hardcoding
// POSIX literals that would only match on Linux/macOS test runners and fail
// on Windows CI where path.resolve("/home/user/project") is
// "D:\\home\\user\\project".
const resolved = (p: string) => path.resolve(p);
// Mirrors buildMacSandboxProfile's own escaping of the resolved path so the
// expected profile string matches on any host, backslashes and all.
const macProfileEscaped = (p: string) => resolved(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

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
        expect(wrapped?.args).toEqual(expect.arrayContaining(["--bind", resolved("/home/user/project"), resolved("/home/user/project")]));
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
        expect(wrapped?.args[1]).toContain(`(allow file-write* (subpath "${macProfileEscaped("/Users/me/project")}"))`);
        expect(wrapped?.args[1]).toContain("(deny network*)");
        expect(wrapped?.args.slice(-3)).toEqual(["sh", "-c", "npm test"]);
    });

    it("allows network in the sandbox-exec profile when requested", () => {
        const wrapped = wrapCommand("curl example.com", { workspaceRoot: "/Users/me/project", allowNetwork: true }, "darwin", has(["sandbox-exec"]));
        expect(wrapped?.args[1]).toContain("(allow network*)");
        expect(wrapped?.args[1]).not.toContain("(deny network*)");
    });

    // --chdir takes precedence over the working directory bwrap inherits from
    // the spawning process, so pinning it to the workspace root silently
    // overrode the subdirectory the caller had already resolved.
    it("chdirs to the requested subdirectory, not just the workspace root", () => {
        const wrapped = wrapCommand(
            "npm test",
            { workspaceRoot: "/home/user/project", allowNetwork: false, cwd: "/home/user/project/packages/api" },
            "linux",
            has(["bwrap"])
        );
        const chdirIndex = wrapped!.args.indexOf("--chdir");
        expect(chdirIndex).toBeGreaterThan(-1);
        expect(wrapped!.args[chdirIndex + 1]).toBe(resolved("/home/user/project/packages/api"));
        // The workspace root is still what gets bound writable.
        expect(wrapped!.args).toEqual(expect.arrayContaining(["--bind", resolved("/home/user/project"), resolved("/home/user/project")]));
    });

    it("falls back to the workspace root when no cwd is given", () => {
        const wrapped = wrapCommand("npm test", { workspaceRoot: "/home/user/project", allowNetwork: false }, "linux", has(["bwrap"]));
        const chdirIndex = wrapped!.args.indexOf("--chdir");
        expect(wrapped!.args[chdirIndex + 1]).toBe(resolved("/home/user/project"));
    });
});

describe("shellQuote", () => {
    it("single-quotes for POSIX shells so substitutions stay inert", () => {
        expect(shellQuote("simple.txt", "linux")).toBe("'simple.txt'");
        // The whole point: a POSIX shell expands these inside double quotes.
        expect(shellQuote("$(id)", "linux")).toBe("'$(id)'");
        expect(shellQuote("`id`", "linux")).toBe("'`id`'");
        expect(shellQuote("it's", "linux")).toBe("'it'\\''s'");
        expect(shellQuote("", "linux")).toBe("''");
    });

    // cmd.exe does not treat ' as a quote character, so POSIX quoting there
    // would split ordinary arguments on their spaces instead of protecting
    // them. It has no $(...) or backtick substitution to defend against.
    it("double-quotes for cmd.exe, where single quotes are not quoting", () => {
        expect(shellQuote("a message with spaces", "win32")).toBe('"a message with spaces"');
        expect(shellQuote('say "hi"', "win32")).toBe('"say ""hi"""');
        expect(shellQuote("a & b", "win32")).toBe('"a & b"');
        expect(shellQuote("", "win32")).toBe('""');
    });
});

describe("applySandbox", () => {
    it("returns the command unchanged when no sandbox mechanism is available", () => {
        expect(applySandbox("echo hi", { workspaceRoot: "/ws", allowNetwork: false }, "win32", has(["bwrap"]))).toBe("echo hi");
    });

    it("folds a bubblewrap-wrapped command into a single shell string ending in the original command", () => {
        const result = applySandbox("npm test", { workspaceRoot: "/home/user/project", allowNetwork: false }, "linux", has(["bwrap"]));
        expect(result.startsWith("'bwrap' ")).toBe(true);
        expect(result).toContain(`'${resolved("/home/user/project")}'`);
        expect(result.endsWith("'sh' '-c' 'npm test'")).toBe(true);
    });

    it("shell-quotes a workspace path containing a single quote so it can't break out of the wrapper", () => {
        const result = applySandbox("echo hi", { workspaceRoot: "/home/user/it's-a-project", allowNetwork: false }, "linux", has(["bwrap"]));
        // A raw unescaped single quote here would terminate the shell string
        // early and let the rest of the path be interpreted as commands.
        // applySandbox always quotes POSIX-style here since it's passed the
        // simulated "linux" platform, regardless of the host OS actually
        // running this test — only the resolved path's format varies by host.
        expect(result).toContain(`'${resolved("/home/user/it's-a-project").replace(/'/g, "'\\''")}'`);
    });
});
