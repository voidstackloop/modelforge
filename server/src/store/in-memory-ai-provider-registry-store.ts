import { randomUUID } from "node:crypto";
import type { AiInferenceDeployment, AiModelArtifact, AiProvider, AiProviderModel } from "@modelforge/contracts";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";
import type { AiProviderRegistryStore, CreateAiInferenceDeploymentInput, CreateAiModelArtifactInput, CreateAiProviderInput, CreateAiProviderModelInput } from "./ai-provider-registry-store.js";

/** Global (non-tenant) provider/model catalog — the default when
 * DATABASE_URL is unset, and what every non-Postgres-gated test exercises.
 * See ai-provider-registry-store.ts's own doc comment. */
export class InMemoryAiProviderRegistryStore implements AiProviderRegistryStore {
    private readonly providers = new Map<string, AiProvider>();
    private readonly models = new Map<string, AiProviderModel>();
    private readonly artifacts = new Map<string, AiModelArtifact>();
    private readonly deployments = new Map<string, AiInferenceDeployment>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    async createProvider(input: CreateAiProviderInput, actor: AuditActor): Promise<AiProvider> {
        const id = randomUUID();
        const now = new Date().toISOString();
        const provider: AiProvider = {
            id, name: input.name, kind: input.kind,
            killSwitchEngaged: false, operationalStatus: "active",
            createdAt: now, updatedAt: now,
        };
        this.providers.set(id, provider);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProvider.create", targetType: "aiProvider", targetId: id, details: { name: input.name, kind: input.kind } });
        return provider;
    }

    async getProvider(id: string): Promise<AiProvider | null> {
        return this.providers.get(id) ?? null;
    }

    async listProviders(): Promise<AiProvider[]> {
        return [...this.providers.values()];
    }

    async setProviderKillSwitch(id: string, engaged: boolean, reason: string | undefined, actor: AuditActor): Promise<AiProvider | null> {
        const existing = this.providers.get(id);
        if (!existing) return null;
        const updated: AiProvider = { ...existing, killSwitchEngaged: engaged, killSwitchReason: engaged ? reason : undefined, updatedAt: new Date().toISOString() };
        this.providers.set(id, updated);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: engaged ? "aiProvider.killSwitchEngaged" : "aiProvider.killSwitchDisengaged", targetType: "aiProvider", targetId: id, details: { reason } });
        return updated;
    }

    async setProviderOperationalStatus(id: string, status: AiProvider["operationalStatus"], actor: AuditActor): Promise<AiProvider | null> {
        const existing = this.providers.get(id);
        if (!existing) return null;
        const updated: AiProvider = { ...existing, operationalStatus: status, updatedAt: new Date().toISOString() };
        this.providers.set(id, updated);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProvider.statusChanged", targetType: "aiProvider", targetId: id, details: { status } });
        return updated;
    }

    async createProviderModel(input: CreateAiProviderModelInput, actor: AuditActor): Promise<AiProviderModel> {
        const id = randomUUID();
        const now = new Date().toISOString();
        const model: AiProviderModel = {
            id, providerId: input.providerId, modelId: input.modelId, modelVersion: input.modelVersion,
            apiVersion: input.apiVersion, intendedUse: input.intendedUse, prohibitedUse: input.prohibitedUse,
            supportedDataTypes: input.supportedDataTypes, maxContextTokens: input.maxContextTokens,
            hostingRegion: input.hostingRegion, processingLocation: input.processingLocation,
            phiPermitted: input.phiPermitted ?? false,
            retainsPrompts: input.retainsPrompts ?? false,
            retainsOutputs: input.retainsOutputs ?? false,
            trainingUseAllowed: input.trainingUseAllowed ?? false,
            zeroRetentionSupport: input.zeroRetentionSupport ?? false,
            approvals: input.approvals ?? { baaSigned: false, dpaSigned: false, contractualApproval: false, securityReviewApproval: false },
            encryptionInTransit: input.encryptionInTransit ?? false,
            encryptionAtRest: input.encryptionAtRest ?? false,
            validationStatus: input.validationStatus ?? "unvalidated",
            safetyStatus: "nominal",
            approvedRoles: input.approvedRoles ?? [],
            rateLimitPerMinute: input.rateLimitPerMinute,
            costPerInputTokenUsd: input.costPerInputTokenUsd,
            costPerOutputTokenUsd: input.costPerOutputTokenUsd,
            cpuThreads: input.cpuThreads, ramMB: input.ramMB, vramMB: input.vramMB,
            effectiveAt: input.effectiveAt ?? now,
            createdAt: now, updatedAt: now,
        };
        this.models.set(id, model);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProviderModel.create", targetType: "aiProviderModel", targetId: id, details: { providerId: input.providerId, modelId: input.modelId, modelVersion: input.modelVersion, phiPermitted: model.phiPermitted } });
        return model;
    }

    async getProviderModel(id: string): Promise<AiProviderModel | null> {
        return this.models.get(id) ?? null;
    }

    async listProviderModels(filter?: { providerId?: string }): Promise<AiProviderModel[]> {
        const all = [...this.models.values()];
        return filter?.providerId ? all.filter((m) => m.providerId === filter.providerId) : all;
    }

    async setProviderModelSafetyStatus(id: string, status: AiProviderModel["safetyStatus"], actor: AuditActor): Promise<AiProviderModel | null> {
        const existing = this.models.get(id);
        if (!existing) return null;
        const updated: AiProviderModel = { ...existing, safetyStatus: status, updatedAt: new Date().toISOString() };
        this.models.set(id, updated);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProviderModel.safetyStatusChanged", targetType: "aiProviderModel", targetId: id, details: { status } });
        return updated;
    }

    async retireProviderModel(id: string, actor: AuditActor): Promise<AiProviderModel | null> {
        const existing = this.models.get(id);
        if (!existing) return null;
        const updated: AiProviderModel = { ...existing, validationStatus: "deprecated", retiredAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        this.models.set(id, updated);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProviderModel.retired", targetType: "aiProviderModel", targetId: id });
        return updated;
    }

    async createModelArtifact(input: CreateAiModelArtifactInput, actor: AuditActor): Promise<AiModelArtifact> {
        const id = randomUUID();
        const now = new Date().toISOString();
        const artifact: AiModelArtifact = { ...input, id, createdAt: now, updatedAt: now };
        this.artifacts.set(id, artifact);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiModelArtifact.create", targetType: "aiModelArtifact", targetId: id, details: { providerModelId: input.providerModelId, runtime: input.runtime, sha256: input.sha256 } });
        return artifact;
    }

    async getModelArtifact(id: string): Promise<AiModelArtifact | null> { return this.artifacts.get(id) ?? null; }

    async listModelArtifacts(filter?: { providerModelId?: string; status?: AiModelArtifact["status"] }): Promise<AiModelArtifact[]> {
        return [...this.artifacts.values()].filter((artifact) =>
            (!filter?.providerModelId || artifact.providerModelId === filter.providerModelId)
            && (!filter?.status || artifact.status === filter.status));
    }

    async setModelArtifactStatus(id: string, status: AiModelArtifact["status"], actor: AuditActor): Promise<AiModelArtifact | null> {
        const existing = this.artifacts.get(id);
        if (!existing) return null;
        const updated = { ...existing, status, updatedAt: new Date().toISOString() };
        this.artifacts.set(id, updated);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiModelArtifact.statusChanged", targetType: "aiModelArtifact", targetId: id, details: { status } });
        return updated;
    }

    async createInferenceDeployment(input: CreateAiInferenceDeploymentInput, actor: AuditActor): Promise<AiInferenceDeployment> {
        const id = randomUUID();
        const now = new Date().toISOString();
        const deployment: AiInferenceDeployment = { ...input, id, createdAt: now, updatedAt: now };
        this.deployments.set(id, deployment);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiInferenceDeployment.create", targetType: "aiInferenceDeployment", targetId: id, details: { artifactId: input.artifactId, endpointUrl: input.endpointUrl, poolId: input.poolId } });
        return deployment;
    }

    async getInferenceDeployment(id: string): Promise<AiInferenceDeployment | null> { return this.deployments.get(id) ?? null; }

    async listInferenceDeployments(filter?: { artifactId?: string; operationalStatus?: AiInferenceDeployment["operationalStatus"] }): Promise<AiInferenceDeployment[]> {
        return [...this.deployments.values()]
            .filter((deployment) => (!filter?.artifactId || deployment.artifactId === filter.artifactId) && (!filter?.operationalStatus || deployment.operationalStatus === filter.operationalStatus))
            .sort((left, right) => left.priority - right.priority || left.createdAt.localeCompare(right.createdAt));
    }

    async setInferenceDeploymentStatus(id: string, status: AiInferenceDeployment["operationalStatus"], actor: AuditActor): Promise<AiInferenceDeployment | null> {
        const existing = this.deployments.get(id);
        if (!existing) return null;
        const updated = { ...existing, operationalStatus: status, updatedAt: new Date().toISOString() };
        this.deployments.set(id, updated);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiInferenceDeployment.statusChanged", targetType: "aiInferenceDeployment", targetId: id, details: { status } });
        return updated;
    }

    async recordInferenceDeploymentVerification(id: string, result: { runtimeVersion?: string; healthy: boolean }, actor: AuditActor): Promise<AiInferenceDeployment | null> {
        const existing = this.deployments.get(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        const updated: AiInferenceDeployment = { ...existing, runtimeVersion: result.runtimeVersion ?? existing.runtimeVersion, lastVerifiedAt: now, operationalStatus: result.healthy ? "active" : "degraded", updatedAt: now };
        this.deployments.set(id, updated);
        await this.auditStore.record({ organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiInferenceDeployment.verified", targetType: "aiInferenceDeployment", targetId: id, details: { healthy: result.healthy, runtimeVersion: result.runtimeVersion } });
        return updated;
    }
}
