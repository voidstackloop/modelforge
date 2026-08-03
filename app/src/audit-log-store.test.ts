import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as auditLogStore from "./audit-log-store";
import * as settingsStore from "./settings-store";

function auditLogPath(): string {
    return path.join(app.getPath("userData"), "audit-log.json");
}

// Large-scale stress runs are only worth their cost when the native addon's
// O(1) fast-append path is actually what's being exercised — without it,
// every recordEvent() call is a full read-modify-write (see
// audit-log-store.ts), so a multi-thousand-event test would legitimately
// take minutes rather than seconds and slow down the standard CI/unit-test
// run for no additional coverage (the smaller "caps retained events" test
// above already proves the slow path itself works).
const nativeAddonPresent = fs.existsSync(path.join(__dirname, "..", "native"));

describe("audit-log-store", () => {
    beforeEach(() => auditLogStore.clearAll());

    it("records an event with actor-free, non-clinical fields only", () => {
        const event = auditLogStore.recordEvent("case-created", { targetType: "patient-case", targetId: "case-1" });
        expect(event.actionCategory).toBe("case-created");
        expect(event.targetId).toBe("case-1");
        expect(event.timestamp).toBeTruthy();
    });

    it("lists events newest first", () => {
        auditLogStore.recordEvent("case-created", { targetId: "a" });
        auditLogStore.recordEvent("case-updated", { targetId: "a" });
        const events = auditLogStore.listEvents();
        expect(events[0].actionCategory).toBe("case-updated");
        expect(events[1].actionCategory).toBe("case-created");
    });

    it(
        "caps retained events instead of growing without bound",
        () => {
            // The cap is soft (see MAX_EVENTS/TRIM_BATCH in audit-log-store.ts):
            // the file may transiently hold up to MAX_EVENTS + TRIM_BATCH
            // events between trims, so the loop must actually cross that
            // ceiling for this test to mean anything.
            const iterations = auditLogStore.MAX_EVENTS + auditLogStore.TRIM_BATCH + 10;
            for (let i = 0; i < iterations; i++) auditLogStore.recordEvent("case-viewed", { targetId: String(i) });
            expect(auditLogStore.listEvents().length).toBeLessThanOrEqual(auditLogStore.MAX_EVENTS + auditLogStore.TRIM_BATCH);
        },
        // With the Rust addon built, recordEvent() appends in O(1) both below
        // the cap and within the soft-cap slack (see native-datastore.ts /
        // lib/src/datastore.rs's append_json_array_element) — this runs in
        // well under a second. Without it (this test file's default
        // CI/unit-test environment), every call still does a full
        // read-modify-write of the whole file plus a SHA-256 hash, which is
        // inherently slower than the default 5s/20s test budget at this
        // scale (5000+ writes) even though the store itself is working
        // correctly. The generous timeout covers both cases rather than
        // being addon-presence-conditional.
        60_000
    );

    it("clearAll empties the log", () => {
        auditLogStore.recordEvent("model-call-local");
        auditLogStore.clearAll();
        expect(auditLogStore.listEvents()).toHaveLength(0);
    });

    it("records structured mcp-tool-call fields (server/tool/outcome/duration), never raw arguments", () => {
        const event = auditLogStore.recordEvent("mcp-tool-call", {
            targetType: "patient-case",
            targetId: "case-1",
            mcpServerId: "graphify",
            mcpServerName: "Graphify",
            mcpToolName: "query",
            approvalOutcome: "approved",
            durationMs: 42,
        });
        expect(event.mcpServerId).toBe("graphify");
        expect(event.mcpToolName).toBe("query");
        expect(event.approvalOutcome).toBe("approved");
        expect(event.durationMs).toBe(42);
        // No field on AuditEvent carries the call's actual arguments/result —
        // this is a structural guarantee, not just convention: anything
        // beyond the fields recordEvent's type accepts is dropped by TS at
        // the call site, and the schema (schemas.ts auditEventSchema) has no
        // such field either.
    });

    it("records a denied mcp-tool-call with no duration", () => {
        const event = auditLogStore.recordEvent("mcp-tool-call", {
            mcpServerId: "graphify",
            mcpToolName: "query",
            approvalOutcome: "denied",
        });
        expect(event.approvalOutcome).toBe("denied");
        expect(event.durationMs).toBeUndefined();
    });

    describe("configurable retention", () => {
        afterEach(() => settingsStore.saveSettings({ auditLogRetentionDays: undefined }));

        function seedOldAndNewEvents() {
            const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
            const recent = new Date().toISOString();
            fs.writeFileSync(
                auditLogPath(),
                JSON.stringify([
                    { id: "old-1", timestamp: old, actionCategory: "case-viewed" },
                    { id: "recent-1", timestamp: recent, actionCategory: "case-viewed" },
                ])
            );
        }

        it("does not purge anything when retention is unset", () => {
            seedOldAndNewEvents();
            expect(auditLogStore.listEvents().map((e) => e.id).sort()).toEqual(["old-1", "recent-1"]);
        });

        it("purges events older than the configured retention window on read", () => {
            settingsStore.saveSettings({ auditLogRetentionDays: 30 });
            seedOldAndNewEvents();
            const remaining = auditLogStore.listEvents();
            expect(remaining.map((e) => e.id)).toEqual(["recent-1"]);
        });

        it("purges expired events on write too, so the on-disk file actually shrinks", () => {
            settingsStore.saveSettings({ auditLogRetentionDays: 30 });
            seedOldAndNewEvents();
            auditLogStore.recordEvent("case-viewed", { targetId: "new-write" });
            const onDisk = JSON.parse(fs.readFileSync(auditLogPath(), "utf-8")) as { id: string; targetId?: string }[];
            expect(onDisk.map((e) => e.id)).not.toContain("old-1");
            expect(onDisk.some((e) => e.targetId === "new-write")).toBe(true);
        });
    });

    describe("hash chain integrity (tamper-evidence)", () => {
        it("chains each event's previousEventHash to the prior event's eventHash", () => {
            const first = auditLogStore.recordEvent("case-created", { targetId: "a" });
            const second = auditLogStore.recordEvent("case-updated", { targetId: "a" });
            expect(first.previousEventHash).toBeNull();
            expect(first.eventHash).toBeTruthy();
            expect(second.previousEventHash).toBe(first.eventHash);
        });

        it("verifies as valid for a freshly-recorded chain", () => {
            auditLogStore.recordEvent("case-created", { targetId: "a" });
            auditLogStore.recordEvent("case-updated", { targetId: "a" });
            auditLogStore.recordEvent("case-deleted", { targetId: "a" });
            const result = auditLogStore.verifyChainIntegrity();
            expect(result.valid).toBe(true);
            expect(result.checkedCount).toBe(3);
        });

        it("verifies as valid (trivially) on an empty log", () => {
            expect(auditLogStore.verifyChainIntegrity()).toEqual({ valid: true, checkedCount: 0 });
        });

        it("detects tampering with an event's content", () => {
            auditLogStore.recordEvent("case-created", { targetId: "a" });
            auditLogStore.recordEvent("case-updated", { targetId: "a" });
            const onDisk = JSON.parse(fs.readFileSync(auditLogPath(), "utf-8")) as { targetId?: string }[];
            onDisk[0].targetId = "tampered"; // change content without recomputing the hash
            fs.writeFileSync(auditLogPath(), JSON.stringify(onDisk));

            const result = auditLogStore.verifyChainIntegrity();
            expect(result.valid).toBe(false);
            expect(result.brokenAtIndex).toBe(0);
            expect(result.reason).toMatch(/recomputed hash/);
        });

        it("detects a forged eventHash that doesn't match recomputation", () => {
            auditLogStore.recordEvent("case-created", { targetId: "a" });
            const onDisk = JSON.parse(fs.readFileSync(auditLogPath(), "utf-8")) as { eventHash?: string }[];
            onDisk[0].eventHash = "0".repeat(64);
            fs.writeFileSync(auditLogPath(), JSON.stringify(onDisk));

            expect(auditLogStore.verifyChainIntegrity().valid).toBe(false);
        });

        it("detects a deleted middle event via the broken previousEventHash link", () => {
            auditLogStore.recordEvent("case-created", { targetId: "a" });
            auditLogStore.recordEvent("case-updated", { targetId: "a" });
            auditLogStore.recordEvent("case-deleted", { targetId: "a" });
            const onDisk = JSON.parse(fs.readFileSync(auditLogPath(), "utf-8")) as unknown[];
            onDisk.splice(1, 1); // remove the middle event
            fs.writeFileSync(auditLogPath(), JSON.stringify(onDisk));

            const result = auditLogStore.verifyChainIntegrity();
            expect(result.valid).toBe(false);
            expect(result.reason).toMatch(/previousEventHash/);
        });

        it("treats a legacy (pre-chain) log with no eventHash fields as valid but unverified", () => {
            fs.writeFileSync(
                auditLogPath(),
                JSON.stringify([
                    { id: "legacy-1", timestamp: new Date().toISOString(), actionCategory: "case-viewed" },
                    { id: "legacy-2", timestamp: new Date().toISOString(), actionCategory: "case-viewed" },
                ])
            );
            expect(auditLogStore.verifyChainIntegrity()).toEqual({ valid: true, checkedCount: 0 });
        });

        it("verifies only the hash-chained suffix when older legacy events precede it", () => {
            fs.writeFileSync(
                auditLogPath(),
                JSON.stringify([{ id: "legacy-1", timestamp: new Date().toISOString(), actionCategory: "case-viewed" }])
            );
            auditLogStore.recordEvent("case-created", { targetId: "a" });
            auditLogStore.recordEvent("case-updated", { targetId: "a" });

            const result = auditLogStore.verifyChainIntegrity();
            expect(result.valid).toBe(true);
            expect(result.checkedCount).toBe(2);
        });
    });

    describe("fast-append path: stress and self-healing", () => {
        it.skipIf(!nativeAddonPresent)(
            "stays correct across multiple trim cycles (2x the cap)",
            () => {
                const iterations = auditLogStore.MAX_EVENTS * 2 + 10;
                for (let i = 0; i < iterations; i++) auditLogStore.recordEvent("case-viewed", { targetId: String(i) });
                const events = auditLogStore.listEvents();
                expect(events.length).toBeLessThanOrEqual(auditLogStore.MAX_EVENTS + auditLogStore.TRIM_BATCH);

                // The retained window must still be a real, unbroken chain —
                // repeated over-cap trimming must never leave a gap or a
                // mismatched previousEventHash behind.
                const result = auditLogStore.verifyChainIntegrity();
                expect(result.valid).toBe(true);

                // Most recent event must be the one actually retained —
                // trimming always drops from the *front* (oldest); the tail
                // (newest) is untouched by any trim, regardless of exactly
                // when trims land relative to the soft-cap slack.
                expect(events[0].targetId).toBe(String(iterations - 1));
            },
            60_000
        );

        it("self-heals when the file is edited directly between two fast-path recordEvent calls", () => {
            const first = auditLogStore.recordEvent("case-created", { targetId: "a" });

            // Simulate something outside this module's own write path
            // touching the file — a text editor, a restored backup, another
            // process — between two calls that would otherwise both use the
            // fast append + in-memory cache.
            const onDisk = JSON.parse(fs.readFileSync(auditLogPath(), "utf-8")) as unknown[];
            onDisk.push({ id: "external-1", timestamp: new Date().toISOString(), actionCategory: "case-viewed" });
            fs.writeFileSync(auditLogPath(), JSON.stringify(onDisk));

            // If the cache were trusted blindly, this would chain onto
            // `first`'s hash (stale) instead of correctly reflecting that the
            // file's real last event (the externally-inserted, legacy-shaped
            // one) has no hash at all. The store must notice the file's size
            // changed and reseed before appending, rather than trusting a
            // now-stale in-memory value.
            const second = auditLogStore.recordEvent("case-updated", { targetId: "a" });

            expect(second.previousEventHash).not.toBe(first.eventHash);
            expect(second.previousEventHash).toBeNull(); // chains onto the legacy external-1 event, which has no eventHash

            // The resulting log is correctly reported as broken — not
            // because the store did anything wrong, but because an event was
            // genuinely spliced in from outside it, which is exactly the
            // anomaly tamper-evidence exists to catch. A self-healing cache
            // that instead reported this as "valid" would be the actual bug:
            // it would mean an out-of-band edit went undetected.
            const result = auditLogStore.verifyChainIntegrity();
            expect(result.valid).toBe(false);
            expect(result.brokenAtIndex).toBe(1); // external-1, the spliced-in legacy event
            expect(result.reason).toMatch(/followed by a legacy/);
        });

        it(
            "records events well within budget when the native addon is available (informational timing)",
            () => {
                const start = Date.now();
                for (let i = 0; i < 2000; i++) auditLogStore.recordEvent("case-viewed", { targetId: String(i) });
                const elapsedMs = Date.now() - start;
                // eslint-disable-next-line no-console
                console.log(`[benchmark] 2000 sequential recordEvent() calls took ${elapsedMs}ms`);
                // Deliberately generous — this asserts "not accidentally
                // still O(n²)" (which would take tens of seconds at this
                // scale) rather than pinning an exact number, so it stays
                // meaningful on a slow CI runner without the native addon
                // built (where this legitimately falls back to the O(n)-
                // per-call path and is expected to take several seconds).
                expect(elapsedMs).toBeLessThan(20_000);
            },
            30_000
        );
    });
});
