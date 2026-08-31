import type { CaseChange, CaseChangeFeed, CaseResourceAttributes, PatientCase } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import type { AuditActor } from "./audit-store.js";

export function parseVersionCursor(cursor: string | null): bigint | null {
    if (cursor === null || !/^\d+$/.test(cursor)) return null;
    return BigInt(cursor);
}

export interface StoredCaseChange { change: CaseChange; resource: CaseResourceAttributes }

export interface TenantCaseRepository {
    readonly context: TenantContext;
    readAll(): Promise<PatientCase[]>;
    getOne(id: string): Promise<{ patientCase: PatientCase; resource: CaseResourceAttributes } | null>;
    readChanges(cursor: string | null): Promise<{ changes: StoredCaseChange[]; cursor: string }>;
    writeOne(patientCase: PatientCase, expectedVersion: string | null, actor: AuditActor, resource: CaseResourceAttributes): Promise<{ patientCase: PatientCase; version: string } | { conflict: true; current: PatientCase }>;
    deleteOne(id: string, expectedVersion: string | null, actor: AuditActor): Promise<{ deleted: true; tombstone: CaseChange } | { conflict: true; current: PatientCase } | { notFound: true }>;
}

export interface CaseStore {
    forTenant(context: TenantContext): TenantCaseRepository;
    readAll(organizationId: string): Promise<PatientCase[]>;
    readSince(organizationId: string, cursor: string | null): Promise<{ cases: PatientCase[]; cursor: string }>;
    writeOne(organizationId: string, patientCase: PatientCase, expectedVersion: string | null, actor: AuditActor): Promise<{ patientCase: PatientCase; version: string } | { conflict: true; current: PatientCase }>;
    deleteOne(organizationId: string, id: string, expectedVersion: string | null, actor: AuditActor): Promise<{ deleted: true } | { conflict: true; current: PatientCase } | { notFound: true }>;
}

export function publicFeed(changes: StoredCaseChange[], cursor: string): CaseChangeFeed {
    const publicChanges = changes.map((entry) => entry.change);
    return {
        changes: publicChanges,
        cursor,
        cases: publicChanges.flatMap((change) => (change.kind === "upsert" ? [change.patientCase] : [])),
        deletedIds: publicChanges.flatMap((change) => (change.kind === "delete" ? [change.caseId] : [])),
    };
}
