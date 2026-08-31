import type { CaseChange, CaseResourceAttributes, PatientCase } from "@modelforge/contracts";
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "../tenant-context.js";
import { schemaNameForTenant } from "../tenant-context.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import { parseVersionCursor, type CaseStore, type StoredCaseChange, type TenantCaseRepository } from "./case-store.js";

interface CaseRow {
    case_id: string; version: string; data: PatientCase; patient_id: string; owner_user_id: string;
    workspace_id: string | null; department_id: string | null; assigned_user_ids: string[];
    active_consent_scopes: CaseResourceAttributes["activeConsentScopes"]; updated_at: Date;
}
interface ChangeRow { sequence: string; kind: "upsert" | "delete"; case_id: string; version: string; patient_case: PatientCase | null; resource: CaseResourceAttributes; changed_at: Date }

function assertSchemaName(schemaName: string): string {
    if (!/^tenant_[a-f0-9]{32}$/.test(schemaName)) throw new Error("Unsafe tenant schema identifier.");
    return `"${schemaName}"`;
}
function mapResource(row: CaseRow, organizationId: string): CaseResourceAttributes {
    return { organizationId, caseId: row.case_id, patientId: row.patient_id, ownerUserId: row.owner_user_id, workspaceId: row.workspace_id ?? undefined, departmentId: row.department_id ?? undefined, assignedUserIds: row.assigned_user_ids, activeConsentScopes: row.active_consent_scopes };
}
function mapCase(row: CaseRow): PatientCase { return { ...row.data, id: row.case_id, version: row.version, updatedAt: row.updated_at.toISOString() }; }
function mapChange(row: ChangeRow): StoredCaseChange {
    const change: CaseChange = row.kind === "upsert"
        ? { sequence: row.sequence, kind: "upsert", caseId: row.case_id, version: row.version, changedAt: row.changed_at.toISOString(), patientCase: row.patient_case! }
        : { sequence: row.sequence, kind: "delete", caseId: row.case_id, version: row.version, changedAt: row.changed_at.toISOString() };
    return { change, resource: row.resource };
}

export class PostgresCaseStore implements CaseStore {
    constructor(private readonly pool: Pool) {}

    forTenant(context: TenantContext): TenantCaseRepository {
        const schema = assertSchemaName(context.schemaName);
        const repository: TenantCaseRepository = {
            context,
            readAll: () => this.readAllBound(context, schema),
            getOne: (id) => this.getOneBound(context, schema, id),
            readChanges: (cursor) => this.readChangesBound(context, schema, cursor),
            writeOne: (patientCase, expectedVersion, actor, resource) => this.writeBound(context, schema, patientCase, expectedVersion, actor, resource),
            deleteOne: (id, expectedVersion, actor) => this.deleteBound(context, schema, id, expectedVersion, actor),
        };
        return Object.freeze(repository);
    }

    private async beginTenant(client: PoolClient, context: TenantContext, isolation = false): Promise<void> {
        await client.query(isolation ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [context.organizationId]);
    }

    private async readAllBound(context: TenantContext, schema: string): Promise<PatientCase[]> {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context);
            const result = await client.query<CaseRow>(`SELECT * FROM ${schema}.patient_cases WHERE active = TRUE ORDER BY updated_at DESC`);
            await client.query("COMMIT"); return result.rows.map(mapCase);
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    private async getOneBound(context: TenantContext, schema: string, id: string): Promise<{ patientCase: PatientCase; resource: CaseResourceAttributes } | null> {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context);
            const result = await client.query<CaseRow>(`SELECT * FROM ${schema}.patient_cases WHERE case_id=$1 AND active=TRUE`, [id]);
            await client.query("COMMIT"); const row = result.rows[0]; return row ? { patientCase: mapCase(row), resource: mapResource(row, context.organizationId) } : null;
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    private async highWater(client: PoolClient, schema: string): Promise<string> {
        const result = await client.query<{ value: string }>(`SELECT next_sequence - 1 AS value FROM ${schema}.case_change_counter WHERE singleton=TRUE`);
        return result.rows[0]?.value ?? "0";
    }

    private async readChangesBound(context: TenantContext, schema: string, cursor: string | null): Promise<{ changes: StoredCaseChange[]; cursor: string }> {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context, true);
            const highWater = await this.highWater(client, schema);
            const since = parseVersionCursor(cursor);
            let changes: StoredCaseChange[];
            if (since === null) {
                const rows = await client.query<CaseRow>(`SELECT * FROM ${schema}.patient_cases WHERE active=TRUE ORDER BY version`);
                changes = rows.rows.map((row) => {
                    const patientCase = mapCase(row);
                    return { resource: mapResource(row, context.organizationId), change: { sequence: row.version, kind: "upsert", caseId: row.case_id, version: row.version, changedAt: row.updated_at.toISOString(), patientCase } };
                });
            } else {
                const rows = await client.query<ChangeRow>(`SELECT * FROM ${schema}.case_changes WHERE sequence>$1 AND sequence<=$2 ORDER BY sequence`, [since.toString(), highWater]);
                changes = rows.rows.map(mapChange);
            }
            await client.query("COMMIT");
            return { changes, cursor: highWater };
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    private async nextSequence(client: PoolClient, schema: string): Promise<string> {
        const result = await client.query<{ assigned: string }>(`UPDATE ${schema}.case_change_counter SET next_sequence=next_sequence+1 WHERE singleton=TRUE RETURNING next_sequence-1 AS assigned`);
        return result.rows[0].assigned;
    }

    private async writeBound(context: TenantContext, schema: string, patientCase: PatientCase, expectedVersion: string | null, actor: AuditActor, resource: CaseResourceAttributes) {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context);
            const existingResult = await client.query<CaseRow>(`SELECT * FROM ${schema}.patient_cases WHERE case_id=$1 AND active=TRUE FOR UPDATE`, [patientCase.id]);
            const existing = existingResult.rows[0] ? mapCase(existingResult.rows[0]) : null;
            if ((existing?.version ?? null) !== expectedVersion) { await client.query("ROLLBACK"); return { conflict: true as const, current: existing! }; }
            const version = await this.nextSequence(client, schema);
            const now = new Date();
            const saved: PatientCase = { ...patientCase, version, updatedAt: now.toISOString() };
            const safeResource: CaseResourceAttributes = { ...resource, organizationId: context.organizationId, caseId: patientCase.id };
            await client.query(
                `INSERT INTO ${schema}.patient_cases (case_id,version,data,patient_id,owner_user_id,workspace_id,department_id,assigned_user_ids,active_consent_scopes,staged_migration_id,active,updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,TRUE,$10)
                 ON CONFLICT (case_id) DO UPDATE SET version=EXCLUDED.version,data=EXCLUDED.data,patient_id=EXCLUDED.patient_id,owner_user_id=EXCLUDED.owner_user_id,workspace_id=EXCLUDED.workspace_id,department_id=EXCLUDED.department_id,assigned_user_ids=EXCLUDED.assigned_user_ids,active_consent_scopes=EXCLUDED.active_consent_scopes,staged_migration_id=${schema}.patient_cases.staged_migration_id,active=TRUE,updated_at=EXCLUDED.updated_at`,
                [saved.id,version,JSON.stringify(saved),safeResource.patientId,safeResource.ownerUserId,safeResource.workspaceId ?? null,safeResource.departmentId ?? null,safeResource.assignedUserIds,safeResource.activeConsentScopes,now]
            );
            await client.query(`INSERT INTO ${schema}.case_changes (sequence,kind,case_id,version,patient_case,resource,changed_at) VALUES ($1,'upsert',$2,$1,$3,$4,$5)`, [version,saved.id,JSON.stringify(saved),JSON.stringify(safeResource),now]);
            await insertAuditEntry(client, { organizationId: context.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: expectedVersion === null ? "patientCase.create" : "patientCase.update", targetType: "patientCase", targetId: saved.id });
            await client.query("COMMIT"); return { patientCase: saved, version };
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    private async deleteBound(context: TenantContext, schema: string, id: string, expectedVersion: string | null, actor: AuditActor) {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context);
            const result = await client.query<CaseRow>(`SELECT * FROM ${schema}.patient_cases WHERE case_id=$1 AND active=TRUE FOR UPDATE`, [id]);
            const row = result.rows[0];
            if (!row) { await client.query("ROLLBACK"); return { notFound: true as const }; }
            const current = mapCase(row);
            if (current.version !== expectedVersion) { await client.query("ROLLBACK"); return { conflict: true as const, current }; }
            const version = await this.nextSequence(client, schema); const now = new Date(); const resource = mapResource(row, context.organizationId);
            await client.query(`DELETE FROM ${schema}.patient_cases WHERE case_id=$1`, [id]);
            await client.query(`INSERT INTO ${schema}.case_changes (sequence,kind,case_id,version,patient_case,resource,changed_at) VALUES ($1,'delete',$2,$1,NULL,$3,$4)`, [version,id,JSON.stringify(resource),now]);
            await insertAuditEntry(client, { organizationId: context.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "patientCase.delete", targetType: "patientCase", targetId: id });
            await client.query("COMMIT");
            const tombstone: CaseChange = { sequence: version, kind: "delete", caseId: id, version, changedAt: now.toISOString() };
            return { deleted: true as const, tombstone };
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    private legacyContext(organizationId: string): TenantContext { return Object.freeze({ organizationId, schemaName: schemaNameForTenant(organizationId), issuer: "legacy", subject: "legacy" }); }
    readAll(organizationId: string) { return this.forTenant(this.legacyContext(organizationId)).readAll(); }
    async readSince(organizationId: string, cursor: string | null) { const feed = await this.forTenant(this.legacyContext(organizationId)).readChanges(cursor); return { cases: feed.changes.flatMap((entry) => entry.change.kind === "upsert" ? [entry.change.patientCase] : []), cursor: feed.cursor }; }
    writeOne(organizationId: string, patientCase: PatientCase, expectedVersion: string | null, actor: AuditActor) { const resource: CaseResourceAttributes = { organizationId, caseId: patientCase.id, patientId: patientCase.patientId ?? patientCase.id, ownerUserId: actor.userId ?? "00000000-0000-0000-0000-000000000000", workspaceId: patientCase.workspaceId, departmentId: patientCase.departmentId, assignedUserIds: patientCase.assignedUserIds ?? [], activeConsentScopes: patientCase.consentRecords.filter((item) => !item.revokedAt).map((item) => item.scope) }; return this.forTenant(this.legacyContext(organizationId)).writeOne(patientCase, expectedVersion, actor, resource); }
    async deleteOne(organizationId: string, id: string, expectedVersion: string | null, actor: AuditActor) { const result = await this.forTenant(this.legacyContext(organizationId)).deleteOne(id, expectedVersion, actor); if ("deleted" in result) return { deleted: true as const }; return result; }
}
