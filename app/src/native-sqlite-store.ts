import * as path from "node:path";
import { classifyLoadError, type NativeCapabilityReport } from "./native-capability";

// Phase-1 SQLite-backed audit store bridge (see
// docs/RUST_MIGRATION_ASSESSMENT.md) — lib/src/store/audit.rs.
// audit-log-store.ts only reaches this when a user has explicitly opted in
// via Settings (`auditLogBackend: "sqlite"`); the JSON file remains the
// default, unaffected path otherwise.
//
// Unlike native-datastore.ts, there is no silent fallback here — a SQLite
// store with no SQLite backing has nothing meaningful to fall back to.
// audit-log-store.ts is responsible for deciding what "opted into sqlite but
// the addon isn't available" means (refuse to switch, keep using JSON, and
// surface that clearly) rather than this module inventing a JSON-shaped
// fallback of its own.

interface NativeAddon {
    openAuditStore(dbPath: string): void;
    migrateAuditLogFromJson(dbPath: string, jsonArray: string): MigrationReport;
    auditEventCount(dbPath: string): number;
    verifyAuditStore(dbPath: string): StoreIntegrityReport;
    getLastAuditEventHash(dbPath: string): string | null;
    listAuditEventsJson(dbPath: string): string;
}

export interface MigrationReport {
    migrated: number;
    skippedExisting: number;
    totalSourceEvents: number;
}

export interface StoreIntegrityReport {
    ok: boolean;
    eventCount: number;
    detail: string;
}

let nativeAddon: NativeAddon | undefined;
let loadFailed = false;
let capabilityReport: NativeCapabilityReport = { available: false };

function getNativeAddon(): NativeAddon {
    if (loadFailed) throw new Error("Native SQLite store addon is unavailable — see getSqliteStoreCapabilityReport() for why.");
    if (!nativeAddon) {
        try {
            nativeAddon = require(path.join(__dirname, "..", "native")) as NativeAddon;
            capabilityReport = { available: true };
        } catch (err) {
            loadFailed = true;
            capabilityReport = { available: false, reason: classifyLoadError(err), detail: err instanceof Error ? err.message : String(err) };
            throw err;
        }
    }
    return nativeAddon;
}

export function getSqliteStoreCapabilityReport(): NativeCapabilityReport {
    try {
        getNativeAddon();
    } catch {
        // capabilityReport was already set by getNativeAddon() before it threw.
    }
    return capabilityReport;
}

export function isNativeSqliteStoreAvailable(): boolean {
    return getSqliteStoreCapabilityReport().available;
}

/** Opens (creating on first use) the audit SQLite store and applies its
 * schema. Idempotent. Throws if the native addon isn't available — callers
 * of this scaffold are expected to check getSqliteStoreCapabilityReport()
 * or catch, not silently proceed as if a store exists when it doesn't. */
export function openAuditStore(dbPath: string): void {
    getNativeAddon().openAuditStore(dbPath);
}

/** Imports events from `jsonArray` (the literal contents of audit-log.json)
 * into the SQLite store, skipping ids already present. Safe to call
 * repeatedly — a rerun only inserts what's new. */
export function migrateAuditLogFromJson(dbPath: string, jsonArray: string): MigrationReport {
    return getNativeAddon().migrateAuditLogFromJson(dbPath, jsonArray);
}

export function auditEventCount(dbPath: string): number {
    return getNativeAddon().auditEventCount(dbPath);
}

export function verifyAuditStore(dbPath: string): StoreIntegrityReport {
    return getNativeAddon().verifyAuditStore(dbPath);
}

/** The most recently inserted event's `eventHash`, or `null` for an empty
 * store or one whose last event predates hash-chaining — what a new event
 * being recorded against this backend should chain its own
 * `previousEventHash` onto. */
export function getLastAuditEventHash(dbPath: string): string | null {
    return getNativeAddon().getLastAuditEventHash(dbPath);
}

/** Every event in the store as a JSON array string, in insertion order,
 * using the exact same field names/shape as audit-log.json — callers can
 * `JSON.parse` this and feed it straight through the same
 * parsing/sorting/purge/verification logic audit-log-store.ts already has
 * for the JSON backend. */
export function listAuditEventsJson(dbPath: string): string {
    return getNativeAddon().listAuditEventsJson(dbPath);
}
