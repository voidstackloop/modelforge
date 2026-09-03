import { randomUUID } from "node:crypto";
import type { Hl7IngestionJob } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";
import type { Hl7IngestionStore, TenantHl7IngestionRepository } from "./hl7-ingestion-store.js";

interface OrgState {
    jobs: Map<string, Hl7IngestionJob>;
}

function emptyOrgState(): OrgState {
    return { jobs: new Map() };
}

export class InMemoryHl7IngestionStore implements Hl7IngestionStore {
    private readonly orgs = new Map<string, OrgState>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    private stateFor(organizationId: string): OrgState {
        let state = this.orgs.get(organizationId);
        if (!state) {
            state = emptyOrgState();
            this.orgs.set(organizationId, state);
        }
        return state;
    }

    forTenant(context: TenantContext): TenantHl7IngestionRepository {
        const state = this.stateFor(context.organizationId);
        const auditStore = this.auditStore;
        const organizationId = context.organizationId;

        const repository: TenantHl7IngestionRepository = {
            context,

            async createJob(input, actor: AuditActor) {
                const id = randomUUID();
                const now = new Date().toISOString();
                const job: Hl7IngestionJob = { id, createdAt: now, updatedAt: now, ...input };
                state.jobs.set(id, job);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "hl7IngestionJob.create", targetType: "hl7IngestionJob", targetId: id, details: { messageType: input.messageType, matchStatus: input.matchStatus, status: input.status } });
                return job;
            },

            async getJob(id) {
                return state.jobs.get(id) ?? null;
            },

            async listJobs(filter) {
                let all = [...state.jobs.values()];
                if (filter?.status !== undefined) all = all.filter((j) => j.status === filter.status);
                return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            },

            async updateJob(id, partial, actor: AuditActor) {
                const existing = state.jobs.get(id);
                if (!existing) return null;
                const updated: Hl7IngestionJob = { ...existing, ...partial, updatedAt: new Date().toISOString() };
                state.jobs.set(id, updated);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "hl7IngestionJob.update", targetType: "hl7IngestionJob", targetId: id, details: { status: updated.status, matchedCaseId: updated.matchedCaseId } });
                return updated;
            },
        };
        return repository;
    }
}
