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

// bwrap being on PATH isn't sufficient on its own — modern Ubuntu (23.10+)
// restricts unprivileged user-namespace creation by default (AppArmor
// policy), which makes bwrap fail at runtime with a permission error even
// when it's installed. A plain `which bwrap` check wouldn't catch that and
// would report false confidence, so this actually runs a trivial sandboxed
// no-op and checks it really works.
function canUseBubblewrap(): boolean {
    if (!commandExists("bwrap")) return false;
    try {
        execFileSync("bwrap", ["--unshare-all", "--dev", "/dev", "--proc", "/proc", "true"], {
            stdio: "ignore",
            timeout: 5000,
        });
        return true;
    } catch {
        return false;
    }
}

function defaultAvailabilityCheck(cmd: string): boolean {
    return cmd === "bwrap" ? canUseBubblewrap() : commandExists(cmd);
}

// `hasCommand` is injectable so tests can simulate "bwrap is/isn't usable"
// without actually shelling out.
export function detectSandboxCapabilities(
    platform: NodeJS.Platform = process.platform,
    hasCommand: (cmd: string) => boolean = defaultAvailabilityCheck
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
    hasCommand: (cmd: string) => boolean = defaultAvailabilityCheck
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

// Quotes a single argument so the shell that will run it treats it as one
// literal value. Used both to fold a wrapped {command, args} back into the
// single shell-command string that `child_process.exec`/`spawn(...,
// {shell:true})` expect, and by agent-tools.ts when it builds a fixed command
// around a *value* the model supplied (a path for `git diff`, a message for
// `git commit`).
//
// The two shells need different treatment, and getting this wrong in either
// direction is a bug:
//
//  - POSIX `sh`: single quotes, with an embedded quote written as '\''.
//    Double quotes would not be enough, because `$(...)` and backticks are
//    still expanded inside them.
//  - Windows `cmd.exe`: single quotes are not quote characters at all, so
//    POSIX quoting there would corrupt ordinary arguments rather than protect
//    them. Double quotes are the right tool: `&`, `|`, `<` and `>` are
//    literal inside them, and `$(...)`/backticks mean nothing to cmd.exe.
//    An embedded double quote is written as "" — the convention both cmd.exe
//    and the argv parser of the program being launched understand.
export function shellQuote(arg: string, platform: NodeJS.Platform = process.platform): string {
    if (platform === "win32") return `"${arg.replace(/"/g, '""')}"`;
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
    hasCommand: (cmd: string) => boolean = defaultAvailabilityCheck
): string {
    const wrapped = wrapCommand(command, opts, platform, hasCommand);
    if (!wrapped) return command;
    return [wrapped.command, ...wrapped.args].map((arg) => shellQuote(arg, platform)).join(" ");
}
