import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSafePath } from "../workspace-path";

export const MAX_READ_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_ENTRIES = 500;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "release", "__pycache__"]);

export function readFile(workspaceRoot: string, relativePath: string, startLine?: number, endLine?: number): string {
    const target = resolveSafePath(workspaceRoot, relativePath);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) throw new Error(`"${relativePath}" is a directory, not a file.`);
    const content = fs.readFileSync(target, "utf-8");
    if (startLine !== undefined || endLine !== undefined) {
        const start = Math.max(1, Math.floor(startLine ?? 1));
        const end = Math.max(start, Math.floor(endLine ?? start + 499));
        if (end - start > 2_000) throw new Error("A ranged read is limited to 2,001 lines at a time.");
        const lines = content.split(/\r?\n/);
        if (start > lines.length) throw new Error(`start_line ${start} is beyond the file's ${lines.length} lines.`);
        return lines.slice(start - 1, Math.min(end, lines.length)).join("\n");
    }
    return content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n\n[truncated — file is ${content.length} characters]`
        : content;
}

interface WriteBackup {
    relativePath: string;
    // null means the file didn't exist before this write — rollback deletes it.
    previousContent: string | null;
}

// Undo history is kept in memory only, per workspace, capped so a long agent
// session doesn't grow this unboundedly. It's intentionally session-scoped
// (not written to disk) — Rollback is a quick "oops" safety net for the
// current run, not a durable version history.
const MAX_BACKUPS_PER_WORKSPACE = 20;
const writeBackups = new Map<string, WriteBackup[]>();

function normalizeWorkspaceKey(workspaceRoot: string): string {
    return path.resolve(workspaceRoot);
}

function recordBackup(workspaceRoot: string, relativePath: string, previousContent: string | null): void {
    const key = normalizeWorkspaceKey(workspaceRoot);
    const stack = writeBackups.get(key) ?? [];
    stack.push({ relativePath, previousContent });
    while (stack.length > MAX_BACKUPS_PER_WORKSPACE) stack.shift();
    writeBackups.set(key, stack);
}

export function writeFile(workspaceRoot: string, relativePath: string, content: string): { bytesWritten: number } {
    const target = resolveSafePath(workspaceRoot, relativePath);
    let previousContent: string | null = null;
    try {
        previousContent = fs.readFileSync(target, "utf-8");
    } catch {
        previousContent = null; // file doesn't exist yet — this write creates it
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    recordBackup(workspaceRoot, relativePath, previousContent);
    return { bytesWritten: Buffer.byteLength(content) };
}

export function replaceInFile(
    workspaceRoot: string,
    relativePath: string,
    oldText: string,
    newText: string,
    replaceAll = false
): { replacements: number; bytesWritten: number } {
    if (!oldText) throw new Error("old_text must not be empty.");
    const target = resolveSafePath(workspaceRoot, relativePath);
    const content = fs.readFileSync(target, "utf-8");
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) throw new Error("old_text was not found in the file.");
    if (!replaceAll && occurrences !== 1) {
        throw new Error(`old_text matched ${occurrences} times; provide a unique block or set replace_all=true.`);
    }
    const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    recordBackup(workspaceRoot, relativePath, content);
    fs.writeFileSync(target, updated);
    return { replacements: replaceAll ? occurrences : 1, bytesWritten: Buffer.byteLength(updated) };
}

export interface RollbackResult {
    path: string;
    restoredContent: boolean; // true = previous content restored, false = newly-created file was deleted
}

export function rollbackLastWrite(workspaceRoot: string): RollbackResult | null {
    const key = normalizeWorkspaceKey(workspaceRoot);
    const stack = writeBackups.get(key);
    const backup = stack?.pop();
    if (!backup) return null;
    const target = resolveSafePath(workspaceRoot, backup.relativePath);
    if (backup.previousContent === null) {
        fs.rmSync(target, { force: true });
        return { path: backup.relativePath, restoredContent: false };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, backup.previousContent);
    return { path: backup.relativePath, restoredContent: true };
}

export function listDir(workspaceRoot: string, relativePath: string): string[] {
    const target = resolveSafePath(workspaceRoot, relativePath || ".");
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries.slice(0, MAX_LIST_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

function globToRegExp(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, "/");
    let source = "^";
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        if (char === "*" && normalized[i + 1] === "*") {
            i++;
            if (normalized[i + 1] === "/") {
                i++;
                source += "(?:.*/)?";
            } else {
                source += ".*";
            }
        } else if (char === "*") source += "[^/]*";
        else if (char === "?") source += "[^/]";
        else source += char.replace(/[\\^$.[\]|()+{}]/g, "\\$&");
    }
    return new RegExp(`${source}$`, "i");
}

export function findFiles(workspaceRoot: string, pattern: string, relativePath = "."): string[] {
    if (!pattern.trim()) throw new Error("pattern must not be empty.");
    const startDir = resolveSafePath(workspaceRoot, relativePath);
    const matcher = globToRegExp(pattern);
    const results: string[] = [];
    function walk(dir: string): void {
        if (results.length >= MAX_LIST_ENTRIES) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                const relative = path.relative(startDir, full).split(path.sep).join("/");
                if (matcher.test(relative)) results.push(path.relative(workspaceRoot, full).split(path.sep).join("/"));
            }
        }
    }
    walk(startDir);
    return results.sort();
}

export function fileInfo(workspaceRoot: string, relativePath: string): {
    path: string; type: "file" | "directory" | "other"; sizeBytes: number; modifiedAt: string;
} {
    const target = resolveSafePath(workspaceRoot, relativePath);
    const stat = fs.statSync(target);
    return {
        path: relativePath,
        type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
    };
}

export function makeDirectory(workspaceRoot: string, relativePath: string): { created: boolean } {
    const target = resolveSafePath(workspaceRoot, relativePath);
    const existed = fs.existsSync(target);
    fs.mkdirSync(target, { recursive: true });
    return { created: !existed };
}

export function movePath(workspaceRoot: string, sourcePath: string, destinationPath: string): { moved: boolean } {
    const root = path.resolve(workspaceRoot);
    const source = resolveSafePath(workspaceRoot, sourcePath);
    const destination = resolveSafePath(workspaceRoot, destinationPath);
    if (source === root || destination === root) throw new Error("The workspace root cannot be moved or replaced.");
    if (!fs.existsSync(source)) throw new Error(`Source path "${sourcePath}" does not exist.`);
    if (fs.existsSync(destination)) throw new Error(`Destination path "${destinationPath}" already exists.`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    return { moved: true };
}

export function deletePath(workspaceRoot: string, relativePath: string, recursive = false): { deleted: boolean } {
    const root = path.resolve(workspaceRoot);
    const target = resolveSafePath(workspaceRoot, relativePath);
    if (target === root) throw new Error("The workspace root cannot be deleted.");
    if (!fs.existsSync(target)) return { deleted: false };
    const stat = fs.statSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive, force: false });
    else fs.unlinkSync(target);
    return { deleted: true };
}

export interface SearchMatch {
    file: string;
    line: number;
    text: string;
}

export function searchFiles(workspaceRoot: string, query: string, relativePath = "."): SearchMatch[] {
    const startDir = resolveSafePath(workspaceRoot, relativePath);
    const results: SearchMatch[] = [];

    function walk(dir: string): void {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (results.length >= MAX_SEARCH_RESULTS) return;
            if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            let text: string;
            try {
                text = fs.readFileSync(full, "utf-8");
            } catch {
                continue; // binary or unreadable — skip
            }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
                if (lines[i].includes(query)) {
                    results.push({
                        file: path.relative(workspaceRoot, full).split(path.sep).join("/"),
                        line: i + 1,
                        text: lines[i].trim().slice(0, 200),
                    });
                }
            }
        }
    }

    walk(startDir);
    return results;
}

// Escapes a symbol name for safe use inside a RegExp — a symbol containing
// regex metacharacters (e.g. from a typo'd argument) shouldn't throw or,
// worse, behave like an unintended pattern.
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary matching over the same directory walk as searchFiles, but
// scoped to whole identifiers — "count" won't also match "recount" or
// "counter", which a plain substring search (searchFiles) would.
export function findSymbolReferences(workspaceRoot: string, symbol: string, relativePath = "."): SearchMatch[] {
    const startDir = resolveSafePath(workspaceRoot, relativePath);
    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const results: SearchMatch[] = [];

    function walk(dir: string): void {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (results.length >= MAX_SEARCH_RESULTS) return;
            if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            let text: string;
            try {
                text = fs.readFileSync(full, "utf-8");
            } catch {
                continue; // binary or unreadable — skip
            }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
                if (pattern.test(lines[i])) {
                    results.push({
                        file: path.relative(workspaceRoot, full).split(path.sep).join("/"),
                        line: i + 1,
                        text: lines[i].trim().slice(0, 200),
                    });
                }
            }
        }
    }

    walk(startDir);
    return results;
}

// --- apply_patch: a minimal unified-diff parser/applier -------------------
// Supports the subset git diff / `diff -u` actually produce: multiple
// --- /+++ file header pairs, one or more @@ hunks each, context/add/remove
// lines, and /dev/null on either side for creates/deletes. No fuzzy
// matching — a hunk whose context doesn't match the file's current content
// throws rather than guessing, since silently misapplying a patch is worse
// than failing loudly.

interface PatchHunkLine {
    type: "context" | "add" | "remove";
    text: string;
}

interface PatchHunk {
    oldStart: number;
    lines: PatchHunkLine[];
}

interface FilePatch {
    oldPath: string | null;
    newPath: string | null;
    hunks: PatchHunk[];
}

function stripDiffPathPrefix(p: string): string {
    return p.replace(/^[ab]\//, "");
}

function parseUnifiedDiff(patchText: string): FilePatch[] {
    // A trailing "\n" (the normal case for patch text) produces one extra
    // empty element from split() that's just a string-terminator artifact,
    // not an actual blank line in the diff — without dropping it, it gets
    // parsed as a spurious empty context line at the end of the last hunk.
    const lines = patchText.replace(/\n$/, "").split("\n");
    const files: FilePatch[] = [];
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].startsWith("--- ")) {
            i++;
            continue;
        }
        const oldHeader = lines[i].slice(4).trim();
        i++;
        if (i >= lines.length || !lines[i].startsWith("+++ ")) {
            throw new Error(`Malformed patch: expected a "+++ " line after "--- ${oldHeader}".`);
        }
        const newHeader = lines[i].slice(4).trim();
        i++;
        const oldPath = oldHeader === "/dev/null" ? null : stripDiffPathPrefix(oldHeader.split("\t")[0]);
        const newPath = newHeader === "/dev/null" ? null : stripDiffPathPrefix(newHeader.split("\t")[0]);

        const hunks: PatchHunk[] = [];
        while (i < lines.length && lines[i].startsWith("@@")) {
            const match = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
            if (!match) throw new Error(`Malformed hunk header: "${lines[i]}"`);
            const oldStart = Number(match[1]);
            i++;
            const hunkLines: PatchHunkLine[] = [];
            while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("--- ")) {
                const line = lines[i];
                if (line.startsWith("+")) hunkLines.push({ type: "add", text: line.slice(1) });
                else if (line.startsWith("-")) hunkLines.push({ type: "remove", text: line.slice(1) });
                else if (line.startsWith(" ")) hunkLines.push({ type: "context", text: line.slice(1) });
                else if (line.startsWith("\\")) {
                    // "\ No newline at end of file" — not a content line.
                } else if (line === "") {
                    hunkLines.push({ type: "context", text: "" });
                } else {
                    break;
                }
                i++;
            }
            hunks.push({ oldStart, lines: hunkLines });
        }
        files.push({ oldPath, newPath, hunks });
    }
    return files;
}

function applyHunksToContent(content: string, hunks: PatchHunk[], filePath: string): string {
    const originalLines = content.length > 0 ? content.split("\n") : [];
    const result: string[] = [];
    let cursor = 0;

    for (const hunk of hunks) {
        // "@@ -0,0 ..." is the convention for a hunk against an empty/new
        // file — oldStart is 0 there, not a real 1-based line number.
        const startIdx = Math.max(0, hunk.oldStart - 1);
        if (startIdx < cursor || startIdx > originalLines.length) {
            throw new Error(`Hunk in "${filePath}" doesn't align with the file's current content (expected to start at line ${hunk.oldStart}).`);
        }
        result.push(...originalLines.slice(cursor, startIdx));
        let oldCursor = startIdx;
        for (const line of hunk.lines) {
            if (line.type === "add") {
                result.push(line.text);
                continue;
            }
            const actual = originalLines[oldCursor];
            if (actual !== line.text) {
                throw new Error(
                    `Context mismatch in "${filePath}" at line ${oldCursor + 1}: expected ${JSON.stringify(line.text)}, found ${JSON.stringify(actual ?? "<end of file>")}.`
                );
            }
            if (line.type === "context") result.push(line.text);
            oldCursor++;
        }
        cursor = oldCursor;
    }
    result.push(...originalLines.slice(cursor));
    return result.join("\n");
}

// Reads a file's complete content for use as the base of an edit. readFile()
// is display-oriented — it caps its result at MAX_READ_CHARS and appends a
// "[truncated ...]" marker — which makes it unsafe to write back: everything
// past the cap would be destroyed and the marker itself saved into the file.
function readFileForEdit(workspaceRoot: string, relativePath: string): string {
    const target = resolveSafePath(workspaceRoot, relativePath);
    if (fs.statSync(target).isDirectory()) throw new Error(`"${relativePath}" is a directory, not a file.`);
    return fs.readFileSync(target, "utf-8");
}

export function applyPatch(workspaceRoot: string, patchText: string): { filesChanged: string[] } {
    const files = parseUnifiedDiff(patchText);
    if (files.length === 0) throw new Error("No valid file patches found in the given diff.");

    // Every file's outcome is resolved in memory before anything is written.
    // Writing as we went meant a patch whose later file failed to align left
    // the earlier ones already modified — a half-applied patch, which is the
    // exact outcome this parser's refusal to fuzzy-match exists to avoid.
    //
    // `pending` (rather than a plain list) keeps resolution sequential: a diff
    // with two sections for the same path, or one that creates a file and then
    // patches it, has to see the earlier section's result instead of the stale
    // copy on disk. null means the path is pending deletion.
    const pending = new Map<string, string | null>();
    const order: string[] = [];
    const remember = (relativePath: string, content: string | null): void => {
        if (!pending.has(relativePath)) order.push(relativePath);
        pending.set(relativePath, content);
    };

    for (const file of files) {
        if (file.newPath === null) {
            if (!file.oldPath) throw new Error("Patch deletes a file but its path (/dev/null on both sides) is missing.");
            remember(file.oldPath, null);
            continue;
        }
        let existingContent: string;
        if (pending.has(file.newPath)) {
            // Already touched by an earlier section of this same patch — a
            // pending deletion reads back as empty, i.e. as a fresh file.
            existingContent = pending.get(file.newPath) ?? "";
        } else {
            existingContent = file.oldPath === null ? "" : readFileForEdit(workspaceRoot, file.newPath);
        }
        remember(file.newPath, applyHunksToContent(existingContent, file.hunks, file.newPath));
    }

    for (const relativePath of order) {
        const content = pending.get(relativePath) ?? null;
        if (content === null) deletePath(workspaceRoot, relativePath, false);
        else writeFile(workspaceRoot, relativePath, content);
    }
    return { filesChanged: order };
}

function notesPath(): string {
    return ".agent-notes.md";
}

export function readNotes(workspaceRoot: string): string {
    try {
        return readFile(workspaceRoot, notesPath());
    } catch {
        return "";
    }
}

export function writeNotes(workspaceRoot: string, content: string): { bytesWritten: number } {
    return writeFile(workspaceRoot, notesPath(), content);
}

export interface ProjectScripts {
    test?: string;
    lint?: string;
    format?: string;
    build?: string;
}

// Backs the Test/Lint/Format quick-action buttons, and (build + test) the
// default command list for the verification loop when the user hasn't set
// an explicit override — only npm-style package.json scripts are
// recognized, which covers the JS/TS projects this app's Agent mode is
// primarily used against.
export function detectProjectScripts(workspaceRoot: string): ProjectScripts {
    const pkgPath = resolveSafePath(workspaceRoot, "package.json");
    let scripts: Record<string, string> = {};
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
        scripts = pkg.scripts ?? {};
    } catch {
        return {};
    }
    return {
        test: scripts.test ? "npm test" : undefined,
        lint: scripts.lint ? "npm run lint" : undefined,
        format: scripts.format ? "npm run format" : undefined,
        build: scripts.build ? "npm run build" : undefined,
    };
}
