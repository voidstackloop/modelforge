import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "../process-tree";
import { applySandbox } from "../command-sandbox";
import { monitorProcess } from "../resource-monitor";
import * as settingsStore from "../settings-store";
import { resolveSafePath } from "../workspace-path";

const execAsync = promisify(exec);

const MAX_COMMAND_OUTPUT_CHARS = 50_000;
const COMMAND_TIMEOUT_MS = 60_000;

// Defense in depth for `run_command`: the workspace-root sandboxing above
// only constrains our own read_file/write_file/list_dir/search_files
// implementations, which build and validate paths themselves. A shell
// command is opaque text — it can reference any path on disk (`rm -rf ~`,
// `del C:\Windows`) regardless of the `cwd` we launch it in, so `cwd`
// alone is not a real sandbox against a destructive command. This can't
// catch everything a shell is capable of, but it blocks the common,
// catastrophic patterns outright — even if the user already clicked
// "Allow" without noticing what the command actually does.
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
    /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/|~|\*|\$HOME|\.\.)/i, // rm -rf /, ~, *, ..
    /\bdel\s+\/[sf]\s.*[a-z]:\\/i, // del /s /q C:\...
    /\brd\s+\/s\s+\/q\s+[a-z]:\\/i, // rd /s /q C:\...
    /\bformat\s+[a-z]:/i,
    /\bdiskpart\b/i,
    /\bmkfs(\.\w+)?\b/i,
    /\bdd\s+if=.*\bof=\/dev\//i,
    /\b(shutdown|reboot)\b/i,
    /\bRestart-Computer\b/i,
    /\bStop-Computer\b/i,
    /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;\s*:/, // classic fork bomb
    /\breg(\.exe)?\s+delete\b/i,
    /\bregedit\b/i,
    /\bsudo\b/i,
    /\brunas\b/i,
    /\bchmod\s+-R\s+777\s+\//i,
    /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/i, // curl ... | sh
    /\b(iwr|Invoke-WebRequest)\b[^|]*\|\s*(iex|Invoke-Expression)\b/i,
];

export function findDangerousCommandReason(command: string): string | null {
    const match = DANGEROUS_COMMAND_PATTERNS.find((pattern) => pattern.test(command));
    return match
        ? "This command was blocked because it matches a pattern that could affect your whole system rather than just the workspace folder (e.g. deleting outside it, a system shutdown, or a privilege-escalation attempt)."
        : null;
}

function truncateOutput(text: string): string {
    return text.length > MAX_COMMAND_OUTPUT_CHARS
        ? `${text.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n[truncated]`
        : text;
}

function formatCommandResult(stdout: string, stderr: string, exitCode: number | null): string {
    const parts = [`Exit code: ${exitCode}`];
    if (stdout) parts.push(`--- stdout ---\n${truncateOutput(stdout)}`);
    if (stderr) parts.push(`--- stderr ---\n${truncateOutput(stderr)}`);
    return parts.join("\n\n");
}

export async function runCommand(
    workspaceRoot: string,
    command: string,
    relativeCwd = ".",
    network = false
): Promise<string> {
    const dangerReason = findDangerousCommandReason(command);
    if (dangerReason) throw new Error(dangerReason);

    const cwd = resolveSafePath(workspaceRoot, relativeCwd);
    const wrappedCommand = applySandbox(command, { workspaceRoot, allowNetwork: network, cwd });
    const settings = settingsStore.getSettings();
    let stopMonitor = () => {};
    try {
        const execPromise = execAsync(wrappedCommand, {
            cwd,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
        });
        // execPromise.child is a documented feature of promisify(exec) — the
        // returned promise carries the underlying ChildProcess, which is the
        // only way to get its pid for resource-monitor.ts to watch.
        if (execPromise.child.pid) {
            stopMonitor = monitorProcess(
                execPromise.child.pid,
                { maxMemoryMB: settings.sandboxMaxMemoryMB, maxCpuPercent: settings.sandboxMaxCpuPercent },
                () => execPromise.child.kill()
            );
        }
        const { stdout, stderr } = await execPromise;
        return formatCommandResult(stdout, stderr, 0);
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message: string };
        if (e.killed) {
            return `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.\n\n${formatCommandResult(e.stdout ?? "", e.stderr ?? "", e.code ?? null)}`;
        }
        return formatCommandResult(e.stdout ?? "", e.stderr ?? e.message, e.code ?? null);
    } finally {
        stopMonitor();
    }
}

// run_code is a thin convenience wrapper over run_command for multi-line
// snippets (avoids shell-quoting hell for real code) — it carries the exact
// same risk and is checked against the exact same blocklist as run_command,
// applied to the source text too since dangerous *content* (not just the
// invocation) could otherwise slip past a check that only looks at the
// command line.
export async function runCode(
    workspaceRoot: string,
    language: "python" | "javascript",
    code: string,
    relativeCwd = ".",
    network = false
): Promise<string> {
    const dangerReason = findDangerousCommandReason(code);
    if (dangerReason) throw new Error(dangerReason);

    const ext = language === "python" ? "py" : "js";
    const tmpFile = path.join(os.tmpdir(), `modelforge-code-${randomUUID()}.${ext}`);
    fs.writeFileSync(tmpFile, code);
    try {
        const interpreter = language === "python" ? "python3" : "node";
        return await runCommand(workspaceRoot, `${interpreter} "${tmpFile}"`, relativeCwd, network);
    } finally {
        fs.rmSync(tmpFile, { force: true });
    }
}

interface BackgroundTask {
    id: string;
    name: string;
    command: string;
    process: ChildProcess;
    // Absolute path — lets killBackgroundCommandsForWorkspace() target only
    // the tasks that belong to a workspace being switched away from, rather
    // than every background task the process has ever started.
    workspaceRoot: string;
    // Rolling tail of combined stdout+stderr — capped so a chatty dev server
    // can't grow memory unboundedly over a long session.
    output: string;
    exitCode: number | null;
    startedAt: number;
}

const MAX_BACKGROUND_TASKS = 5;
const MAX_BACKGROUND_OUTPUT_CHARS = 100_000;
const BACKGROUND_OUTPUT_TAIL_CHARS = 20_000;
const backgroundTasks = new Map<string, BackgroundTask>();

export function startBackgroundCommand(
    workspaceRoot: string,
    command: string,
    relativeCwd = ".",
    name?: string,
    network = false
): { taskId: string; name: string } {
    const dangerReason = findDangerousCommandReason(command);
    if (dangerReason) throw new Error(dangerReason);
    const runningCount = [...backgroundTasks.values()].filter((t) => t.exitCode === null).length;
    if (runningCount >= MAX_BACKGROUND_TASKS) {
        throw new Error(`Already running ${MAX_BACKGROUND_TASKS} background commands — stop one first.`);
    }

    const cwd = resolveSafePath(workspaceRoot, relativeCwd);
    const wrappedCommand = applySandbox(command, { workspaceRoot, allowNetwork: network, cwd });
    // detached so the shell becomes its own process group leader — lets
    // killProcessTree() below signal the whole group (shell + whatever it
    // spawned, e.g. `npm run dev` spawning `node`) instead of just the shell
    // itself, which is all a plain .kill() would reach. No effect on Windows,
    // where killProcessTree uses `taskkill /t` instead.
    const child = spawn(wrappedCommand, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
    });
    const id = randomUUID().slice(0, 8);
    const task: BackgroundTask = {
        id,
        name: name?.trim() || command.slice(0, 40),
        command,
        process: child,
        workspaceRoot: path.resolve(workspaceRoot),
        output: "",
        exitCode: null,
        startedAt: Date.now(),
    };
    const append = (chunk: Buffer) => {
        task.output += chunk.toString();
        if (task.output.length > MAX_BACKGROUND_OUTPUT_CHARS) {
            task.output = task.output.slice(-MAX_BACKGROUND_OUTPUT_CHARS);
        }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
        task.output += `\n[failed to start: ${err.message}]`;
        task.exitCode = -1;
    });
    const settings = settingsStore.getSettings();
    const stopMonitor = child.pid
        ? monitorProcess(
              child.pid,
              { maxMemoryMB: settings.sandboxMaxMemoryMB, maxCpuPercent: settings.sandboxMaxCpuPercent },
              (reason) => append(Buffer.from(`\n[background task stopped: ${reason}]`))
          )
        : () => {};
    child.on("exit", (code) => {
        stopMonitor();
        task.exitCode = code ?? -1;
    });
    backgroundTasks.set(id, task);
    return { taskId: id, name: task.name };
}

export function getBackgroundOutput(taskId: string): string {
    const task = backgroundTasks.get(taskId);
    if (!task) throw new Error(`No background task with id "${taskId}".`);
    const status =
        task.exitCode === null
            ? `running (${Math.round((Date.now() - task.startedAt) / 1000)}s)`
            : `exited with code ${task.exitCode}`;
    const tail =
        task.output.length > BACKGROUND_OUTPUT_TAIL_CHARS
            ? `[...earlier output trimmed]\n${task.output.slice(-BACKGROUND_OUTPUT_TAIL_CHARS)}`
            : task.output;
    return `Task ${task.id} (${task.name}): ${status}\n--- output ---\n${tail || "(no output yet)"}`;
}

export function stopBackgroundCommand(taskId: string): string {
    const task = backgroundTasks.get(taskId);
    if (!task) throw new Error(`No background task with id "${taskId}".`);
    if (task.exitCode !== null) return `Task ${task.id} had already exited with code ${task.exitCode}.`;
    if (task.process.pid) killProcessTree(task.process.pid);
    return `Task ${task.id} (${task.name}) stopped.`;
}

export function listBackgroundCommands(): { id: string; name: string; command: string; status: string }[] {
    return [...backgroundTasks.values()].map((t) => ({
        id: t.id,
        name: t.name,
        command: t.command,
        status: t.exitCode === null ? "running" : `exited (${t.exitCode})`,
    }));
}

export function killAllBackgroundCommands(): void {
    for (const task of backgroundTasks.values()) {
        if (task.exitCode === null && task.process.pid) killProcessTree(task.process.pid);
    }
    backgroundTasks.clear();
}

// Only tears down tasks belonging to the workspace being switched away from
// — background commands are otherwise never cleaned up until app quit
// (killAllBackgroundCommands, called from window-all-closed/before-quit),
// so switching to a different workspace mid-session used to leave the old
// one's tasks running indefinitely, silently eating into MAX_BACKGROUND_TASKS.
export function killBackgroundCommandsForWorkspace(workspaceRoot: string): number {
    const root = path.resolve(workspaceRoot);
    let killed = 0;
    for (const [id, task] of backgroundTasks) {
        if (task.workspaceRoot !== root) continue;
        if (task.exitCode === null && task.process.pid) killProcessTree(task.process.pid);
        backgroundTasks.delete(id);
        killed++;
    }
    return killed;
}
