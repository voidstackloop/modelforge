import { shellQuote } from "../command-sandbox";
import { runCommand } from "./execution";

function gitCommand(workspaceRoot: string, args: string): Promise<string> {
    return runCommand(workspaceRoot, `git ${args}`, ".");
}

export function gitStatus(workspaceRoot: string): Promise<string> {
    return gitCommand(workspaceRoot, "status");
}

export function gitDiff(workspaceRoot: string, staged = false, relativePath?: string): Promise<string> {
    const target = relativePath ? ` -- ${shellQuote(relativePath)}` : "";
    return gitCommand(workspaceRoot, `diff${staged ? " --staged" : ""}${target}`);
}

export function gitLog(workspaceRoot: string, count = 10): Promise<string> {
    return gitCommand(workspaceRoot, `log -n ${Math.max(1, Math.min(count, 100))} --oneline`);
}

export async function gitCommit(workspaceRoot: string, message: string): Promise<string> {
    await gitCommand(workspaceRoot, "add -A");
    // JSON.stringify escapes `"` and `\` but not `$` or backticks, and the
    // result is handed to `sh -c` — so it is not a shell-quoting function.
    return gitCommand(workspaceRoot, `commit -m ${shellQuote(message)}`);
}
