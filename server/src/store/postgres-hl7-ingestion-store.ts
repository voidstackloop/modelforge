import { randomUUID } from "node:crypto";
import type { Hl7IngestionJob } from "@modelforge/contracts";
import type { Pool } from "pg";
import type { TenantContext } from "../tenant-context.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import type { Hl7IngestionStore, TenantHl7IngestionRepository } from "./hl7-ingestion-store.js";

type Row = Record<string, unknown>;
function schemaName(value: string): string {
    if (!/^tenant_[a-f0-9]{32}$/.test(value)) throw new Error("Unsafe tenant schema identifier.");
    return `"${value}"`;
}

function mapRow(r: Row): Hl7IngestionJob {
    return {
        id: r.id as string,
        messageType: r.message_type as string,
        messageControlId: r.message_control_id as string,
        rawMessage: r.raw_message as string,
        receivedAt: (r.received_at as Date).toISOString(),
        patientIdentifierValue: (r.patient_identifier_value as string | null) ?? undefined,
        patientIdentifierIssuer: (r.patient_identifier_issuer as string | null) ?? undefined,
        matchStatus: r.match_status as Hl7IngestionJob["matchStatus"],
        matchedCaseId: (r.matched_case_id as string | null) ?? undefined,
        candidateCaseIds: (r.candidate_case_ids as string[] | null) ?? undefined,
        status: r.status as Hl7IngestionJob["status"],
        observationsAdded: r.observations_added === null || r.observations_added === undefined ? undefined : Number(r.observations_added),
        reviewedByUserId: (r.reviewed_by_user_id as string | null) ?? undefined,
        reviewedAt: r.reviewed_at ? (r.reviewed_at as Date).toISOString() : undefined,
        rejectionReason: (r.rejection_reason as string | null) ?? undefined,
        createdAt: (r.created_at as Date).toISOString(),
        updatedAt: (r.updated_at as Date).toISOString(),
    };
}

/** Postgres-backed HL7 v2 ingestion job store — schema-per-tenant,
 * migration `024_hl7_ingestion.sql`. Not run against a real Postgres
 * instance in the environment this was built in — same disclosed
 * limitation as every other postgres-*.ts store in this package. */
export class PostgresHl7IngestionStore implements Hl7IngestionStore {
    constructor(private readonly pool: Pool) {}

    forTenant(context: TenantContext): TenantHl7IngestionRepository {
        const pool = this.pool;
        const organizationId = context.organizationId;
        const schema = schemaName(context.schemaName);

        return {
            context,

            async createJob(input, actor: AuditActor) {
                const id = randomUUID();
                const result = await pool.query(
                    `INSERT INTO ${schema}.hl7_ingestion_jobs
                        (id, message_type, message_control_id, raw_message, received_at, patient_identifier_value, patient_identifier_issuer, match_status, matched_case_id, candidate_case_ids, status, observations_added, reviewed_by_user_id, reviewed_at, rejection_reason, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), now()) RETURNING *`,
                    [
                        id, input.messageType, input.messageControlId, input.rawMessage, new Date(input.receivedAt),
                        input.patientIdentifierValue ?? null, input.patientIdentifierIssuer ?? null, input.matchStatus,
                        input.matchedCaseId ?? null, input.candidateCaseIds ?? null, input.status,
                        input.observationsAdded ?? null, input.reviewedByUserId ?? null,
                        input.reviewedAt ? new Date(input.reviewedAt) : null, input.rejectionReason ?? null,
                    ]
                );
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "hl7IngestionJob.create", targetType: "hl7IngestionJob", targetId: id, details: { messageType: input.messageType, matchStatus: input.matchStatus, status: input.status } });
                return mapRow(result.rows[0]);
            },

            async getJob(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.hl7_ingestion_jobs WHERE id = $1`, [id]);
                return r.rows[0] ? mapRow(r.rows[0]) : null;
            },

            async listJobs(filter) {
                const where = filter?.status !== undefined ? "WHERE status = $1" : "";
                const params = filter?.status !== undefined ? [filter.status] : [];
                const r = await pool.query(`SELECT * FROM ${schema}.hl7_ingestion_jobs ${where} ORDER BY created_at DESC`, params);
                return r.rows.map(mapRow);
            },

            async updateJob(id, partial, actor: AuditActor) {
                const columnFor: Record<string, string> = {
                    status: "status", matchedCaseId: "matched_case_id", observationsAdded: "observations_added",
                    reviewedByUserId: "reviewed_by_user_id", reviewedAt: "reviewed_at", rejectionReason: "rejection_reason",
                };
                const sets: string[] = [];
                const params: unknown[] = [];
                for (const [key, value] of Object.entries(partial)) {
                    const column = columnFor[key];
                    if (!column) continue;
                    params.push(key === "reviewedAt" && typeof value === "string" ? new Date(value) : value);
                    sets.push(`${column} = $${params.length}`);
                }
                if (sets.length === 0) {
                    const existing = await pool.query(`SELECT * FROM ${schema}.hl7_ingestion_jobs WHERE id = $1`, [id]);
                    return existing.rows[0] ? mapRow(existing.rows[0]) : null;
                }
                params.push(id);
                const result = await pool.query(`UPDATE ${schema}.hl7_ingestion_jobs SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
                if (!result.rows[0]) return null;
                const updated = mapRow(result.rows[0]);
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "hl7IngestionJob.update", targetType: "hl7IngestionJob", targetId: id, details: { status: updated.status, matchedCaseId: updated.matchedCaseId } });
                return updated;
            },
        };
    }
}
