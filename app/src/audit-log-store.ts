import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { app } from "electron";
import { readJsonWithSchema, writeJson } from "./json-store";
import { auditLogFileSchema } from "./schemas";
import { getSettings } from "./settings-store";
import { sha256HexNative, appendJsonArrayElementNative, isNativeDatastoreAvailable } from "./native-datastore";
import {
    isNativeSqliteStoreAvailable,
    openAuditStore as openSqliteAuditStore,
    migrateAuditLogFromJson,
    getLastAuditEventHash,
    listAuditEventsJson,
} from "./native-sqlite-store";
import type { z } from "zod";

export type AuditActionCategory = z.infer<typeof auditLogFileSchema>[number]["actionCategory"];

export interface AuditEvent {
    id: string;
    timestamp: string;
    actionCategory: AuditActionCategory;
    targetType?: "patient-case" | "session" | "export" | "settings";
    targetId?: string;
    /**
     * Short, non-clinical detail only — e.g. "openai" (a provider id) or a
     * field count, never patient-identifying or clinical narrative text.
     * Callers are responsible for keeping this PHI-free; this store does
     * not (and cannot) inspect the string for clinical content.
     */
    detail?: string;
    // mcp-tool-call fields — never the call's actual arguments/result, only
    // which server/tool/outcome/duration, for the same reason `detail` stays
    // short and non-clinical.
    mcpServerId?: string;
    mcpServerName?: string;
    mcpToolName?: string;
    approvalOutcome?: "approved" | "auto-approved" | "denied";
    durationMs?: number;
    // Hash chain — makes an out-of-band edit to audit-log.json detectable.
    // `previousEventHash` is this event's predecessor's `eventHash` (or
    // `null` for the first event this store ever wrote); `eventHash` is a
    // SHA-256 over this event's own content plus `previousEventHash`, so
    // changing anything about a past event — or reordering/deleting one —
    // breaks every hash after it. Absent on events recorded before this
    // field existed; see verifyChainIntegrity().
    previousEventHash?: string | null;
    eventHash?: string;
}

export const MAX_EVENTS = 5000;

// The fast-append path (see recordEvent below) can't add a new event without
// knowing the *current* count is under the cap, and enforcing the cap
// exactly would mean falling back to a full read-modify-write-with-trim on
// every single call once at/over MAX_EVENTS — which every long-lived
// install eventually reaches and then never leaves, turning "at capacity"
// into a permanent O(n)-per-write steady state. Instead the cap is soft:
// the file is allowed to grow up to MAX_EVENTS + TRIM_BATCH before a single
// full rewrite trims it back down to exactly MAX_EVENTS, so trimming cost is
// amortized over TRIM_BATCH appends instead of paid on every one. Retention
// accounting (Settings → Audit & Privacy) only ever describes "roughly
// MAX_EVENTS", so this bounded slack is invisible at the product level.
export const TRIM_BATCH = 100;

function filePath(): string {
    return path.join(app.getPath("userData"), "audit-log.json");
}

function readAll(): AuditEvent[] {
    return readJsonWithSchema<AuditEvent[]>(filePath(), [], auditLogFileSchema as unknown as z.ZodType<AuditEvent[]>);
}

function writeAll(events: AuditEvent[]): void {
    writeJson(filePath(), events);
}

// --- Optional SQLite backend (Settings → Audit & Privacy, experimental) ---
//
// Opt-in only; unset/"json" (the default) never touches any of this. See
// docs/RUST_MIGRATION_ASSESSMENT.md for why this exists and what it
// deliberately doesn't do yet: retention purging and the MAX_EVENTS soft
// cap below are JSON-backend-only in this first slice — the SQLite backend
// currently grows without a cap. That's a real, known gap (disk usage over
// a long-lived install), not an oversight; SQLite inserts don't have the
// JSON file's O(n²) growth problem regardless of table size, so it's a
// lower-urgency follow-up than the bug that motivated the JSON-side fix.

function sqliteDbPath(): string {
    return path.join(app.getPath("userData"), "audit-log.sqlite3");
}

function sqliteBackendActive(): boolean {
    // Requested AND actually usable — if a user opts in on a build without
    // the native addon, silently falling back to JSON (rather than raising
    // an error on every audit-relevant action) is the safer failure mode
    // for a store nothing else in the app can function without; the addon's
    // capability report (getSqliteStoreCapabilityReport()) is what makes
    // that mismatch discoverable rather than silent.
    return getSettings().auditLogBackend === "sqlite" && isNativeSqliteStoreAvailable();
}

// Migration only needs to happen once per process — after that, every new
// event is written directly to SQLite and the JSON file is frozen (not
// deleted; it stays as a rollback path). Re-running the migration is always
// safe (it only inserts ids not already present), so this flag is purely a
// performance guard against redoing it on every single call, not a
// correctness requirement.
let sqliteMigrated = false;

function ensureSqliteBackendReady(dbPath: string): void {
    openSqliteAuditStore(dbPath);
    if (sqliteMigrated) return;
    const existingJson = readAll();
    if (existingJson.length > 0) migrateAuditLogFromJson(dbPath, JSON.stringify(existingJson));
    sqliteMigrated = true;
}

function readAllFromSqlite(dbPath: string): AuditEvent[] {
    const parsed: unknown = JSON.parse(listAuditEventsJson(dbPath));
    const result = (auditLogFileSchema as unknown as z.ZodType<AuditEvent[]>).safeParse(parsed);
    return result.success ? result.data : [];
}

// The single choke point every reader (verifyChainIntegrity, listEvents,
// the JSON fast-path's own migration-seed read) goes through — dispatches
// to whichever backend is actually active so none of those callers need
// their own backend-selection logic.
function readAllActive(): AuditEvent[] {
    if (sqliteBackendActive()) {
        const dbPath = sqliteDbPath();
        ensureSqliteBackendReady(dbPath);
        return readAllFromSqlite(dbPath);
    }
    return readAll();
}

function recordEventSqlite(dbPath: string, actionCategory: AuditActionCategory, fields: RecordEventFields): AuditEvent {
    ensureSqliteBackendReady(dbPath);
    const previousEventHash = getLastAuditEventHash(dbPath);
    const withoutHash: Omit<AuditEvent, "eventHash"> = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        actionCategory,
        ...fields,
        previousEventHash,
    };
    const event: AuditEvent = { ...withoutHash, eventHash: computeEventHash(withoutHash) };
    // Reuses the migration function's insert-if-not-present logic for a
    // single new event, rather than a separate INSERT code path in Rust —
    // this event's id is always fresh (randomUUID()), so it always inserts.
    migrateAuditLogFromJson(dbPath, JSON.stringify([event]));
    return event;
}

// Age-based purge, on top of the fixed MAX_EVENTS count cap below — user-
// configurable (Settings → Audit & Privacy) since "how long is accountability
// useful" varies by org policy; 0/unset means no age-based purge at all,
// leaving MAX_EVENTS as the only bound.
function purgeExpired(events: AuditEvent[]): AuditEvent[] {
    const retentionDays = getSettings().auditLogRetentionDays;
    if (!retentionDays || retentionDays <= 0) return events;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    return events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
}

// Deterministic over exactly the fields that make up an event's meaning —
// explicit `?? null` normalization so two events differing only in "field
// omitted" vs. "field present but undefined" can never hash the same by
// accident. eventHash itself is never part of what's hashed (it's the
// output, not an input).
function computeEventHash(event: Omit<AuditEvent, "eventHash">): string {
    const canonical = JSON.stringify({
        id: event.id,
        timestamp: event.timestamp,
        actionCategory: event.actionCategory,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        detail: event.detail ?? null,
        mcpServerId: event.mcpServerId ?? null,
        mcpServerName: event.mcpServerName ?? null,
        mcpToolName: event.mcpToolName ?? null,
        approvalOutcome: event.approvalOutcome ?? null,
        durationMs: event.durationMs ?? null,
        previousEventHash: event.previousEventHash ?? null,
    });
    // Every recordEvent() call hashes not just the new event but re-derives
    // from a growing on-disk file, so this runs far more often than a
    // typical crypto call — see native-datastore.ts. Falls back to Node's
    // own SHA-256 (identical digest, just slower) when the Rust addon isn't
    // built, e.g. in dev/test/E2E environments.
    return sha256HexNative(canonical) ?? createHash("sha256").update(canonical).digest("hex");
}

type RecordEventFields = {
    targetType?: AuditEvent["targetType"];
    targetId?: string;
    detail?: string;
    mcpServerId?: string;
    mcpServerName?: string;
    mcpToolName?: string;
    approvalOutcome?: AuditEvent["approvalOutcome"];
    durationMs?: number;
};

// Full read-modify-write path: reads the whole file, applies age-based
// purge, appends, trims to MAX_EVENTS, and rewrites the whole file. This is
// the *only* correct way to enforce those two things (both require seeing
// every event), so it's kept as the fallback for exactly the calls that
// actually need it — see recordEvent() below for when that is.
function recordEventFull(actionCategory: AuditActionCategory, fields: RecordEventFields): AuditEvent {
    const all = purgeExpired(readAll());
    const previousEventHash = all.length > 0 ? (all[all.length - 1].eventHash ?? null) : null;
    const withoutHash: Omit<AuditEvent, "eventHash"> = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        actionCategory,
        ...fields,
        previousEventHash,
    };
    const event: AuditEvent = { ...withoutHash, eventHash: computeEventHash(withoutHash) };
    all.push(event);
    const trimmed = all.length > MAX_EVENTS ? all.slice(all.length - MAX_EVENTS) : all;
    writeAll(trimmed);
    return event;
}

// In-memory bookkeeping for the fast append path below — lets recordEvent()
// chain onto the previous event's hash and know the current count without
// re-reading and re-parsing the entire (potentially thousands-of-events)
// file on every single call, which is what made this store O(n) per write
// (O(n²) total for n sequential events) before this cache existed.
//
// Never trusted blindly: it's checked against the file's actual mtime/size
// before every use (see cacheMatchesDisk) and dropped whenever anything —
// this module's own slow path, a test writing the file directly, another
// process — might have changed the file without going through it. A stale
// or missing cache just costs one full re-read to reseed; it can never
// produce a wrong on-disk result, only a slower one. verifyChainIntegrity()
// and listEvents() never consult this cache at all — they always read the
// real file, so tamper detection is unaffected no matter what this cache
// thinks.
interface AuditCache {
    path: string;
    mtimeMs: number;
    size: number;
    count: number;
    lastHash: string | null;
}
let cache: AuditCache | null = null;

function statOrNull(p: string): { mtimeMs: number; size: number } | null {
    try {
        const s = fs.statSync(p);
        return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
        return null;
    }
}

function cacheMatchesDisk(p: string): boolean {
    if (!cache || cache.path !== p) return false;
    const stat = statOrNull(p);
    if (!stat) return cache.count === 0;
    return stat.mtimeMs === cache.mtimeMs && stat.size === cache.size;
}

function reseedCache(p: string): AuditCache {
    // Deliberately the *raw*, unpurged on-disk contents — this cache tracks
    // "what's actually in the file" for hash-chaining purposes, not "what a
    // reader would see after retention filtering" (that's a display/read-time
    // concern, handled separately in listEvents()).
    const all = readAll();
    const stat = statOrNull(p);
    const seeded: AuditCache = {
        path: p,
        mtimeMs: stat?.mtimeMs ?? 0,
        size: stat?.size ?? 0,
        count: all.length,
        lastHash: all.length > 0 ? (all[all.length - 1].eventHash ?? null) : null,
    };
    cache = seeded;
    return seeded;
}

export function recordEvent(actionCategory: AuditActionCategory, fields: RecordEventFields = {}): AuditEvent {
    if (sqliteBackendActive()) {
        return recordEventSqlite(sqliteDbPath(), actionCategory, fields);
    }

    // Age-based retention purges on every write by design (see
    // "purges expired events on write too" in the test suite) — that
    // requires reading every event's timestamp, so there's no fast path
    // available while it's enabled. Off by default, so this only slows down
    // installs that have explicitly opted into synchronous retention pruning.
    const retentionDays = getSettings().auditLogRetentionDays;
    // Without the addon there's no fast append to use the cache for — going
    // through it anyway would just add a second read on top of the full
    // path below (reseeding the cache, then reading again when the
    // native-less append predictably declines), making things slower than
    // this store's original pre-cache behavior instead of matching it.
    if ((retentionDays && retentionDays > 0) || !isNativeDatastoreAvailable()) {
        const event = recordEventFull(actionCategory, fields);
        cache = null;
        return event;
    }

    const p = filePath();
    const c = cacheMatchesDisk(p) ? cache! : reseedCache(p);

    // Only fall back once the soft ceiling (MAX_EVENTS + TRIM_BATCH) is
    // actually reached — recordEventFull's own trim then drops back down to
    // exactly MAX_EVENTS, so the next TRIM_BATCH calls resume the fast path
    // again. This is what keeps "at/over capacity" — the steady state any
    // long-lived install eventually reaches and stays in — from reverting to
    // an O(n)-per-write cost forever.
    if (c.count + 1 > MAX_EVENTS + TRIM_BATCH) {
        const event = recordEventFull(actionCategory, fields);
        cache = null;
        return event;
    }

    const withoutHash: Omit<AuditEvent, "eventHash"> = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        actionCategory,
        ...fields,
        previousEventHash: c.lastHash,
    };
    const event: AuditEvent = { ...withoutHash, eventHash: computeEventHash(withoutHash) };

    let appended = false;
    try {
        appended = appendJsonArrayElementNative(p, JSON.stringify(event)) === true;
    } catch {
        appended = false;
    }

    if (!appended) {
        // Native unavailable, or the file's tail didn't look like an
        // appendable array (fresh file, hand-edited, corrupted) — a normal
        // full write is always correct here, just not fast for this call.
        const all = readAll();
        all.push(event);
        writeAll(all);
        cache = null;
        return event;
    }

    const stat = statOrNull(p);
    cache = { path: p, mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0, count: c.count + 1, lastHash: event.eventHash ?? null };
    return event;
}

export interface ChainVerificationResult {
    valid: boolean;
    /** How many hash-chained (non-legacy) events were actually checked. */
    checkedCount: number;
    /** Index into the raw stored array (not the display-sorted order) where a break was found. */
    brokenAtIndex?: number;
    reason?: string;
}

/**
 * Recomputes the hash chain over exactly what's on disk right now and
 * reports whether it's internally consistent. This detects an out-of-band
 * edit (a text-editor change, a restored-from-elsewhere file, a deleted
 * event) to any event from the first hash-chained one onward.
 *
 * Honest limitation, not a bug: retention purging and the MAX_EVENTS cap
 * both remove old events, so this can only ever prove integrity of the
 * *currently retained window* — a chain that reached back to the very first
 * event this install ever recorded stops being provable once that event
 * ages out. The oldest retained event's own `previousEventHash` is trusted
 * as the chain's local anchor rather than treated as a break, since there's
 * nothing left to check it against.
 */
export function verifyChainIntegrity(): ChainVerificationResult {
    const events = readAllActive();
    const startIndex = events.findIndex((e) => e.eventHash !== undefined);
    if (startIndex === -1) return { valid: true, checkedCount: 0 };

    let expectedPrevious = events[startIndex].previousEventHash ?? null;
    for (let i = startIndex; i < events.length; i++) {
        const event = events[i];
        if (event.eventHash === undefined) {
            return {
                valid: false,
                checkedCount: i - startIndex,
                brokenAtIndex: i,
                reason: "A hash-chained event is followed by a legacy (pre-chain) event — the log was edited out of order.",
            };
        }
        if ((event.previousEventHash ?? null) !== expectedPrevious) {
            return {
                valid: false,
                checkedCount: i - startIndex,
                brokenAtIndex: i,
                reason: "previousEventHash does not match the prior event's recorded hash.",
            };
        }
        if (computeEventHash(event) !== event.eventHash) {
            return {
                valid: false,
                checkedCount: i - startIndex,
                brokenAtIndex: i,
                reason: "eventHash does not match the event's recomputed hash — its content was modified.",
            };
        }
        expectedPrevious = event.eventHash;
    }
    return { valid: true, checkedCount: events.length - startIndex };
}

export function listEvents(): AuditEvent[] {
    // Two events recorded within the same millisecond get identical ISO
    // timestamps, so sorting on timestamp alone leaves them in insertion
    // (oldest-first) order under a stable sort — the opposite of "newest
    // first". Breaking ties by original array index (which is insertion
    // order, since recordEvent always appends) fixes that.
    //
    // Purged here too (read-time), not just in recordEvent, so lowering the
    // retention setting takes effect immediately instead of waiting for the
    // next recorded event to trigger a rewrite.
    return purgeExpired(readAllActive())
        .map((event, index) => ({ event, index }))
        .sort((a, b) => b.event.timestamp.localeCompare(a.event.timestamp) || b.index - a.index)
        .map(({ event }) => event);
}

export function clearAll(): void {
    // Clears both backends unconditionally rather than only the active
    // one — "clear the audit log" is a user-facing action that should wipe
    // everything regardless of which backend happens to be selected right
    // now, so switching backends afterward doesn't resurrect old events.
    writeAll([]);
    cache = null;
    for (const suffix of ["", "-wal", "-shm"]) {
        try {
            fs.rmSync(`${sqliteDbPath()}${suffix}`, { force: true });
        } catch {
            // Best effort — files not existing (the common case, no sqlite
            // backend ever used) is already the desired end state.
        }
    }
    sqliteMigrated = false;
}
