import * as path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { wrapCommand } from "./command-sandbox";
import { killProcessTree } from "./process-tree";
import { resolveSafePath } from "./workspace-path";

export interface TerminalInfo {
    id: string;
    name: string;
    workspaceRoot: string;
    alive: boolean;
}

interface TerminalSession {
    id: string;
    name: string;
    workspaceRoot: string;
    pty: IPty;
    // Rolling buffer of everything the pty has emitted — capped the same way
    // background-task output is, so a chatty process can't grow memory
    // unboundedly over a long session. Doubles as what gets shown when a
    // session is reopened after a restart (the process itself can't survive
    // that, but its last output can).
    scrollback: string;
    alive: boolean;
}

// Global, not per-workspace — mirrors MAX_BACKGROUND_TASKS in agent-tools.ts,
// which uses the same global-cap shape.
const MAX_TERMINALS = 5;
const MAX_SCROLLBACK_CHARS = 200_000;

const terminals = new Map<string, TerminalSession>();
let nextId = 1;

function defaultShell(): string {
    if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
    return process.env.SHELL || "/bin/bash";
}

export function createTerminal(
    workspaceRoot: string,
    opts: { cwd?: string; name?: string } = {},
    onData: (chunk: string) => void,
    onExit: (exitCode: number) => void
): { id: string; name: string } {
    const runningCount = [...terminals.values()].filter((t) => t.alive).length;
    if (runningCount >= MAX_TERMINALS) {
        throw new Error(`Already have ${MAX_TERMINALS} terminals open — close one first.`);
    }

    const cwd = resolveSafePath(workspaceRoot, opts.cwd ?? ".");
    const shell = defaultShell();
    // Terminals default to allowing network — unlike a one-shot run_command
    // call the model composes, this is an interactive session a human can
    // type into directly and see exactly what's happening, so the tighter
    // per-call default elsewhere in Agent mode would mostly just make
    // ordinary shell use (curl, ping, package managers) confusingly fail.
    // Filesystem confinement to the workspace still applies where the
    // platform supports it.
    const wrapped = wrapCommand(shell, { workspaceRoot, allowNetwork: true, cwd });
    const ptyOptions = { name: "xterm-256color", cols: 80, rows: 24, cwd, env: process.env };
    const ptyProcess = wrapped ? pty.spawn(wrapped.command, wrapped.args, ptyOptions) : pty.spawn(shell, [], ptyOptions);

    const id = `t${nextId++}`;
    const session: TerminalSession = {
        id,
        name: opts.name?.trim() || `Terminal ${id}`,
        workspaceRoot: path.resolve(workspaceRoot),
        pty: ptyProcess,
        scrollback: "",
        alive: true,
    };
    ptyProcess.onData((chunk) => {
        session.scrollback += chunk;
        if (session.scrollback.length > MAX_SCROLLBACK_CHARS) {
            session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK_CHARS);
        }
        onData(chunk);
    });
    ptyProcess.onExit(({ exitCode }) => {
        session.alive = false;
        onExit(exitCode);
    });
    terminals.set(id, session);
    return { id, name: session.name };
}

function requireTerminal(id: string): TerminalSession {
    const session = terminals.get(id);
    if (!session) throw new Error(`No terminal with id "${id}".`);
    return session;
}

export function writeToTerminal(id: string, data: string): void {
    requireTerminal(id).pty.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
    requireTerminal(id).pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
}

export function readTerminalOutput(id: string, tailChars = 4000): string {
    const session = requireTerminal(id);
    return session.scrollback.length > tailChars ? session.scrollback.slice(-tailChars) : session.scrollback;
}

// Removes the session entirely, unlike a plain kill — once the user (or the
// model) explicitly closes a terminal there's no reason to keep it around
// for listTerminals()/readTerminalOutput() to still surface.
export function closeTerminal(id: string): void {
    const session = terminals.get(id);
    if (!session) return;
    if (session.alive && session.pty.pid) killProcessTree(session.pty.pid);
    terminals.delete(id);
}

// Same role as killBackgroundCommandsForWorkspace in agent-tools.ts — called
// when the renderer switches away from a workspace so terminals from the
// old one don't keep running (and don't keep counting against
// MAX_TERMINALS) until app quit.
export function closeAllForWorkspace(workspaceRoot: string): number {
    const root = path.resolve(workspaceRoot);
    let closed = 0;
    for (const [id, session] of terminals) {
        if (session.workspaceRoot !== root) continue;
        closeTerminal(id);
        closed++;
    }
    return closed;
}

export function closeAll(): void {
    for (const id of [...terminals.keys()]) closeTerminal(id);
}

export function listTerminals(workspaceRoot?: string): TerminalInfo[] {
    const root = workspaceRoot ? path.resolve(workspaceRoot) : undefined;
    return [...terminals.values()]
        .filter((t) => !root || t.workspaceRoot === root)
        .map((t) => ({ id: t.id, name: t.name, workspaceRoot: t.workspaceRoot, alive: t.alive }));
}
