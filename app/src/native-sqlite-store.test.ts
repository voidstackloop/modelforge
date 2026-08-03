import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
    getSqliteStoreCapabilityReport,
    openAuditStore,
    migrateAuditLogFromJson,
    auditEventCount,
    verifyAuditStore,
} from "./native-sqlite-store";

// Same addon-presence-varies-by-environment situation as
// native-datastore.test.ts — see that file's comment. This module is inert
// (see its own header comment): nothing in the running app calls it, so
// these tests exist purely to prove the scaffold itself is correct ahead of
// any future cutover, not to protect a live code path.
const addonPresent = fs.existsSync(path.join(__dirname, "..", "native"));

function tempDbPath(): string {
    return path.join(os.tmpdir(), `native-sqlite-store-test-${randomUUID()}.sqlite3`);
}

describe(`native-sqlite-store (addon ${addonPresent ? "present" : "unavailable"})`, () => {
    it("getSqliteStoreCapabilityReport reflects whether the addon actually loaded", () => {
        const report = getSqliteStoreCapabilityReport();
        expect(report.available).toBe(addonPresent);
        if (!addonPresent) expect(report.reason).toBeTruthy();
    });

    (addonPresent ? it : it.skip)("opens a store, migrates JSON events, counts, and verifies — full round trip", () => {
        const dbPath = tempDbPath();
        try {
            openAuditStore(dbPath);
            expect(fs.existsSync(dbPath)).toBe(true);

            const events = [
                { id: "a", timestamp: "2026-01-01T00:00:00.000Z", actionCategory: "case-created" },
                { id: "b", timestamp: "2026-01-01T00:00:01.000Z", actionCategory: "case-updated", previousEventHash: null, eventHash: "h2" },
            ];
            const report = migrateAuditLogFromJson(dbPath, JSON.stringify(events));
            expect(report).toEqual({ migrated: 2, skippedExisting: 0, totalSourceEvents: 2 });
            expect(auditEventCount(dbPath)).toBe(2);

            // Rerunning the same migration must not duplicate rows.
            const second = migrateAuditLogFromJson(dbPath, JSON.stringify(events));
            expect(second).toEqual({ migrated: 0, skippedExisting: 2, totalSourceEvents: 2 });
            expect(auditEventCount(dbPath)).toBe(2);

            const integrity = verifyAuditStore(dbPath);
            expect(integrity).toEqual({ ok: true, eventCount: 2, detail: "ok" });
        } finally {
            fs.rmSync(dbPath, { force: true });
            fs.rmSync(`${dbPath}-wal`, { force: true });
            fs.rmSync(`${dbPath}-shm`, { force: true });
        }
    });

    (addonPresent ? it : it.skip)("rejects a source event missing an id without partially migrating the batch", () => {
        const dbPath = tempDbPath();
        try {
            openAuditStore(dbPath);
            const events = [{ timestamp: "2026-01-01T00:00:00.000Z", actionCategory: "case-created" }];
            expect(() => migrateAuditLogFromJson(dbPath, JSON.stringify(events))).toThrow();
            expect(auditEventCount(dbPath)).toBe(0);
        } finally {
            fs.rmSync(dbPath, { force: true });
            fs.rmSync(`${dbPath}-wal`, { force: true });
            fs.rmSync(`${dbPath}-shm`, { force: true });
        }
    });

    (!addonPresent ? it : it.skip)("throws (rather than silently proceeding) when the addon isn't available", () => {
        expect(() => openAuditStore(tempDbPath())).toThrow();
    });
});
