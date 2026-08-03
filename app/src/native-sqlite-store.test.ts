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
    listAuditEventsJson,
    trimAuditEventsToCap,
    purgeAuditEventsOlderThan,
} from "./native-sqlite-store";

// Same addon-presence-varies-by-environment situation as
// native-datastore.test.ts — see that file's comment. audit-log-store.ts
// reaches this module only when a user has explicitly opted into the
// experimental SQLite backend (Settings → Audit & Privacy); these tests
// exercise the bridge directly, independent of that opt-in gate.
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

    (addonPresent ? it : it.skip)("trimAuditEventsToCap keeps only the newest rows", () => {
        const dbPath = tempDbPath();
        try {
            const events = Array.from({ length: 5 }, (_, i) => ({
                id: `e${i}`,
                timestamp: `2026-01-01T00:00:0${i}.000Z`,
                actionCategory: "case-viewed",
            }));
            migrateAuditLogFromJson(dbPath, JSON.stringify(events));

            const deleted = trimAuditEventsToCap(dbPath, 2);
            expect(deleted).toBe(3);
            expect(auditEventCount(dbPath)).toBe(2);

            const remaining = JSON.parse(listAuditEventsJson(dbPath)) as { id: string }[];
            expect(remaining.map((e) => e.id)).toEqual(["e3", "e4"]);
        } finally {
            fs.rmSync(dbPath, { force: true });
            fs.rmSync(`${dbPath}-wal`, { force: true });
            fs.rmSync(`${dbPath}-shm`, { force: true });
        }
    });

    (addonPresent ? it : it.skip)("purgeAuditEventsOlderThan removes only expired rows", () => {
        const dbPath = tempDbPath();
        try {
            const events = [
                { id: "old", timestamp: "2020-01-01T00:00:00.000Z", actionCategory: "case-viewed" },
                { id: "new", timestamp: "2030-01-01T00:00:00.000Z", actionCategory: "case-viewed" },
            ];
            migrateAuditLogFromJson(dbPath, JSON.stringify(events));

            const deleted = purgeAuditEventsOlderThan(dbPath, "2025-01-01T00:00:00.000Z");
            expect(deleted).toBe(1);
            expect(auditEventCount(dbPath)).toBe(1);

            const remaining = JSON.parse(listAuditEventsJson(dbPath)) as { id: string }[];
            expect(remaining.map((e) => e.id)).toEqual(["new"]);
        } finally {
            fs.rmSync(dbPath, { force: true });
            fs.rmSync(`${dbPath}-wal`, { force: true });
            fs.rmSync(`${dbPath}-shm`, { force: true });
        }
    });
});
