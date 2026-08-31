import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logger } from "../logger";

// Local-only, append-only JSON-lines telemetry log — a third file alongside
// logger.ts's app.log (unstructured ops log) and audit-log-store.ts's
// tamper-evident compliance trail. Following json-store.ts's existing
// PRIVATE_FILE_MODE (0o600) convention, adapted for append-mode: the mode is
// applied on file creation and re-tightened if it ever drifts, skipped on
// win32 exactly like json-store.ts's own restrictExistingPermissions().
//
// Every write is synchronous and every method here runs to completion
// without an `await` in between — Node's single-threaded execution model
// means no two write() calls from within this process can interleave
// mid-line, so no separate locking is needed for same-process concurrent
// callers (multiple download jobs recording events "at the same time" still
// serializes through this same synchronous call).

const PRIVATE_FILE_MODE = 0o600;

export interface TelemetrySinkOptions {
    /** Path to the live log file; rotated generations are `${basePath}.1`,
     * `${basePath}.2`, etc. Defaults to `<userData>/logs/telemetry.jsonl`;
     * overridable so tests don't touch the real userData directory. */
    basePath?: string;
    maxFileBytes?: number;
    maxGenerations?: number;
    maxAgeMs?: number;
    maxTotalBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // matches logger.ts's own per-file rotation threshold
const DEFAULT_MAX_GENERATIONS = 5;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // across the live file + every rotated generation combined

function defaultBasePath(): string {
    return path.join(app.getPath("userData"), "logs", "telemetry.jsonl");
}

export class TelemetrySink {
    private readonly basePath: string;
    private readonly maxFileBytes: number;
    private readonly maxGenerations: number;
    private readonly maxAgeMs: number;
    private readonly maxTotalBytes: number;

    constructor(options: TelemetrySinkOptions = {}) {
        this.basePath = options.basePath ?? defaultBasePath();
        this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        this.maxGenerations = options.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
        this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
        this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    }

    private generationPath(n: number): string {
        return n === 0 ? this.basePath : `${this.basePath}.${n}`;
    }

    private rotateIfNeeded(): void {
        let size: number;
        try {
            size = fs.statSync(this.basePath).size;
        } catch {
            return; // no live file yet
        }
        if (size <= this.maxFileBytes) return;

        for (let n = this.maxGenerations; n >= 1; n--) {
            if (n === this.maxGenerations) fs.rmSync(this.generationPath(n), { force: true });
            try {
                fs.renameSync(this.generationPath(n - 1), this.generationPath(n));
            } catch {
                // no such generation to shift yet — fine
            }
        }
    }

    private pruneOldGenerations(): void {
        const cutoff = Date.now() - this.maxAgeMs;
        for (let n = 1; n <= this.maxGenerations; n++) {
            const p = this.generationPath(n);
            try {
                if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
            } catch {
                // doesn't exist — nothing to prune
            }
        }
    }

    private enforceTotalDiskCap(): void {
        const generations: { n: number; path: string; size: number; mtimeMs: number }[] = [];
        for (let n = 0; n <= this.maxGenerations; n++) {
            try {
                const stat = fs.statSync(this.generationPath(n));
                generations.push({ n, path: this.generationPath(n), size: stat.size, mtimeMs: stat.mtimeMs });
            } catch {
                // doesn't exist
            }
        }
        let total = generations.reduce((sum, g) => sum + g.size, 0);
        if (total <= this.maxTotalBytes) return;

        // Oldest-first, and never the live file (n === 0) — dropping the
        // file currently being appended to would just recreate it on the
        // very next write, defeating the point of the cap.
        const droppable = generations.filter((g) => g.n !== 0).sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const g of droppable) {
            if (total <= this.maxTotalBytes) break;
            fs.rmSync(g.path, { force: true });
            total -= g.size;
        }
    }

    /** Appends one already-validated event as a single JSON line. Never
     * throws — a write failure (disk full, permission denied) is logged and
     * otherwise swallowed, matching logger.ts's own contract: telemetry must
     * never be the reason a real operation fails. */
    write(event: unknown): void {
        try {
            fs.mkdirSync(path.dirname(this.basePath), { recursive: true });
            this.rotateIfNeeded();
            this.pruneOldGenerations();
            this.enforceTotalDiskCap();

            const line = `${JSON.stringify(event)}\n`;
            const existedBefore = fs.existsSync(this.basePath);
            fs.appendFileSync(this.basePath, line, existedBefore ? undefined : { mode: PRIVATE_FILE_MODE });

            if (existedBefore && process.platform !== "win32") {
                try {
                    if ((fs.statSync(this.basePath).mode & 0o777) !== PRIVATE_FILE_MODE) {
                        fs.chmodSync(this.basePath, PRIVATE_FILE_MODE);
                    }
                } catch {
                    // best effort — unusual ownership must not block telemetry
                }
            }
        } catch (err) {
            logger.error(`Telemetry sink write failed: ${(err as Error).message}`);
        }
    }

    /** Every valid JSON line across the live file and all rotated
     * generations, oldest generation first. A truncated or corrupt trailing
     * line (the interrupted-write case) is skipped rather than aborting the
     * whole read — the well-formed lines before and after one bad line are
     * still real, recoverable data. */
    readAll(): unknown[] {
        const events: unknown[] = [];
        for (let n = this.maxGenerations; n >= 0; n--) {
            let content: string;
            try {
                content = fs.readFileSync(this.generationPath(n), "utf-8");
            } catch {
                continue;
            }
            for (const line of content.split("\n")) {
                if (!line.trim()) continue;
                try {
                    events.push(JSON.parse(line));
                } catch {
                    // corrupted/truncated line — skip, keep the rest
                }
            }
        }
        return events;
    }
}
