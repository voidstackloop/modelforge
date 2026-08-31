import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
    DeidentificationJob,
    DerivedArtifact,
    DiagnosticReport,
    DocumentReference,
    ImagingAnnotation,
    ImagingChange,
    ImagingIngestionJob,
    ImagingShareGrant,
    ImagingStudy,
    ProvenanceRecord,
    ViewerSession,
} from "@modelforge/contracts";
import { schemaNameForTenant, type TenantContext } from "../tenant-context.js";
import { type AuditActor, insertAuditEntry } from "./audit-store.js";
import type {
    CreateDerivedArtifactInput,
    CreateStudyInput,
    ImagingSeriesRecord,
    ImagingStore,
    InternalDerivedArtifact,
    InternalImagingInstance,
    StoredImagingChange,
    StoredImagingStudy,
    TenantImagingRepository,
} from "./imaging-store.js";

/** Postgres-backed clinical imaging store — schema-per-tenant, migration
 * `017_clinical_imaging.sql`. Not run against a real Postgres instance in
 * the environment this was built in — same disclosed limitation as every
 * other postgres-*.ts store in this package; SQL syntax independently
 * verified against the real PostgreSQL grammar (libpg_query) before this
 * file was written, see docs/IMAGING.md. */
export class PostgresImagingStore implements ImagingStore {
    constructor(private readonly pool: Pool) {}

    forTenant(context: TenantContext): TenantImagingRepository {
        const pool = this.pool;
        const organizationId = context.organizationId;
        const schema = context.schemaName ?? schemaNameForTenant(organizationId);

        async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const result = await fn(client);
                await client.query("COMMIT");
                return result;
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        }

        function mapStudyRow(r: Record<string, unknown>): StoredImagingStudy {
            const study: ImagingStudy = {
                id: r.id as string,
                studyInstanceUid: r.study_instance_uid as string,
                patientIdentifier: { value: r.patient_identifier_value as string, issuer: r.patient_identifier_issuer as string },
                caseId: (r.case_id as string) ?? undefined,
                accessionNumber: (r.accession_number as string) ?? undefined,
                modalities: r.modalities as string[],
                description: (r.description as string) ?? undefined,
                bodyPart: (r.body_part as string) ?? undefined,
                studyDate: r.study_date ? (r.study_date as Date).toISOString().slice(0, 10) : undefined,
                studyTime: (r.study_time as string) ?? undefined,
                institutionName: (r.institution_name as string) ?? undefined,
                referringPhysician: (r.referring_physician as string) ?? undefined,
                numberOfSeries: r.number_of_series as number,
                numberOfInstances: r.number_of_instances as number,
                status: r.status as ImagingStudy["status"],
                sensitivity: r.sensitivity as ImagingStudy["sensitivity"],
                ingestionStatus: r.ingestion_status as ImagingStudy["ingestionStatus"],
                workspaceId: (r.workspace_id as string) ?? undefined,
                departmentId: (r.department_id as string) ?? undefined,
                assignedUserIds: (r.assigned_user_ids as string[]) ?? [],
                createdAt: (r.created_at as Date).toISOString(),
                updatedAt: (r.updated_at as Date).toISOString(),
                version: String(r.version),
            };
            return {
                study,
                resource: {
                    organizationId,
                    studyId: study.id,
                    patientIdentifier: study.patientIdentifier,
                    caseId: study.caseId,
                    ownerUserId: r.owner_user_id as string,
                    workspaceId: study.workspaceId,
                    departmentId: study.departmentId,
                    assignedUserIds: study.assignedUserIds ?? [],
                    sensitivity: study.sensitivity,
                },
            };
        }

        function mapInstanceRow(r: Record<string, unknown>): InternalImagingInstance {
            return {
                id: r.id as string, seriesId: r.series_id as string, sopInstanceUid: r.sop_instance_uid as string,
                sopClassUid: r.sop_class_uid as string, instanceNumber: (r.instance_number as string) ?? undefined,
                transferSyntaxUid: r.transfer_syntax_uid as string, rows: (r.rows as number) ?? undefined,
                columns: (r.columns as number) ?? undefined, numberOfFrames: (r.number_of_frames as number) ?? undefined,
                checksumSha256: r.checksum_sha256 as string, objectStorageKey: r.object_storage_key as string,
                sizeBytes: Number(r.size_bytes), hasThumbnail: r.has_thumbnail as boolean,
                createdAt: (r.created_at as Date).toISOString(),
            };
        }

        function mapReportRow(r: Record<string, unknown>): DiagnosticReport {
            return {
                id: r.id as string, studyId: r.study_id as string, status: r.status as DiagnosticReport["status"],
                conclusion: r.conclusion as string, conclusionCode: (r.conclusion_code as string) ?? undefined,
                authorUserId: r.author_user_id as string, authoredAt: (r.authored_at as Date).toISOString(),
                signedByUserId: (r.signed_by_user_id as string) ?? undefined, signedAt: r.signed_at ? (r.signed_at as Date).toISOString() : undefined,
                previousVersionId: (r.previous_version_id as string) ?? undefined, amendmentReason: (r.amendment_reason as string) ?? undefined,
                isCritical: r.is_critical as boolean,
                criticalAcknowledgedByUserId: (r.critical_acknowledged_by_user_id as string) ?? undefined,
                criticalAcknowledgedAt: r.critical_acknowledged_at ? (r.critical_acknowledged_at as Date).toISOString() : undefined,
                createdAt: (r.created_at as Date).toISOString(), updatedAt: (r.updated_at as Date).toISOString(),
            };
        }

        function mapShareGrantRow(r: Record<string, unknown>): ImagingShareGrant & { externalTokenHash?: string; externalVerificationCodeHash?: string } {
            return {
                id: r.id as string, mode: r.mode as ImagingShareGrant["mode"], scope: r.scope as ImagingShareGrant["scope"],
                studyId: r.study_id as string, seriesId: (r.series_id as string) ?? undefined, instanceId: (r.instance_id as string) ?? undefined,
                reportId: (r.report_id as string) ?? undefined, recipientUserId: (r.recipient_user_id as string) ?? undefined,
                recipientOrganizationId: (r.recipient_organization_id as string) ?? undefined, recipientEmail: (r.recipient_email as string) ?? undefined,
                recipientName: (r.recipient_name as string) ?? undefined, purposeOfUse: r.purpose_of_use as string,
                message: (r.message as string) ?? undefined, expiresAt: (r.expires_at as Date).toISOString(),
                allowDownload: r.allow_download as boolean, issuedByUserId: r.issued_by_user_id as string,
                consentBasis: r.consent_basis as string, status: r.status as ImagingShareGrant["status"],
                revokedByUserId: (r.revoked_by_user_id as string) ?? undefined, revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : undefined,
                createdAt: (r.created_at as Date).toISOString(),
                externalTokenHash: (r.external_token_hash as string) ?? undefined,
                externalVerificationCodeHash: (r.external_verification_code_hash as string) ?? undefined,
            };
        }
        const stripShareInternal = (g: ReturnType<typeof mapShareGrantRow>): ImagingShareGrant => {
            const { externalTokenHash: _t, externalVerificationCodeHash: _v, ...pub } = g;
            return pub;
        };

        function mapIngestionJobRow(r: Record<string, unknown>): ImagingIngestionJob {
            return {
                id: r.id as string, uploadId: r.upload_id as string, fileName: r.file_name as string,
                sizeBytes: Number(r.size_bytes), checksumSha256: (r.checksum_sha256 as string) ?? undefined,
                status: r.status as ImagingIngestionJob["status"], studyId: (r.study_id as string) ?? undefined,
                failureCategory: (r.failure_category as ImagingIngestionJob["failureCategory"]) ?? undefined,
                createdAt: (r.created_at as Date).toISOString(), updatedAt: (r.updated_at as Date).toISOString(),
            };
        }

        function mapViewerSessionRow(r: Record<string, unknown>): ViewerSession & { tokenHash: string } {
            return {
                id: r.id as string,
                scope: { studyId: r.study_id as string, seriesIds: (r.series_ids as string[]) ?? undefined, instanceIds: (r.instance_ids as string[]) ?? undefined },
                grantedActions: r.granted_actions as ViewerSession["grantedActions"], shareGrantId: (r.share_grant_id as string) ?? undefined,
                issuedAt: (r.issued_at as Date).toISOString(), expiresAt: (r.expires_at as Date).toISOString(), revoked: r.revoked as boolean,
                tokenHash: r.token_hash as string,
            };
        }

        function mapDeidJobRow(r: Record<string, unknown>): DeidentificationJob {
            return {
                id: r.id as string, sourceStudyId: r.source_study_id as string, profile: r.profile as DeidentificationJob["profile"],
                purpose: r.purpose as DeidentificationJob["purpose"], burnedInTextSuspected: r.burned_in_text_suspected as boolean,
                recognizableFeaturesFlagged: r.recognizable_features_flagged as boolean, reviewStatus: r.review_status as DeidentificationJob["reviewStatus"],
                reviewedByUserId: (r.reviewed_by_user_id as string) ?? undefined, reviewedAt: r.reviewed_at ? (r.reviewed_at as Date).toISOString() : undefined,
                resultArtifactId: (r.result_artifact_id as string) ?? undefined, requestedByUserId: r.requested_by_user_id as string,
                createdAt: (r.created_at as Date).toISOString(), updatedAt: (r.updated_at as Date).toISOString(),
            };
        }

        async function recordChange(client: PoolClient, kind: "upsert" | "delete", resourceType: "study" | "report" | "shareGrant", resourceId: string, studyId: string, resource: unknown): Promise<void> {
            const seqResult = await client.query<{ next_sequence: string }>(
                `UPDATE ${schema}.imaging_change_counter SET next_sequence = next_sequence + 1 WHERE singleton = TRUE RETURNING next_sequence - 1 AS next_sequence`
            );
            const sequence = seqResult.rows[0].next_sequence;
            await client.query(
                `INSERT INTO ${schema}.imaging_changes (sequence, kind, resource_type, resource_id, study_id, resource, changed_at) VALUES ($1,$2,$3,$4,$5,$6, now())`,
                [sequence, kind, resourceType, resourceId, studyId, JSON.stringify(resource)]
            );
        }

        return {
            context,

            async createStudy(input: CreateStudyInput, actor: AuditActor) {
                return tx(async (client) => {
                    const id = randomUUID();
                    const result = await client.query(
                        `INSERT INTO ${schema}.imaging_studies (
                            id, study_instance_uid, patient_identifier_value, patient_identifier_issuer, case_id, accession_number,
                            modalities, description, body_part, study_date, study_time, institution_name, referring_physician,
                            status, sensitivity, ingestion_status, owner_user_id, workspace_id, department_id, assigned_user_ids,
                            created_at, updated_at
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'registered',$14,'quarantined',$15,$16,$17,$18, now(), now())
                        RETURNING *`,
                        [
                            id, input.studyInstanceUid, input.patientIdentifier.value, input.patientIdentifier.issuer, input.caseId ?? null,
                            input.accessionNumber ?? null, input.modalities, input.description ?? null, input.bodyPart ?? null,
                            input.studyDate ?? null, input.studyTime ?? null, input.institutionName ?? null, input.referringPhysician ?? null,
                            input.sensitivity ?? "normal", input.ownerUserId, input.workspaceId ?? null, input.departmentId ?? null,
                            input.assignedUserIds ?? [],
                        ]
                    );
                    const stored = mapStudyRow(result.rows[0]);
                    await recordChange(client, "upsert", "study", id, id, stored.study);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingStudy.create", targetType: "imagingStudy", targetId: id, details: { studyInstanceUid: input.studyInstanceUid } });
                    return stored;
                });
            },

            async getStudy(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_studies WHERE id = $1`, [id]);
                return r.rows[0] ? mapStudyRow(r.rows[0]) : null;
            },

            async findStudyByUid(studyInstanceUid) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_studies WHERE study_instance_uid = $1`, [studyInstanceUid]);
                return r.rows[0] ? mapStudyRow(r.rows[0]) : null;
            },

            async findStudiesByPatientIdentifier(patientIdentifier) {
                const r = await pool.query(
                    `SELECT * FROM ${schema}.imaging_studies WHERE lower(patient_identifier_issuer) = lower($1) AND lower(patient_identifier_value) = lower($2)`,
                    [patientIdentifier.issuer, patientIdentifier.value]
                );
                return r.rows.map(mapStudyRow);
            },

            async listStudies(filter) {
                const conditions: string[] = [];
                const params: unknown[] = [];
                if (filter?.caseId !== undefined) { params.push(filter.caseId); conditions.push(`case_id = $${params.length}`); }
                if (filter?.ingestionStatus !== undefined) { params.push(filter.ingestionStatus); conditions.push(`ingestion_status = $${params.length}`); }
                const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_studies ${where} ORDER BY created_at DESC`, params);
                return r.rows.map(mapStudyRow);
            },

            async updateStudy(id, partial, actor) {
                return tx(async (client) => {
                    const sets: string[] = [];
                    const params: unknown[] = [];
                    for (const [key, value] of Object.entries(partial)) {
                        const column = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
                        params.push(value);
                        sets.push(`${column} = $${params.length}`);
                    }
                    if (sets.length === 0) {
                        const existing = await client.query(`SELECT * FROM ${schema}.imaging_studies WHERE id = $1`, [id]);
                        return existing.rows[0] ? mapStudyRow(existing.rows[0]) : null;
                    }
                    params.push(id);
                    const result = await client.query(
                        `UPDATE ${schema}.imaging_studies SET ${sets.join(", ")}, version = version + 1, updated_at = now() WHERE id = $${params.length} RETURNING *`,
                        params
                    );
                    if (!result.rows[0]) return null;
                    const stored = mapStudyRow(result.rows[0]);
                    await recordChange(client, "upsert", "study", id, id, stored.study);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingStudy.update", targetType: "imagingStudy", targetId: id, details: { fields: Object.keys(partial) } });
                    return stored;
                });
            },

            async createSeries(studyId, input, actor) {
                return tx(async (client) => {
                    const id = randomUUID();
                    const result = await client.query(
                        `INSERT INTO ${schema}.imaging_series (id, study_id, series_instance_uid, series_number, modality, body_part_examined, description, created_at, updated_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now()) RETURNING *`,
                        [id, studyId, input.seriesInstanceUid, input.seriesNumber ?? null, input.modality, input.bodyPartExamined ?? null, input.description ?? null]
                    );
                    await client.query(`UPDATE ${schema}.imaging_studies SET number_of_series = number_of_series + 1, updated_at = now() WHERE id = $1`, [studyId]);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingSeries.create", targetType: "imagingSeries", targetId: id, details: {} });
                    const row = result.rows[0];
                    return { id, studyId, seriesInstanceUid: row.series_instance_uid, seriesNumber: row.series_number ?? undefined, modality: row.modality, bodyPartExamined: row.body_part_examined ?? undefined, description: row.description ?? undefined, numberOfInstances: 0, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() } as ImagingSeriesRecord;
                });
            },

            async listSeriesForStudy(studyId) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_series WHERE study_id = $1`, [studyId]);
                return r.rows.map((row) => ({
                    id: row.id, studyId: row.study_id, seriesInstanceUid: row.series_instance_uid, seriesNumber: row.series_number ?? undefined,
                    modality: row.modality, bodyPartExamined: row.body_part_examined ?? undefined, description: row.description ?? undefined,
                    numberOfInstances: row.number_of_instances, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
                }));
            },

            async getSeries(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_series WHERE id = $1`, [id]);
                const row = r.rows[0];
                if (!row) return null;
                return { id: row.id, studyId: row.study_id, seriesInstanceUid: row.series_instance_uid, seriesNumber: row.series_number ?? undefined, modality: row.modality, bodyPartExamined: row.body_part_examined ?? undefined, description: row.description ?? undefined, numberOfInstances: row.number_of_instances, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
            },

            async createInstance(seriesId, input, actor) {
                return tx(async (client) => {
                    const id = randomUUID();
                    const result = await client.query(
                        `INSERT INTO ${schema}.imaging_instances (id, series_id, sop_instance_uid, sop_class_uid, instance_number, transfer_syntax_uid, rows, columns, number_of_frames, checksum_sha256, object_storage_key, size_bytes, has_thumbnail, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now()) RETURNING *`,
                        [id, seriesId, input.sopInstanceUid, input.sopClassUid, input.instanceNumber ?? null, input.transferSyntaxUid, input.rows ?? null, input.columns ?? null, input.numberOfFrames ?? null, input.checksumSha256, input.objectStorageKey, input.sizeBytes, input.hasThumbnail]
                    );
                    const seriesRow = await client.query(`UPDATE ${schema}.imaging_series SET number_of_instances = number_of_instances + 1, updated_at = now() WHERE id = $1 RETURNING study_id`, [seriesId]);
                    const studyId = seriesRow.rows[0]?.study_id as string | undefined;
                    if (studyId) await client.query(`UPDATE ${schema}.imaging_studies SET number_of_instances = number_of_instances + 1, updated_at = now() WHERE id = $1`, [studyId]);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingInstance.create", targetType: "imagingInstance", targetId: id, details: {} });
                    return mapInstanceRow(result.rows[0]);
                });
            },

            async listInstancesForSeries(seriesId) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_instances WHERE series_id = $1`, [seriesId]);
                return r.rows.map(mapInstanceRow);
            },

            async getInstance(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_instances WHERE id = $1`, [id]);
                return r.rows[0] ? mapInstanceRow(r.rows[0]) : null;
            },

            async findInstanceByUid(sopInstanceUid) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_instances WHERE sop_instance_uid = $1`, [sopInstanceUid]);
                return r.rows[0] ? mapInstanceRow(r.rows[0]) : null;
            },

            async markInstanceThumbnailed(id) {
                await pool.query(`UPDATE ${schema}.imaging_instances SET has_thumbnail = TRUE WHERE id = $1`, [id]);
            },

            async createReport(input, actor) {
                return tx(async (client) => {
                    const id = randomUUID();
                    const result = await client.query(
                        `INSERT INTO ${schema}.diagnostic_reports (id, study_id, status, conclusion, conclusion_code, author_user_id, authored_at, signed_by_user_id, signed_at, previous_version_id, amendment_reason, is_critical, critical_acknowledged_by_user_id, critical_acknowledged_at, created_at, updated_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now()) RETURNING *`,
                        [id, input.studyId, input.status, input.conclusion, input.conclusionCode ?? null, input.authorUserId, input.authoredAt, input.signedByUserId ?? null, input.signedAt ?? null, input.previousVersionId ?? null, input.amendmentReason ?? null, input.isCritical, input.criticalAcknowledgedByUserId ?? null, input.criticalAcknowledgedAt ?? null]
                    );
                    const report = mapReportRow(result.rows[0]);
                    await recordChange(client, "upsert", "report", id, input.studyId, report);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: input.previousVersionId ? "diagnosticReport.amend" : "diagnosticReport.create", targetType: "diagnosticReport", targetId: id, details: { studyId: input.studyId, status: input.status } });
                    return report;
                });
            },

            async getReport(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.diagnostic_reports WHERE id = $1`, [id]);
                return r.rows[0] ? mapReportRow(r.rows[0]) : null;
            },

            async getCurrentReport(studyId) {
                const r = await pool.query(
                    `SELECT r.* FROM ${schema}.diagnostic_reports r
                     WHERE r.study_id = $1 AND r.status NOT IN ('cancelled','entered-in-error')
                       AND NOT EXISTS (SELECT 1 FROM ${schema}.diagnostic_reports s WHERE s.previous_version_id = r.id)
                     ORDER BY r.created_at DESC LIMIT 1`,
                    [studyId]
                );
                return r.rows[0] ? mapReportRow(r.rows[0]) : null;
            },

            async listReportHistory(studyId) {
                const r = await pool.query(`SELECT * FROM ${schema}.diagnostic_reports WHERE study_id = $1 ORDER BY created_at DESC`, [studyId]);
                return r.rows.map(mapReportRow);
            },

            async signReport(id, signedByUserId, actor) {
                return tx(async (client) => {
                    const result = await client.query(`UPDATE ${schema}.diagnostic_reports SET signed_by_user_id = $2, signed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [id, signedByUserId]);
                    if (!result.rows[0]) return null;
                    const report = mapReportRow(result.rows[0]);
                    await recordChange(client, "upsert", "report", id, report.studyId, report);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "diagnosticReport.sign", targetType: "diagnosticReport", targetId: id, details: {} });
                    return report;
                });
            },

            async acknowledgeCriticalReport(id, acknowledgedByUserId, actor) {
                return tx(async (client) => {
                    const result = await client.query(`UPDATE ${schema}.diagnostic_reports SET critical_acknowledged_by_user_id = $2, critical_acknowledged_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [id, acknowledgedByUserId]);
                    if (!result.rows[0]) return null;
                    const report = mapReportRow(result.rows[0]);
                    await recordChange(client, "upsert", "report", id, report.studyId, report);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "diagnosticReport.acknowledgeCritical", targetType: "diagnosticReport", targetId: id, details: {} });
                    return report;
                });
            },

            async createAnnotation(input, actor) {
                return tx(async (client) => {
                    const id = randomUUID();
                    const result = await client.query(
                        `INSERT INTO ${schema}.imaging_annotations (id, study_id, series_id, instance_id, frame_number, kind, data, annotation_text, author_user_id, provenance, created_at, updated_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now()) RETURNING *`,
                        [id, input.studyId, input.seriesId ?? null, input.instanceId ?? null, input.frameNumber ?? null, input.kind, JSON.stringify(input.data), input.text ?? null, input.authorUserId, input.provenance]
                    );
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingAnnotation.create", targetType: "imagingAnnotation", targetId: id, details: { studyId: input.studyId, kind: input.kind } });
                    const row = result.rows[0];
                    return {
                        id, studyId: input.studyId, seriesId: input.seriesId, instanceId: input.instanceId, frameNumber: input.frameNumber,
                        kind: input.kind, data: input.data, text: input.text, authorUserId: input.authorUserId, provenance: input.provenance,
                        createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), version: "1",
                    } as ImagingAnnotation;
                });
            },

            async listAnnotationsForStudy(studyId) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_annotations WHERE study_id = $1`, [studyId]);
                return r.rows.map((row) => ({
                    id: row.id, studyId: row.study_id, seriesId: row.series_id ?? undefined, instanceId: row.instance_id ?? undefined,
                    frameNumber: row.frame_number ?? undefined, kind: row.kind, data: row.data, text: row.annotation_text ?? undefined,
                    authorUserId: row.author_user_id, provenance: row.provenance, createdAt: row.created_at.toISOString(),
                    updatedAt: row.updated_at.toISOString(), version: String(row.version),
                }));
            },

            async recordProvenance(input) {
                const id = randomUUID();
                await pool.query(
                    `INSERT INTO ${schema}.provenance_records (id, target_type, target_id, action, performed_by, performed_at, source_refs, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [id, input.targetType, input.targetId, input.action, input.performedBy, input.performedAt, input.sourceRefs, input.details ? JSON.stringify(input.details) : null]
                );
                return { id, ...input };
            },

            async listProvenanceForTarget(targetType, targetId) {
                const r = await pool.query(`SELECT * FROM ${schema}.provenance_records WHERE target_type = $1 AND target_id = $2 ORDER BY performed_at DESC`, [targetType, targetId]);
                return r.rows.map((row) => ({ id: row.id, targetType: row.target_type, targetId: row.target_id, action: row.action, performedBy: row.performed_by, performedAt: row.performed_at.toISOString(), sourceRefs: row.source_refs ?? [], details: row.details ?? undefined }));
            },

            async createDerivedArtifact(input: CreateDerivedArtifactInput) {
                return tx(async (client) => {
                    const provenanceId = randomUUID();
                    await client.query(
                        `INSERT INTO ${schema}.provenance_records (id, target_type, target_id, action, performed_by, performed_at, source_refs, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                        [provenanceId, input.provenance.targetType, input.provenance.targetId, input.provenance.action, input.provenance.performedBy, input.provenance.performedAt, input.provenance.sourceRefs, input.provenance.details ? JSON.stringify(input.provenance.details) : null]
                    );
                    const id = randomUUID();
                    const result = await client.query(
                        `INSERT INTO ${schema}.derived_artifacts (id, kind, source_instance_id, source_study_id, object_storage_key, checksum_sha256, size_bytes, provenance_id, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING *`,
                        [id, input.kind, input.sourceInstanceId ?? null, input.sourceStudyId ?? null, input.objectStorageKey, input.checksumSha256, input.sizeBytes, provenanceId]
                    );
                    const row = result.rows[0];
                    return { id, kind: row.kind, sourceInstanceId: row.source_instance_id ?? undefined, sourceStudyId: row.source_study_id ?? undefined, checksumSha256: row.checksum_sha256, sizeBytes: Number(row.size_bytes), provenanceId, objectStorageKey: row.object_storage_key, createdAt: row.created_at.toISOString() } as InternalDerivedArtifact;
                });
            },

            async getDerivedArtifact(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.derived_artifacts WHERE id = $1`, [id]);
                const row = r.rows[0];
                if (!row) return null;
                return { id: row.id, kind: row.kind, sourceInstanceId: row.source_instance_id ?? undefined, sourceStudyId: row.source_study_id ?? undefined, checksumSha256: row.checksum_sha256, sizeBytes: Number(row.size_bytes), provenanceId: row.provenance_id, objectStorageKey: row.object_storage_key, createdAt: row.created_at.toISOString() };
            },

            async listDerivedArtifactsForSource(kind, sourceInstanceId, sourceStudyId) {
                const conditions = ["kind = $1"];
                const params: unknown[] = [kind];
                if (sourceInstanceId !== undefined) { params.push(sourceInstanceId); conditions.push(`source_instance_id = $${params.length}`); }
                if (sourceStudyId !== undefined) { params.push(sourceStudyId); conditions.push(`source_study_id = $${params.length}`); }
                const r = await pool.query(`SELECT * FROM ${schema}.derived_artifacts WHERE ${conditions.join(" AND ")}`, params);
                return r.rows.map((row) => ({ id: row.id, kind: row.kind, sourceInstanceId: row.source_instance_id ?? undefined, sourceStudyId: row.source_study_id ?? undefined, checksumSha256: row.checksum_sha256, sizeBytes: Number(row.size_bytes), provenanceId: row.provenance_id, objectStorageKey: row.object_storage_key, createdAt: row.created_at.toISOString() }));
            },

            async createShareGrant(input, actor) {
                return tx(async (client) => {
                    const id = randomUUID();
                    const result = await client.query(
                        `INSERT INTO ${schema}.imaging_share_grants (id, mode, scope, study_id, series_id, instance_id, report_id, recipient_user_id, recipient_organization_id, recipient_email, recipient_name, purpose_of_use, message, expires_at, allow_download, issued_by_user_id, consent_basis, status, external_token_hash, external_verification_code_hash, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active',$18,$19, now()) RETURNING *`,
                        [id, input.mode, input.scope, input.studyId, input.seriesId ?? null, input.instanceId ?? null, input.reportId ?? null, input.recipientUserId ?? null, input.recipientOrganizationId ?? null, input.recipientEmail ?? null, input.recipientName ?? null, input.purposeOfUse, input.message ?? null, input.expiresAt, input.allowDownload, input.issuedByUserId, input.consentBasis, input.externalTokenHash ?? null, input.externalVerificationCodeHash ?? null]
                    );
                    const grant = stripShareInternal(mapShareGrantRow(result.rows[0]));
                    await recordChange(client, "upsert", "shareGrant", id, input.studyId, grant);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingShareGrant.create", targetType: "imagingShareGrant", targetId: id, details: { mode: input.mode, scope: input.scope, studyId: input.studyId } });
                    return grant;
                });
            },

            async getShareGrant(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_share_grants WHERE id = $1`, [id]);
                return r.rows[0] ? stripShareInternal(mapShareGrantRow(r.rows[0])) : null;
            },

            async listShareGrantsForStudy(studyId) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_share_grants WHERE study_id = $1 ORDER BY created_at DESC`, [studyId]);
                return r.rows.map((row) => stripShareInternal(mapShareGrantRow(row)));
            },

            async revokeShareGrant(id, revokedByUserId, actor) {
                return tx(async (client) => {
                    const result = await client.query(`UPDATE ${schema}.imaging_share_grants SET status = 'revoked', revoked_by_user_id = $2, revoked_at = now() WHERE id = $1 AND status = 'active' RETURNING *`, [id, revokedByUserId]);
                    if (!result.rows[0]) return null;
                    const grant = stripShareInternal(mapShareGrantRow(result.rows[0]));
                    await recordChange(client, "upsert", "shareGrant", id, grant.studyId, grant);
                    await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingShareGrant.revoke", targetType: "imagingShareGrant", targetId: id, details: {} });
                    return grant;
                });
            },

            async findActiveExternalShareByTokenHash(tokenHash) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_share_grants WHERE external_token_hash = $1 AND status = 'active'`, [tokenHash]);
                const row = r.rows[0];
                if (!row) return null;
                const mapped = mapShareGrantRow(row);
                return { grant: stripShareInternal(mapped), externalVerificationCodeHash: mapped.externalVerificationCodeHash ?? "" };
            },

            async createIngestionJob(input, createdByUserId, actor) {
                const id = randomUUID();
                const result = await pool.query(
                    `INSERT INTO ${schema}.imaging_ingestion_jobs (id, upload_id, file_name, size_bytes, checksum_sha256, status, study_id, failure_category, created_by_user_id, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now()) RETURNING *`,
                    [id, input.uploadId, input.fileName, input.sizeBytes, input.checksumSha256 ?? null, input.status, input.studyId ?? null, input.failureCategory ?? null, createdByUserId]
                );
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingIngestionJob.create", targetType: "imagingIngestionJob", targetId: id, details: { status: input.status } });
                return mapIngestionJobRow(result.rows[0]);
            },

            async getIngestionJob(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_ingestion_jobs WHERE id = $1`, [id]);
                return r.rows[0] ? mapIngestionJobRow(r.rows[0]) : null;
            },

            async listIngestionJobs(filter) {
                const where = filter?.status !== undefined ? "WHERE status = $1" : "";
                const params = filter?.status !== undefined ? [filter.status] : [];
                const r = await pool.query(`SELECT * FROM ${schema}.imaging_ingestion_jobs ${where} ORDER BY created_at DESC`, params);
                return r.rows.map(mapIngestionJobRow);
            },

            async updateIngestionJob(id, partial, actor) {
                const sets: string[] = [];
                const params: unknown[] = [];
                for (const [key, value] of Object.entries(partial)) {
                    const column = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
                    params.push(value);
                    sets.push(`${column} = $${params.length}`);
                }
                if (sets.length === 0) {
                    const existing = await pool.query(`SELECT * FROM ${schema}.imaging_ingestion_jobs WHERE id = $1`, [id]);
                    return existing.rows[0] ? mapIngestionJobRow(existing.rows[0]) : null;
                }
                params.push(id);
                const result = await pool.query(`UPDATE ${schema}.imaging_ingestion_jobs SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
                if (!result.rows[0]) return null;
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingIngestionJob.update", targetType: "imagingIngestionJob", targetId: id, details: { status: partial.status, failureCategory: partial.failureCategory } });
                return mapIngestionJobRow(result.rows[0]);
            },

            async createViewerSession(input, actor) {
                const id = randomUUID();
                const result = await pool.query(
                    `INSERT INTO ${schema}.viewer_sessions (id, user_id, study_id, series_ids, instance_ids, granted_actions, share_grant_id, token_hash, issued_at, expires_at, revoked)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9, FALSE) RETURNING *`,
                    [id, input.userId ?? null, input.studyId, input.seriesIds ?? null, input.instanceIds ?? null, input.grantedActions, input.shareGrantId ?? null, input.tokenHash, input.expiresAt]
                );
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingViewerSession.create", targetType: "imagingViewerSession", targetId: id, details: { studyId: input.studyId, grantedActions: input.grantedActions } });
                const { tokenHash: _h, ...publicSession } = mapViewerSessionRow(result.rows[0]);
                return publicSession;
            },

            async findActiveViewerSessionByTokenHash(tokenHash) {
                const r = await pool.query(`SELECT * FROM ${schema}.viewer_sessions WHERE token_hash = $1 AND NOT revoked AND expires_at > now()`, [tokenHash]);
                if (!r.rows[0]) return null;
                const { tokenHash: _h, ...publicSession } = mapViewerSessionRow(r.rows[0]);
                return publicSession;
            },

            async revokeViewerSession(id, actor) {
                const result = await pool.query(`UPDATE ${schema}.viewer_sessions SET revoked = TRUE WHERE id = $1 AND NOT revoked RETURNING id`, [id]);
                if (result.rows[0]) {
                    await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingViewerSession.revoke", targetType: "imagingViewerSession", targetId: id, details: {} });
                }
            },

            async revokeViewerSessionsForShareGrant(shareGrantId, actor) {
                const result = await pool.query(`UPDATE ${schema}.viewer_sessions SET revoked = TRUE WHERE share_grant_id = $1 AND NOT revoked RETURNING id`, [shareGrantId]);
                const count = result.rowCount ?? 0;
                if (count > 0) {
                    await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingViewerSession.revokeForShareGrant", targetType: "imagingShareGrant", targetId: shareGrantId, details: { count } });
                }
                return count;
            },

            async createDeidentificationJob(input) {
                const id = randomUUID();
                const result = await pool.query(
                    `INSERT INTO ${schema}.deidentification_jobs (id, source_study_id, profile, purpose, burned_in_text_suspected, recognizable_features_flagged, review_status, reviewed_by_user_id, reviewed_at, result_artifact_id, requested_by_user_id, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now()) RETURNING *`,
                    [id, input.sourceStudyId, input.profile, input.purpose, input.burnedInTextSuspected, input.recognizableFeaturesFlagged, input.reviewStatus, input.reviewedByUserId ?? null, input.reviewedAt ?? null, input.resultArtifactId ?? null, input.requestedByUserId]
                );
                return mapDeidJobRow(result.rows[0]);
            },

            async getDeidentificationJob(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.deidentification_jobs WHERE id = $1`, [id]);
                return r.rows[0] ? mapDeidJobRow(r.rows[0]) : null;
            },

            async updateDeidentificationJob(id, partial) {
                const sets: string[] = [];
                const params: unknown[] = [];
                for (const [key, value] of Object.entries(partial)) {
                    const column = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
                    params.push(value);
                    sets.push(`${column} = $${params.length}`);
                }
                if (sets.length === 0) { const r = await pool.query(`SELECT * FROM ${schema}.deidentification_jobs WHERE id = $1`, [id]); return r.rows[0] ? mapDeidJobRow(r.rows[0]) : null; }
                params.push(id);
                const result = await pool.query(`UPDATE ${schema}.deidentification_jobs SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
                return result.rows[0] ? mapDeidJobRow(result.rows[0]) : null;
            },

            async createDocumentReference(input) {
                const id = randomUUID();
                const result = await pool.query(
                    `INSERT INTO ${schema}.document_references (id, study_id, case_id, title, content_type, size_bytes, checksum_sha256, object_storage_key, author_user_id, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) RETURNING *`,
                    [id, input.studyId ?? null, input.caseId ?? null, input.title, input.contentType, input.sizeBytes, input.checksumSha256, input.objectStorageKey, input.authorUserId]
                );
                const row = result.rows[0];
                return { id, studyId: row.study_id ?? undefined, caseId: row.case_id ?? undefined, title: row.title, contentType: row.content_type, sizeBytes: Number(row.size_bytes), checksumSha256: row.checksum_sha256, authorUserId: row.author_user_id, createdAt: row.created_at.toISOString() } as DocumentReference;
            },

            async listDocumentReferencesForStudy(studyId) {
                const r = await pool.query(`SELECT * FROM ${schema}.document_references WHERE study_id = $1`, [studyId]);
                return r.rows.map((row) => ({ id: row.id, studyId: row.study_id ?? undefined, caseId: row.case_id ?? undefined, title: row.title, contentType: row.content_type, sizeBytes: Number(row.size_bytes), checksumSha256: row.checksum_sha256, authorUserId: row.author_user_id, createdAt: row.created_at.toISOString() }));
            },

            async readChanges(cursor) {
                const after = cursor !== null && /^\d+$/.test(cursor) ? cursor : "0";
                const r = await pool.query<{ sequence: string; kind: "upsert" | "delete"; resource_type: "study" | "report" | "shareGrant"; resource_id: string; study_id: string; resource: unknown; changed_at: Date }>(
                    `SELECT * FROM ${schema}.imaging_changes WHERE sequence > $1 ORDER BY sequence ASC LIMIT 1000`,
                    [after]
                );
                const changes: StoredImagingChange[] = r.rows.map((row) => {
                    const base = { sequence: row.sequence, resourceType: row.resource_type, resourceId: row.resource_id, studyId: row.study_id, changedAt: row.changed_at.toISOString() };
                    const change: ImagingChange =
                        row.kind === "upsert"
                            ? { ...base, kind: "upsert", ...(row.resource_type === "study" ? { study: row.resource as ImagingStudy } : row.resource_type === "report" ? { report: row.resource as DiagnosticReport } : { shareGrant: row.resource as ImagingShareGrant }) }
                            : { ...base, kind: "delete" };
                    return { change };
                });
                const newCursor = changes.length > 0 ? changes[changes.length - 1].change.sequence : after;
                return { changes, cursor: newCursor };
            },
        };
    }
}
