import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";
import * as caseEncryption from "./case-encryption";
import type { EncryptedPayload } from "./case-encryption";
import { getOrCreateCacheKey, clearCacheKey } from "./shared-cache-key";
import { getSharedBackendConfig } from "./shared-backend-config-store";
import { SharedBackendUnavailableError, type PatientCase, type PatientCasesBackend } from "./patient-cases-store";
import { logger } from "./logger";

/**
 * Wraps a PatientCasesBackend (in practice, always the shared/institutional
 * HTTP one — shared-patient-cases-backend.ts) with an encrypted local cache
 * and a durable write outbox, per P1 backlog item 5 ("encrypted offline
 * cache and durable outbox") and docs/SHARED_BACKEND_DESIGN.md §3/§5.
 * Transparent to patient-cases-store.ts's business logic (createCase,
 * updateCase, mutateCase, ...) — they only ever call through the
 * PatientCasesBackend interface, never a concrete implementation, so
 * wrapping here is invisible to every caller above it. See main.ts's
 * registration site for where this gets applied.
 *
 * Every method reads the CURRENT organization from
 * shared-backend-config-store.ts on each call (never captured once at
 * construction time) — the same pattern shared-patient-cases-backend.ts's
 * own methods already use — so a mid-session organization switch is picked
 * up automatically without needing to re-register the backend.
 *
 * Deliberately excluded from this slice (see the P1 item 5 plan): detecting
 * "access revoked while still connected" (shared-backend-auth.ts doesn't
 * distinguish that from "offline" today — real auth-error-taxonomy work);
 * a full structured conflict-resolution UI; SQLite (nothing in this app
 * uses it for structured data, and case volume here doesn't need it — the
 * same encrypted-JSON-file pattern every other local store already uses is
 * the smaller, consistent choice).
 */

interface OutboxEntry {
    /** Generated once when queued; sent as the Idempotency-Key header on
     * every replay attempt (see flushOutbox) — this, not anything clever
     * client-side, is what makes replay safe in *effect*: server/src/routes/
     * idempotency.ts already replays an identical prior result for a
     * repeated key rather than double-applying or falsely conflicting. */
    idempotencyKey: string;
    kind: "create" | "update" | "delete";
    /** Present for create/update; absent for delete. */
    patientCase?: PatientCase;
    caseId: string;
    expectedVersion: string | null;
    queuedAt: string;
}

interface ConflictEntry extends OutboxEntry {
    /** The server's actual current copy at the moment the conflict was
     * detected — what the clinician needs to see to manually decide what to
     * keep. Never auto-merged; see docs/SHARED_BACKEND_DESIGN.md §5. */
    serverCurrent: PatientCase;
    detectedAt: string;
}

interface OfflineCacheFile {
    snapshot: PatientCase[];
    cursor: string | null;
    lastSyncedAt: string | null;
    /** Oldest first — flushOutbox always drains in this order. */
    outbox: OutboxEntry[];
    /** Entries that hit a real (not just "offline") conflict on flush.
     * Never auto-retried — they sit here until the clinician (or a future
     * conflict-resolution UI) discards or reapplies them. */
    conflicts: ConflictEntry[];
}

function emptyFile(): OfflineCacheFile {
    return { snapshot: [], cursor: null, lastSyncedAt: null, outbox: [], conflicts: [] };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One file per organization — mirrors patient-cases-store.ts's own
// physical-file-per-mode convention (patient-cases.json vs .enc.json).
// organizationId is expected to always be a server-issued UUID, but it
// flows in from shared-backend-config.json — a plain (not secrets-store,
// not integrity-checked) JSON file, and ultimately traces back to a GET /me
// response this client never independently re-validates the shape of
// before persisting. Treated as untrusted here regardless: this is the one
// place in the codebase that turns it into a filesystem path component, so
// this is where a `../../` value would become a real path-traversal write
// if unchecked. Refusing anything that isn't a well-formed UUID is cheap
// and closes that off entirely, rather than relying on every upstream
// caller happening to have validated it first.
function filePath(organizationId: string): string {
    if (!UUID_PATTERN.test(organizationId)) {
        throw new Error(`case-offline-cache: refusing a non-UUID organizationId as a filesystem path component: ${organizationId}`);
    }
    return path.join(app.getPath("userData"), `case-offline-cache-${organizationId}.enc.json`);
}

function readFile(organizationId: string): OfflineCacheFile {
    const payload = readJson<EncryptedPayload | null>(filePath(organizationId), null);
    if (!payload) return emptyFile();
    try {
        const key = getOrCreateCacheKey(organizationId);
        const parsed = JSON.parse(caseEncryption.decrypt(payload, key)) as OfflineCacheFile;
        return { ...emptyFile(), ...parsed };
    } catch (err) {
        // A key mismatch (secrets.json was reset, or the OS keychain entry
        // vanished) or corrupted ciphertext both land here. Treated the
        // same as "no cache yet" rather than thrown: unlike a locked
        // case-encryption.ts vault (where the passphrase gate means the
        // user can always still unlock it later), there is no unlock
        // action available for this key — an unreadable cache can never
        // become readable again, so starting fresh is the only real
        // option. A pending outbox entry lost this way is the same
        // "explicit sign-out quarantines the cache" trade-off already
        // accepted for this slice, just triggered by an unexpected key
        // loss instead of a deliberate disconnect.
        logger.error(`case-offline-cache: could not decrypt cache for org ${organizationId}, starting fresh: ${(err as Error).message}`);
        return emptyFile();
    }
}

/** Throws (never silently swallows) if the underlying write fails — a full
 * disk, a permissions problem, a corrupted userData directory. This is the
 * concrete mechanism behind this slice's chosen answer to "what happens
 * when the local vault can't be written": the save is blocked with a clear
 * error, never held only in memory. */
function writeFile(organizationId: string, file: OfflineCacheFile): void {
    const key = getOrCreateCacheKey(organizationId);
    const payload = caseEncryption.encrypt(JSON.stringify(file), key);
    writeJson(filePath(organizationId), payload);
}

function currentOrganizationId(): string | null {
    return getSharedBackendConfig()?.organizationId ?? null;
}

/** Upserts or removes one case in the local snapshot — the narrow shape
 * both an outbox entry and a plain successful-write result satisfy, so
 * callers never need to fabricate throwaway OutboxEntry fields (an
 * idempotencyKey, a queuedAt) just to update the cache. */
function applyToSnapshot(file: OfflineCacheFile, change: { kind: "upsert" | "delete"; caseId: string; patientCase?: PatientCase }): void {
    if (change.kind === "delete") {
        file.snapshot = file.snapshot.filter((c) => c.id !== change.caseId);
    } else if (change.patientCase) {
        const idx = file.snapshot.findIndex((c) => c.id === change.caseId);
        if (idx === -1) file.snapshot.push(change.patientCase);
        else file.snapshot[idx] = change.patientCase;
    }
}

/**
 * Drains as much of the outbox as it safely can against `real`, oldest
 * entry first. A real conflict on an entry moves it to `conflicts` and
 * skips every *later* queued entry for that same case (each was built on
 * an assumption about that case's version already known wrong — attempting
 * them risks silently succeeding against the wrong base) while continuing
 * to flush entries for other cases. Any other failure (still offline, a
 * transient 5xx) stops the whole flush immediately, preserving order for
 * next time — never skip ahead past a failed entry. Mutates and persists
 * `file` as it goes so a partial flush is never lost if the process exits
 * mid-drain.
 */
async function flushOutbox(real: PatientCasesBackend, organizationId: string, file: OfflineCacheFile): Promise<void> {
    // Nothing queued — skip entirely, including the final writeFile below.
    // Every writeOne/deleteOne calls this opportunistically before its own
    // work, so an unconditional write here would mean a disk write on
    // every single online call too, not just ones that actually drained
    // something.
    if (file.outbox.length === 0) return;

    const blockedCaseIds = new Set<string>();
    const remaining: OutboxEntry[] = [];

    for (const entry of file.outbox) {
        if (blockedCaseIds.has(entry.caseId)) {
            remaining.push(entry);
            continue;
        }
        try {
            const result =
                entry.kind === "delete"
                    ? await real.deleteOne!(entry.caseId, entry.expectedVersion, entry.idempotencyKey)
                    : await real.writeOne!(entry.patientCase!, entry.expectedVersion, entry.idempotencyKey);

            if ("conflict" in result) {
                file.conflicts.push({ ...entry, serverCurrent: result.current, detectedAt: new Date().toISOString() });
                blockedCaseIds.add(entry.caseId);
                continue;
            }
            if ("patientCase" in result) applyToSnapshot(file, { kind: "upsert", caseId: entry.caseId, patientCase: result.patientCase });
            // deleteOne's success variant ({deleted: true}) needs no
            // snapshot update beyond what the optimistic delete already did
            // when this entry was first queued.
        } catch (err) {
            if (err instanceof SharedBackendUnavailableError) {
                // Still offline (or offline again) — stop here, preserve
                // this and every later entry untouched for next time.
                remaining.push(entry, ...file.outbox.slice(file.outbox.indexOf(entry) + 1));
                file.outbox = remaining;
                writeFile(organizationId, file);
                return;
            }
            throw err;
        }
    }
    file.outbox = remaining;
    writeFile(organizationId, file);
}

/** Best-effort: called opportunistically before every write, never allowed
 * to turn "I wanted to save a new edit" into a failure just because
 * draining old queued ones hit a snag. flushOutbox already persists its own
 * partial progress and never throws SharedBackendUnavailableError itself
 * (it returns instead), so the only errors that reach here are genuine
 * storage failures — which the caller's own write attempt is about to hit
 * anyway and surface properly. */
async function tryFlush(real: PatientCasesBackend, organizationId: string, file: OfflineCacheFile): Promise<void> {
    try {
        await flushOutbox(real, organizationId, file);
    } catch (err) {
        logger.error(`case-offline-cache: opportunistic flush failed for org ${organizationId}: ${(err as Error).message}`);
    }
}

export interface SyncStatus {
    pendingCount: number;
    oldestQueuedAt: string | null;
    lastSyncedAt: string | null;
    // idempotencyKey is included specifically so the UI can pass it back to
    // discardConflict — it identifies which queued write this conflict
    // came from, not just which case it affects.
    conflicts: { caseId: string; idempotencyKey: string; detectedAt: string }[];
}

/** Read-only status for the UI (frontend/'s PatientCases.tsx banner) — pure
 * addition, not a change to PatientCasesBackend's own contract. */
export function getSyncStatus(organizationId: string): SyncStatus {
    const file = readFile(organizationId);
    return {
        pendingCount: file.outbox.length,
        oldestQueuedAt: file.outbox[0]?.queuedAt ?? null,
        lastSyncedAt: file.lastSyncedAt,
        conflicts: file.conflicts.map((c) => ({ caseId: c.caseId, idempotencyKey: c.idempotencyKey, detectedAt: c.detectedAt })),
    };
}

/** Discards a conflict entry once the clinician has manually reapplied (or
 * decided to abandon) the change it represents — the only way a conflict
 * ever leaves `conflicts`, since it is never auto-retried. */
export function discardConflict(organizationId: string, idempotencyKey: string): void {
    const file = readFile(organizationId);
    file.conflicts = file.conflicts.filter((c) => c.idempotencyKey !== idempotencyKey);
    writeFile(organizationId, file);
}

/** Deletes this organization's cache/outbox file and its encryption key —
 * called on explicit sign-out (shared-backend-auth.ts's disconnect()) so a
 * known departure quarantines whatever was cached. Any outbox entries not
 * yet flushed are lost — the accepted trade-off for this slice; see the P1
 * item 5 plan's "explicitly out of scope" section. */
export function clearOfflineCache(organizationId: string): void {
    try {
        fs.rmSync(filePath(organizationId), { force: true });
    } catch (err) {
        logger.error(`case-offline-cache: failed to remove cache file for org ${organizationId}: ${(err as Error).message}`);
    }
    clearCacheKey(organizationId);
}

export function wrapWithOfflineCache(real: PatientCasesBackend): PatientCasesBackend {
    if (!real.readSince || !real.writeOne || !real.deleteOne) {
        throw new Error("wrapWithOfflineCache requires a backend implementing readSince/writeOne/deleteOne.");
    }

    // Declared as `const wrapped = {...}` (not returned directly) so
    // `readAll` below can call `wrapped.readSince` — a self-reference that
    // works because none of these methods run during the object literal's
    // own construction, only later when a caller actually invokes one; by
    // then `wrapped` is fully assigned.
    const wrapped: PatientCasesBackend = {
        name: real.name,
        label: real.label,
        scope: real.scope,
        limitations: real.limitations,
        isAvailable: real.isAvailable,
        writeAll: real.writeAll,

        // A cache miss on a fresh install with no cursor yet should still
        // go through the same offline-fallback path as readSince, not
        // straight to `real` — hence calling the wrapped version of
        // itself, not real.readAll.
        readAll: async () => (await wrapped.readSince!(null)).cases,

        async readSince(cursor) {
            const organizationId = currentOrganizationId();
            if (!organizationId) return real.readSince!(cursor);
            const file = readFile(organizationId);

            try {
                const result = await real.readSince!(cursor);
                for (const id of result.deletedIds ?? []) file.snapshot = file.snapshot.filter((c) => c.id !== id);
                for (const patientCase of result.cases) {
                    const idx = file.snapshot.findIndex((c) => c.id === patientCase.id);
                    if (idx === -1) file.snapshot.push(patientCase);
                    else file.snapshot[idx] = patientCase;
                }
                file.cursor = result.cursor;
                file.lastSyncedAt = new Date().toISOString();
                writeFile(organizationId, file);
                return result;
            } catch (err) {
                if (!(err instanceof SharedBackendUnavailableError)) throw err;
                // Offline: serve the last-known-good snapshot rather than
                // propagating the failure — this is the whole point of the
                // cache. Staleness itself is surfaced via getSyncStatus's
                // lastSyncedAt, never hidden. The old cursor is returned
                // unchanged so a later successful readSince resumes from
                // where the cache actually left off, not from `cursor`
                // (which may be further ahead than what this cache holds).
                return { cases: file.snapshot, cursor: file.cursor ?? "", deletedIds: [] };
            }
        },

        async writeOne(patientCase, expectedVersion) {
            const organizationId = currentOrganizationId();
            if (!organizationId) return real.writeOne!(patientCase, expectedVersion);
            const file = readFile(organizationId);
            await tryFlush(real, organizationId, file);

            const idempotencyKey = randomUUID();
            try {
                const result = await real.writeOne!(patientCase, expectedVersion, idempotencyKey);
                if (!("conflict" in result)) {
                    applyToSnapshot(file, { kind: "upsert", caseId: patientCase.id, patientCase: result.patientCase });
                    writeFile(organizationId, file);
                }
                return result;
            } catch (err) {
                if (!(err instanceof SharedBackendUnavailableError)) throw err;
                const entry: OutboxEntry = {
                    idempotencyKey,
                    kind: expectedVersion === null ? "create" : "update",
                    patientCase,
                    caseId: patientCase.id,
                    expectedVersion,
                    queuedAt: new Date().toISOString(),
                };
                file.outbox.push(entry);
                applyToSnapshot(file, { kind: "upsert", caseId: patientCase.id, patientCase });
                // Not caught: a storage failure here must propagate and
                // block the save, per this slice's chosen answer — never
                // fall back to holding the edit only in memory.
                writeFile(organizationId, file);
                return { patientCase, version: expectedVersion ?? "" };
            }
        },

        async deleteOne(id, expectedVersion) {
            const organizationId = currentOrganizationId();
            if (!organizationId) return real.deleteOne!(id, expectedVersion);
            const file = readFile(organizationId);
            await tryFlush(real, organizationId, file);

            const idempotencyKey = randomUUID();
            try {
                const result = await real.deleteOne!(id, expectedVersion, idempotencyKey);
                if (!("conflict" in result)) {
                    file.snapshot = file.snapshot.filter((c) => c.id !== id);
                    writeFile(organizationId, file);
                }
                return result;
            } catch (err) {
                if (!(err instanceof SharedBackendUnavailableError)) throw err;
                const entry: OutboxEntry = { idempotencyKey, kind: "delete", caseId: id, expectedVersion, queuedAt: new Date().toISOString() };
                file.outbox.push(entry);
                applyToSnapshot(file, { kind: "delete", caseId: id });
                writeFile(organizationId, file);
                return { deleted: true };
            }
        },
    };

    return wrapped;
}
