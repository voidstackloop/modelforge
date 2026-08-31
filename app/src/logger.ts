import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

const MAX_LOG_BYTES = 2 * 1024 * 1024; // rotate at 2MB
const MAX_TAIL_CHARS = 20_000; // how much to include in a diagnostics snapshot
// Matches telemetry/sink.ts's own DEFAULT_MAX_AGE_MS — previously this file
// had no age-based pruning at all, so a rotated `app.log.1` could sit on disk
// indefinitely (docs/LOCAL_INFERENCE_HARDENING_PLAN.md §5), unlike the more
// careful policy already built for telemetry/sink.ts two files away.
const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function logDir(): string {
    return path.join(app.getPath("userData"), "logs");
}

function logPath(): string {
    return path.join(logDir(), "app.log");
}

function rotatedLogPath(): string {
    return `${logPath()}.1`;
}

// Runs before rotation on every write — a rotated generation from a
// long-inactive install (or one that simply never hit MAX_LOG_BYTES again
// after its one rotation) is removed once it's stale, rather than persisting
// forever. The live file itself is never pruned by age here: it's still
// being actively appended to, and rotateIfNeeded() below is what bounds its
// size.
function pruneStaleRotatedLog(): void {
    try {
        const stat = fs.statSync(rotatedLogPath());
        if (Date.now() - stat.mtimeMs > MAX_LOG_AGE_MS) {
            fs.rmSync(rotatedLogPath(), { force: true });
        }
    } catch {
        // no rotated file yet — nothing to prune
    }
}

function rotateIfNeeded(): void {
    try {
        const stat = fs.statSync(logPath());
        if (stat.size > MAX_LOG_BYTES) {
            fs.renameSync(logPath(), rotatedLogPath());
        }
    } catch {
        // no existing log file yet — nothing to rotate
    }
}

function write(level: "info" | "warn" | "error", message: string): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`;

    // Always mirror to the console too (visible when running from a terminal
    // or in DevTools via the main-process output).
    if (level === "error") console.error(message);
    else if (level === "warn") console.warn(message);
    else console.log(message);

    try {
        fs.mkdirSync(logDir(), { recursive: true });
        pruneStaleRotatedLog();
        rotateIfNeeded();
        fs.appendFileSync(logPath(), line);
    } catch {
        // If logging itself fails (e.g. disk full), there's nowhere safe left
        // to report it — console output above is the fallback.
    }
}

export const logger = {
    info: (message: string) => write("info", message),
    warn: (message: string) => write("warn", message),
    error: (message: string) => write("error", message),
};

export function getLogPath(): string {
    return logPath();
}

export function getLogTail(maxChars = MAX_TAIL_CHARS): string {
    try {
        const content = fs.readFileSync(logPath(), "utf-8");
        return content.length > maxChars ? content.slice(-maxChars) : content;
    } catch {
        return "";
    }
}
