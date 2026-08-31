import type { CaseChange, CaseResourceAttributes, PatientCase } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import { schemaNameForTenant } from "../tenant-context.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";
import { parseVersionCursor, type CaseStore, type StoredCaseChange, type TenantCaseRepository } from "./case-store.js";

interface StoredCase { patientCase: PatientCase; resource: CaseResourceAttributes }

export class InMemoryCaseStore implements CaseStore {
    private readonly casesByOrg = new Map<string, Map<string, StoredCase>>();
    private readonly changesByOrg = new Map<string, StoredCaseChange[]>();
    private readonly sequenceByOrg = new Map<string, number>();
    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    private cases(org: string): Map<string, StoredCase> { let values = this.casesByOrg.get(org); if (!values) { values = new Map(); this.casesByOrg.set(org, values); } return values; }
    private changes(org: string): StoredCaseChange[] { let values = this.changesByOrg.get(org); if (!values) { values = []; this.changesByOrg.set(org, values); } return values; }
    private next(org: string): string { const value = (this.sequenceByOrg.get(org) ?? 0) + 1; this.sequenceByOrg.set(org, value); return String(value); }

    forTenant(context: TenantContext): TenantCaseRepository {
        const org = context.organizationId;
        const repository: TenantCaseRepository = {
            context,
            readAll: async () => [...this.cases(org).values()].map((entry) => entry.patientCase),
            getOne: async (id) => this.cases(org).get(id) ?? null,
            readChanges: async (cursor) => {
                const since = parseVersionCursor(cursor);
                const highWater = String(this.sequenceByOrg.get(org) ?? 0);
                if (since === null) {
                    return {
                        changes: [...this.cases(org).values()].map((entry) => ({
                            resource: entry.resource,
                            change: { sequence: entry.patientCase.version ?? "0", kind: "upsert" as const, caseId: entry.patientCase.id, version: entry.patientCase.version ?? "0", changedAt: entry.patientCase.updatedAt, patientCase: entry.patientCase },
                        })),
                        cursor: highWater,
                    };
                }
                return { changes: this.changes(org).filter((entry) => BigInt(entry.change.sequence) > since), cursor: highWater };
            },
            writeOne: (patientCase, expectedVersion, actor, resource) => this.writeBound(org, patientCase, expectedVersion, actor, resource),
            deleteOne: (id, expectedVersion, actor) => this.deleteBound(org, id, expectedVersion, actor),
        };
        return Object.freeze(repository);
    }

    private async writeBound(org: string, patientCase: PatientCase, expectedVersion: string | null, actor: AuditActor, resource: CaseResourceAttributes) {
        const existing = this.cases(org).get(patientCase.id);
        if ((existing?.patientCase.version ?? null) !== expectedVersion) return { conflict: true as const, current: existing!.patientCase };
        const version = this.next(org);
        const saved: PatientCase = { ...patientCase, version };
        const stored = { patientCase: saved, resource: { ...resource, organizationId: org, caseId: saved.id } };
        this.cases(org).set(saved.id, stored);
        const change: CaseChange = { sequence: version, kind: "upsert", caseId: saved.id, version, changedAt: new Date().toISOString(), patientCase: saved };
        this.changes(org).push({ change, resource: stored.resource });
        await this.auditStore.record({ organizationId: org, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: expectedVersion === null ? "patientCase.create" : "patientCase.update", targetType: "patientCase", targetId: saved.id });
        return { patientCase: saved, version };
    }

    private async deleteBound(org: string, id: string, expectedVersion: string | null, actor: AuditActor) {
        const existing = this.cases(org).get(id);
        if (!existing) return { notFound: true as const };
        if (existing.patientCase.version !== expectedVersion) return { conflict: true as const, current: existing.patientCase };
        const version = this.next(org);
        const tombstone: CaseChange = { sequence: version, kind: "delete", caseId: id, version, changedAt: new Date().toISOString() };
        this.cases(org).delete(id);
        this.changes(org).push({ change: tombstone, resource: existing.resource });
        await this.auditStore.record({ organizationId: org, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "patientCase.delete", targetType: "patientCase", targetId: id });
        return { deleted: true as const, tombstone };
    }

    private legacyContext(organizationId: string): TenantContext { return Object.freeze({ organizationId, schemaName: schemaNameForTenant(organizationId), issuer: "legacy", subject: "legacy" }); }
    readAll(organizationId: string): Promise<PatientCase[]> { return this.forTenant(this.legacyContext(organizationId)).readAll(); }
    async readSince(organizationId: string, cursor: string | null): Promise<{ cases: PatientCase[]; cursor: string }> { const feed = await this.forTenant(this.legacyContext(organizationId)).readChanges(cursor); return { cases: feed.changes.flatMap((entry) => entry.change.kind === "upsert" ? [entry.change.patientCase] : []), cursor: feed.cursor }; }
    writeOne(organizationId: string, patientCase: PatientCase, expectedVersion: string | null, actor: AuditActor) {
        const resource: CaseResourceAttributes = { organizationId, caseId: patientCase.id, patientId: patientCase.patientId ?? patientCase.id, ownerUserId: actor.userId ?? "00000000-0000-0000-0000-000000000000", workspaceId: patientCase.workspaceId, departmentId: patientCase.departmentId, assignedUserIds: patientCase.assignedUserIds ?? [], activeConsentScopes: patientCase.consentRecords.filter((item) => !item.revokedAt).map((item) => item.scope) };
        return this.forTenant(this.legacyContext(organizationId)).writeOne(patientCase, expectedVersion, actor, resource);
    }
    async deleteOne(organizationId: string, id: string, expectedVersion: string | null, actor: AuditActor) { const result = await this.forTenant(this.legacyContext(organizationId)).deleteOne(id, expectedVersion, actor); if ("deleted" in result) return { deleted: true as const }; return result; }
}
