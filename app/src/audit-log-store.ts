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
    closeAuditStore as closeSqliteAuditStore,
    migrateAuditLogFromJson,
    getLastAuditEventHash,
    listAuditEventsJson,
    trimAuditEventsToCap,
    purgeAuditEventsOlderThan,
    auditEventCount as sqliteAuditEventCount,
} from "./native-sqlite-store";
import type { z } from "zod";

export type AuditActionCategory = z.infer<typeof auditLogFileSchema>[number]["actionCategory"];

export interface AuditEvent {
    id: string;
    timestamp: string;
    actionCategory: AuditActionCategory;
    targetType?: "patient-case" | "session" | "export" | "settings" | "backup" | "model";
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
// docs/RUST_MIGRATION_ASSESSMENT.md. Retention purging and the MAX_EVENTS
// cap are enforced here too (via trimAuditEventsToCap/
// purgeAuditEventsOlderThan), reusing the same MAX_EVENTS/TRIM_BATCH
// constants as the JSON backend — but unlike JSON, both are single indexed
// SQLite DELETEs regardless of table size, so purging can run on every
// write (matching the JSON backend's exact purge-on-write semantics) without
// the O(n) cost that made the JSON backend's own cap soft in the first
// place. The trim is still batched (TRIM_BATCH slack) purely to avoid an
// extra DELETE on every single insert, not because a single trim is
// expensive here.

// Defaults to the fixed userData folder, same as every other store in this
// app — but Settings → Audit & Privacy lets a user point this at a directory
// of their own choosing instead (e.g. a synced drive, a separate disk), read
// live on every call so a change takes effect immediately without a
// restart, matching auditLogBackend's own live-read pattern above. Only the
// *directory* is configurable; the filename itself stays fixed so the
// `-wal`/`-shm` WAL sidecar files SQLite creates alongside the main database
// file are always found next to it.
function sqliteDbPath(): string {
    const dir = getSettings().auditLogSqliteDir;
    return path.join(dir && dir.trim().length > 0 ? dir : app.getPath("userData"), "audit-log.sqlite3");
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

function ensureSqliteBackendReady(dbPath: string): void {
    openSqliteAuditStore(dbPath);
}

function readAllFromSqlite(dbPath: string): AuditEvent[] {
    const parsed: unknown = JSON.parse(listAuditEventsJson(dbPath));
    const result = (auditLogFileSchema as unknown as z.ZodType<AuditEvent[]>).safeParse(parsed);
    return result.success ? result.data : [];
}

// Which backend — and, when it's SQLite, which *resolved path* — was
// actually in effect as of the last recordEvent()/readAllActive() call. Not
// just "json" | "sqlite": a custom SQLite directory (Settings → Audit &
// Privacy) can change while the backend stays "sqlite", and that's exactly
// as much a transition as switching backends entirely — the previously
// active path's events must not be silently stranded there. Encoded as a
// single string (`"json"` or `` `sqlite:${dbPath}` ``) so syncOnBackendTransition
// below can detect *any* change — backend or path — with one equality check.
// `null` means "not yet observed" (fresh process), which is deliberately
// *not* treated as a transition into "json" — that would trigger a pointless
// SQLite read on every app start for installs that have never touched the
// SQLite backend at all.
let lastActiveKey: string | null = null;

function activeStoreKey(): string {
    return sqliteBackendActive() ? `sqlite:${sqliteDbPath()}` : "json";
}

function mergeSqliteEventsIntoJson(dbPath: string): void {
    let sqliteEvents: AuditEvent[];
    try {
        ensureSqliteBackendReady(dbPath);
        sqliteEvents = readAllFromSqlite(dbPath);
    } catch {
        // No SQLite store on disk yet (never opted in) or unreadable —
        // nothing to merge, and readAll() below is already the correct
        // JSON-only result in that case.
        return;
    }
    if (sqliteEvents.length === 0) return;
    const existing = readAll();
    const existingIds = new Set(existing.map((e) => e.id));
    const missing = sqliteEvents.filter((e) => !existingIds.has(e.id));
    if (missing.length === 0) return;
    // SQLite's own insertion order is chain order (see get_last_audit_event_hash
    // in lib/src/store/audit.rs), and the two backends never both receive
    // writes concurrently — recordEvent() dispatches to exactly one backend
    // at a time — so appending in that order after whatever JSON already has
    // reconstructs the true combined chain order.
    writeAll([...existing, ...missing]);
    cache = null;
}

// Runs whenever the active store key (backend, and — for SQLite — resolved
// path) differs from what it was on the previous call, catching up whichever
// direction the change went:
//   -> sqlite (from json, or from a *different* sqlite path): migrate any
//     JSON-only events into the newly-active path, so its chain doesn't
//     silently miss events recorded before this switch.
//   sqlite -> (json, or a *different* sqlite path): first merge the
//     previously-active path's SQLite-only events back into the JSON file —
//     JSON is this store's one location every event is guaranteed to reach
//     eventually, so leaving a path (for any reason) always banks its
//     unique events there before moving on. This is also what keeps
//     switching back to JSON (Settings → Audit & Privacy claims this is
//     always safe) from making those events disappear from view.
// Bounded to run once per actual change rather than once per process
// (the old `sqliteMigrated` boolean's bug: a second switch back to SQLite
// later in the same session silently stopped migrating anything) or on
// every single call (which would reintroduce an O(n)-per-write cost).
//
// Deliberate scope limit: this only ever reconciles against JSON, never
// directly between two SQLite paths. Changing the custom SQLite directory
// while events exist only in the *old* path (never having been on JSON)
// banks them to JSON on the way out, same as any other departure — but nothing
// here copies files between two SQLite locations. A user switching to a
// brand new empty directory should not expect their previous custom
// location's file to have moved on its own.
function syncOnBackendTransition(): void {
    const key = activeStoreKey();
    if (key === lastActiveKey) return;
    if (lastActiveKey?.startsWith("sqlite:")) {
        mergeSqliteEventsIntoJson(lastActiveKey.slice("sqlite:".length));
    }
    if (key.startsWith("sqlite:")) {
        const dbPath = key.slice("sqlite:".length);
        ensureSqliteBackendReady(dbPath);
        const existingJson = readAll();
        if (existingJson.length > 0) migrateAuditLogFromJson(dbPath, JSON.stringify(existingJson));
    }
    lastActiveKey = key;
}

// The single choke point every reader (verifyChainIntegrity, listEvents,
// the JSON fast-path's own migration-seed read) goes through — dispatches
// to whichever backend is actually active so none of those callers need
// their own backend-selection logic.
function readAllActive(): AuditEvent[] {
    syncOnBackendTransition();
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

    const retentionDays = getSettings().auditLogRetentionDays;
    if (retentionDays && retentionDays > 0) {
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
        purgeAuditEventsOlderThan(dbPath, cutoff);
    }
    // Soft cap, same shape as the JSON backend's (MAX_EVENTS + TRIM_BATCH
    // slack) — only actually issues a DELETE once every TRIM_BATCH writes
    // past the cap, not on every single one.
    if (sqliteAuditEventCount(dbPath) > MAX_EVENTS + TRIM_BATCH) {
        trimAuditEventsToCap(dbPath, MAX_EVENTS);
    }

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
    syncOnBackendTransition();
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
    // Must happen before the files are deleted below — the native addon
    // caches an open connection per db_path (see
    // store::audit::cached_connection in lib/), and deleting the file out
    // from under a still-cached connection doesn't stop it from reading/
    // writing the now-unlinked inode: the "cleared" data would otherwise
    // silently survive, reachable through that stale connection, and a
    // later reopen of the same path would reuse it instead of seeing a
    // fresh, empty file.
    closeSqliteAuditStore(sqliteDbPath());
    for (const suffix of ["", "-wal", "-shm"]) {
        try {
            fs.rmSync(`${sqliteDbPath()}${suffix}`, { force: true });
        } catch {
            // Best effort — files not existing (the common case, no sqlite
            // backend ever used) is already the desired end state.
        }
    }
    // The SQLite file was just deleted above, so there is nothing left to
    // migrate/merge from on the next call regardless of which store is
    // active — reset rather than leave `lastActiveKey` pointing at a path
    // whose on-disk store no longer exists.
    lastActiveKey = null;
}
