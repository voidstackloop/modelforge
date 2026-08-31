import type { MigrationPreview, MigrationSession } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import type { AuditActor } from "./audit-store.js";
import type { TenantCaseRepository } from "./case-store.js";

export class MigrationStateError extends Error { readonly statusCode = 409; }

export interface TenantCaseMigrationRepository {
    start(input: { sourceFingerprint: string; totalItems: number }, actor: AuditActor): Promise<MigrationSession>;
    get(id: string): Promise<MigrationSession | null>;
    upload(id: string, items: { itemKey: string; patientCase: unknown }[], actor: AuditActor): Promise<MigrationSession>;
    validate(id: string, actor: AuditActor): Promise<MigrationPreview>;
    activate(id: string, actor: AuditActor): Promise<MigrationSession>;
    rollback(id: string, actor: AuditActor): Promise<MigrationSession>;
}

export interface CaseMigrationStore {
    forTenant(context: TenantContext, cases: TenantCaseRepository): TenantCaseMigrationRepository;
}
