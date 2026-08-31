import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CaseResourceAttributes } from "@modelforge/contracts";
import { InMemoryAuditStore } from "./audit-store.js";
import { InMemoryCaseStore } from "./in-memory-case-store.js";
import { InMemoryCaseMigrationStore } from "./in-memory-case-migration-store.js";
import { patientCaseFixture } from "../test/patient-case-fixture.js";
import { schemaNameForTenant, type TenantContext } from "../tenant-context.js";

function context(organizationId = randomUUID()): TenantContext {
    return { organizationId, schemaName: schemaNameForTenant(organizationId), issuer: "https://issuer.test", subject: "subject" };
}
function resource(ctx: TenantContext, caseId: string, ownerUserId: string): CaseResourceAttributes {
    return { organizationId: ctx.organizationId, caseId, patientId: `patient-${caseId}`, ownerUserId, assignedUserIds: [], activeConsentScopes: [] };
}

describe("tenant case repository and migration", () => {
    it("allows overlapping ids in two tenants without either repository observing the other", async () => {
        const store = new InMemoryCaseStore(); const a = context(); const b = context(); const actorA = { externalSubject: "a", userId: randomUUID() }; const actorB = { externalSubject: "b", userId: randomUUID() };
        await store.forTenant(a).writeOne(patientCaseFixture("same-id", { title: "Tenant A" }), null, actorA, resource(a, "same-id", actorA.userId));
        await store.forTenant(b).writeOne(patientCaseFixture("same-id", { title: "Tenant B" }), null, actorB, resource(b, "same-id", actorB.userId));
        expect((await store.forTenant(a).getOne("same-id"))?.patientCase.title).toBe("Tenant A");
        expect((await store.forTenant(b).getOne("same-id"))?.patientCase.title).toBe("Tenant B");
    });

    it("emits an ordered tombstone after delete and advances the cursor", async () => {
        const store = new InMemoryCaseStore(); const ctx = context(); const actor = { externalSubject: "a", userId: randomUUID() }; const repo = store.forTenant(ctx);
        const created = await repo.writeOne(patientCaseFixture("case-1"), null, actor, resource(ctx, "case-1", actor.userId));
        if ("conflict" in created) throw new Error("unexpected conflict");
        const beforeDelete = (await repo.readChanges(null)).cursor;
        await repo.deleteOne("case-1", created.version, actor);
        const feed = await repo.readChanges(beforeDelete);
        expect(feed.cursor).toBe("2");
        expect(feed.changes.map((entry) => entry.change)).toEqual([
            expect.objectContaining({ sequence: "2", kind: "delete", caseId: "case-1" }),
        ]);
    });

    it("stages invisibly, validates, activates, and rolls back without touching the local source", async () => {
        const audit = new InMemoryAuditStore(); const store = new InMemoryCaseStore(audit); const migrations = new InMemoryCaseMigrationStore(audit); const ctx = context(); const actor = { externalSubject: "admin", userId: randomUUID() }; const cases = store.forTenant(ctx); const repo = migrations.forTenant(ctx, cases);
        const localSource = [patientCaseFixture("local-1")];
        const session = await repo.start({ sourceFingerprint: "fingerprint", totalItems: 1 }, actor);
        await repo.upload(session.id, [{ itemKey: "stable-item", patientCase: localSource[0] }], actor);
        expect(await cases.readAll()).toEqual([]);
        expect(await repo.validate(session.id, actor)).toMatchObject({ valid: 1, invalid: 0, collisions: 0 });
        expect((await repo.activate(session.id, actor)).status).toBe("active");
        expect((await cases.readAll()).map((item) => item.id)).toEqual(["local-1"]);
        expect(localSource[0].version).toBeUndefined();
        expect((await repo.rollback(session.id, actor)).status).toBe("rolled-back");
        expect(await cases.readAll()).toEqual([]);
    });

    it("reports malformed staged records and destination collisions before activation", async () => {
        const store = new InMemoryCaseStore(); const migrations = new InMemoryCaseMigrationStore(); const ctx = context(); const actor = { externalSubject: "admin", userId: randomUUID() }; const cases = store.forTenant(ctx);
        await cases.writeOne(patientCaseFixture("collision"), null, actor, resource(ctx, "collision", actor.userId));
        const repo = migrations.forTenant(ctx, cases); const session = await repo.start({ sourceFingerprint: "other", totalItems: 2 }, actor);
        await repo.upload(session.id, [{ itemKey: "bad", patientCase: { id: "bad" } }, { itemKey: "collision", patientCase: patientCaseFixture("collision") }], actor);
        const preview = await repo.validate(session.id, actor);
        expect(preview).toMatchObject({ total: 2, valid: 0, invalid: 1, collisions: 1 });
        await expect(repo.activate(session.id, actor)).rejects.toThrow(/complete and valid/i);
    });

    it("undoes every item from a failed activation attempt — nothing from this attempt is left live", async () => {
        const store = new InMemoryCaseStore(); const migrations = new InMemoryCaseMigrationStore(); const ctx = context(); const actor = { externalSubject: "admin", userId: randomUUID() }; const cases = store.forTenant(ctx);
        const repo = migrations.forTenant(ctx, cases);
        const session = await repo.start({ sourceFingerprint: "activation-race", totalItems: 2 }, actor);
        await repo.upload(session.id, [
            { itemKey: "first", patientCase: patientCaseFixture("case-a") },
            { itemKey: "second", patientCase: patientCaseFixture("case-b") },
        ], actor);
        expect(await repo.validate(session.id, actor)).toMatchObject({ valid: 2, invalid: 0, collisions: 0 });
        // A live case lands for "case-b" after validation but before
        // activation — the same race an ordinary, unrelated case-creation
        // request could trigger against a staged migration.
        await cases.writeOne(patientCaseFixture("case-b", { title: "Created independently" }), null, actor, resource(ctx, "case-b", actor.userId));
        await expect(repo.activate(session.id, actor)).rejects.toThrow(/collided/i);
        // "case-a" was written before the collision on "case-b" was
        // discovered — it must not be left stranded.
        expect(await cases.getOne("case-a")).toBeNull();
        expect((await cases.getOne("case-b"))?.patientCase.title).toBe("Created independently");
        expect((await repo.get(session.id))?.status).toBe("validated");
    });

    it("stops a rollback at a case someone else has since modified, and resumes cleanly once retried", async () => {
        const store = new InMemoryCaseStore(); const migrations = new InMemoryCaseMigrationStore(); const ctx = context(); const actor = { externalSubject: "admin", userId: randomUUID() }; const cases = store.forTenant(ctx);
        const repo = migrations.forTenant(ctx, cases);
        const session = await repo.start({ sourceFingerprint: "rollback-race", totalItems: 2 }, actor);
        await repo.upload(session.id, [
            { itemKey: "first", patientCase: patientCaseFixture("case-x") },
            { itemKey: "second", patientCase: patientCaseFixture("case-y") },
        ], actor);
        await repo.validate(session.id, actor);
        await repo.activate(session.id, actor);
        const activatedY = await cases.getOne("case-y");
        if (!activatedY) throw new Error("expected case-y to be live after activation");
        // Someone edits case-y independently of the migration, after activation.
        await cases.writeOne({ ...activatedY.patientCase, title: "Edited independently" }, activatedY.patientCase.version!, actor, activatedY.resource);

        await expect(repo.rollback(session.id, actor)).rejects.toThrow(/modified since activation/i);
        expect(await cases.getOne("case-x")).toBeNull();
        expect((await cases.getOne("case-y"))?.patientCase.title).toBe("Edited independently");
        expect((await repo.get(session.id))?.status).toBe("active");

        await expect(repo.rollback(session.id, actor)).rejects.toThrow(/modified since activation/i);

        const editedY = await cases.getOne("case-y");
        if (!editedY) throw new Error("expected case-y to still be live");
        const deleted = await cases.deleteOne("case-y", editedY.patientCase.version!, actor);
        if (!("deleted" in deleted)) throw new Error("expected the manual delete to succeed");

        expect((await repo.rollback(session.id, actor)).status).toBe("rolled-back");
    });
});
