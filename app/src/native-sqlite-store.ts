import * as path from "node:path";
import { classifyLoadError, type NativeCapabilityReport } from "./native-capability";

// Phase-1 scaffold (see docs/RUST_MIGRATION_ASSESSMENT.md) for a
// SQLite-backed audit store — lib/src/store/audit.rs. Deliberately INERT:
// nothing in the running app calls into this yet. audit-log-store.ts's live
// read/write path is unchanged and still the JSON file. This module exists
// so the Rust store, its migration path, and this bridge are all built and
// tested ahead of an explicitly flagged future cutover, rather than
// designing that cutover blind.
//
// Unlike native-datastore.ts, there is no fallback here — a SQLite store
// with no SQLite backing has nothing meaningful to fall back to. That's
// fine precisely because nothing calls this yet; a real cutover would need
// to decide what "the addon isn't available" means for a store that would
// by then be load-bearing (almost certainly: refuse to switch over, keep
// using JSON, and surface that clearly — not silently lose the fast path
// the way json-store.ts's fallback safely can).

interface NativeAddon {
    openAuditStore(dbPath: string): void;
    migrateAuditLogFromJson(dbPath: string, jsonArray: string): MigrationReport;
    auditEventCount(dbPath: string): number;
    verifyAuditStore(dbPath: string): StoreIntegrityReport;
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
