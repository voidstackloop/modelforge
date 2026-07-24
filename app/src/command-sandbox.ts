import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface SandboxCapabilities {
    filesystemConfinement: boolean;
    networkDenial: boolean;
    // "unshare" is deliberately not offered as a mechanism even though the
    // `unshare` binary itself is present on nearly every Linux system:
    // creating a network namespace via plain `unshare --net` commonly
    // requires privileges plain users don't have (fails with "Operation not
    // permitted" on many stock kernel configs), which would make a sandboxed
    // command fail outright instead of just running unsandboxed — worse than
    // not attempting it. bubblewrap handles the unprivileged-namespace setup
    // properly and is the only mechanism offered on Linux.
    mechanism: "bubblewrap" | "sandbox-exec" | "none";
}

function commandExists(cmd: string): boolean {
    try {
        execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

// `hasCommand` is injectable so tests can simulate "bwrap is/isn't on PATH"
// without actually shelling out.
export function detectSandboxCapabilities(
    platform: NodeJS.Platform = process.platform,
    hasCommand: (cmd: string) => boolean = commandExists
): SandboxCapabilities {
    if (platform === "linux") {
        if (hasCommand("bwrap")) return { filesystemConfinement: true, networkDenial: true, mechanism: "bubblewrap" };
        return { filesystemConfinement: false, networkDenial: false, mechanism: "none" };
    }
    if (platform === "darwin") {
        // Built into macOS — no install needed, so this should essentially
        // always be available, but check anyway rather than assume.
        if (hasCommand("sandbox-exec")) return { filesystemConfinement: true, networkDenial: true, mechanism: "sandbox-exec" };
        return { filesystemConfinement: false, networkDenial: false, mechanism: "none" };
    }
    // Windows has no equivalent lightweight primitive: Windows Sandbox is a
    // VM-like container requiring Pro/Enterprise, and Job Objects/restricted
    // tokens don't confine the filesystem or network. Stays on the existing
    // command-text blocklist plus resource-monitor.ts limits.
    return { filesystemConfinement: false, networkDenial: false, mechanism: "none" };
}

export interface WrapCommandOptions {
    workspaceRoot: string;
    allowNetwork: boolean;
}

export interface WrappedCommand {
    command: string;
    args: string[];
}

// Wraps `command` (a shell command string, run via `sh -c` either way) so it
// executes inside an OS-level sandbox instead of directly. Returns null when
// no sandboxing mechanism is available — callers should fall back to
// running `command` unwrapped rather than failing outright.
export function wrapCommand(
    command: string,
    opts: WrapCommandOptions,
    platform: NodeJS.Platform = process.platform,
    hasCommand: (cmd: string) => boolean = commandExists
): WrappedCommand | null {
    const caps = detectSandboxCapabilities(platform, hasCommand);
    const root = path.resolve(opts.workspaceRoot);

    if (caps.mechanism === "bubblewrap") {
        const args = [
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            // Bound through (not a fresh --tmpfs) so files written to the
            // real /tmp before the sandboxed process starts — e.g. run_code's
            // temp script file, written via the host's os.tmpdir() — are
            // still visible inside the sandbox.
            "--bind",
            "/tmp",
            "/tmp",
            "--bind",
            root,
            root,
            "--chdir",
            root,
            "--die-with-parent",
            "--unshare-all",
        ];
        if (opts.allowNetwork) args.push("--share-net");
        args.push("sh", "-c", command);
        return { command: "bwrap", args };
    }

    if (caps.mechanism === "sandbox-exec") {
        return { command: "sandbox-exec", args: ["-p", buildMacSandboxProfile(root, opts.allowNetwork), "sh", "-c", command] };
    }

    return null;
}

function buildMacSandboxProfile(workspaceRoot: string, allowNetwork: boolean): string {
    const escaped = workspaceRoot.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return [
        "(version 1)",
        "(allow default)",
        '(deny file-write* (subpath "/"))',
        `(allow file-write* (subpath "${escaped}"))`,
        // macOS's real temp dirs — os.tmpdir() resolves under
        // /var/folders/.../T (symlinked from /private/var/folders), and
        // /tmp itself is a symlink to /private/tmp. Both need to stay
        // writable for the same reason /tmp does in the bubblewrap path
        // above: run_code's temp script file lives there.
        '(allow file-write* (subpath "/tmp"))',
        '(allow file-write* (subpath "/private/tmp"))',
        '(allow file-write* (subpath "/private/var/folders"))',
        allowNetwork ? "(allow network*)" : "(deny network*)",
        "",
    ].join("\n");
}

// POSIX shell single-quoting: wraps in '...', escaping any embedded single
// quote as '\''. Used to fold a wrapped {command, args} back into the single
// shell-command string that `child_process.exec`/`spawn(..., {shell:true})`
// expect, without needing to change how the rest of agent-tools.ts invokes
// commands.
function shellQuote(arg: string): string {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// Applies sandboxing to `command` if a mechanism is available on this
// platform, otherwise returns it unchanged — the one function agent-tools.ts
// actually calls before handing a command to exec/spawn. `platform`/
// `hasCommand` are forwarded to wrapCommand purely so tests can exercise
// this without depending on the host OS.
export function applySandbox(
    command: string,
    opts: WrapCommandOptions,
    platform: NodeJS.Platform = process.platform,
    hasCommand: (cmd: string) => boolean = commandExists
): string {
    const wrapped = wrapCommand(command, opts, platform, hasCommand);
    if (!wrapped) return command;
    return [wrapped.command, ...wrapped.args].map(shellQuote).join(" ");
}
