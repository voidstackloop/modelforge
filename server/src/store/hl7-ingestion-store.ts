import type { Hl7IngestionJob } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import type { AuditActor } from "./audit-store.js";

/**
 * Tenant-scoped repository for HL7 v2 inbound ingestion jobs — mirrors
 * imaging-store.ts's own createIngestionJob/getIngestionJob/
 * updateIngestionJob shape exactly (same "one job row per inbound item,
 * created regardless of outcome, updated in place as review happens"
 * pattern DICOM ingestion already established). See hl7/ingestion.ts for
 * the actual match/apply logic this backs.
 */
export interface TenantHl7IngestionRepository {
    readonly context: TenantContext;
    createJob(input: Omit<Hl7IngestionJob, "id" | "createdAt" | "updatedAt">, actor: AuditActor): Promise<Hl7IngestionJob>;
    getJob(id: string): Promise<Hl7IngestionJob | null>;
    listJobs(filter?: { status?: Hl7IngestionJob["status"] }): Promise<Hl7IngestionJob[]>;
    updateJob(
        id: string,
        partial: Partial<Pick<Hl7IngestionJob, "status" | "matchedCaseId" | "observationsAdded" | "reviewedByUserId" | "reviewedAt" | "rejectionReason">>,
        actor: AuditActor
    ): Promise<Hl7IngestionJob | null>;
}

export interface Hl7IngestionStore {
    forTenant(context: TenantContext): TenantHl7IngestionRepository;
}
