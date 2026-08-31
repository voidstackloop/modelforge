import type { AiInferenceDeployment, AiModelArtifact, AiProvider, AiProviderModel } from "@modelforge/contracts";
import type { AuditActor } from "./audit-store.js";

/**
 * The global, cross-tenant, PHI-free provider/model catalog — "what a model
 * *is*," never anything about any patient's data. Lives outside every
 * tenant schema (packages/contracts/src/ai-gateway.ts's own doc comment;
 * migration 018's Part 0). Per-tenant approval/opt-in
 * (`AiProviderTenantSettings`) is a SEPARATE, tenant-scoped concept in
 * `ai-gateway-store.ts` — a model existing here with `phiPermitted: true`
 * never by itself authorizes any tenant to send it PHI.
 */
export interface CreateAiProviderInput {
    name: string;
    kind: AiProvider["kind"];
}

export interface CreateAiProviderModelInput {
    providerId: string;
    modelId: string;
    modelVersion: string;
    apiVersion?: string;
    intendedUse: string;
    prohibitedUse?: string;
    supportedDataTypes: AiProviderModel["supportedDataTypes"];
    maxContextTokens: number;
    hostingRegion: string;
    processingLocation: string;
    phiPermitted?: boolean;
    retainsPrompts?: boolean;
    retainsOutputs?: boolean;
    trainingUseAllowed?: boolean;
    zeroRetentionSupport?: boolean;
    approvals?: AiProviderModel["approvals"];
    encryptionInTransit?: boolean;
    encryptionAtRest?: boolean;
    validationStatus?: AiProviderModel["validationStatus"];
    approvedRoles?: string[];
    rateLimitPerMinute?: number;
    costPerInputTokenUsd?: number;
    costPerOutputTokenUsd?: number;
    cpuThreads?: number;
    ramMB?: number;
    vramMB?: number;
    effectiveAt?: string;
}

export type CreateAiModelArtifactInput = Omit<AiModelArtifact, "id" | "createdAt" | "updatedAt">;
export type CreateAiInferenceDeploymentInput = Omit<AiInferenceDeployment, "id" | "createdAt" | "updatedAt" | "lastVerifiedAt" | "runtimeVersion">;

export interface AiProviderRegistryStore {
    createProvider(input: CreateAiProviderInput, actor: AuditActor): Promise<AiProvider>;
    getProvider(id: string): Promise<AiProvider | null>;
    listProviders(): Promise<AiProvider[]>;
    /** The administrative kill switch — item: "Support immediate provider
     * or model shutdown through an administrative kill switch." Engaging
     * this must take effect on the very next admission check, never wait
     * for a cache or background sweep. */
    setProviderKillSwitch(id: string, engaged: boolean, reason: string | undefined, actor: AuditActor): Promise<AiProvider | null>;
    setProviderOperationalStatus(id: string, status: AiProvider["operationalStatus"], actor: AuditActor): Promise<AiProvider | null>;

    createProviderModel(input: CreateAiProviderModelInput, actor: AuditActor): Promise<AiProviderModel>;
    getProviderModel(id: string): Promise<AiProviderModel | null>;
    listProviderModels(filter?: { providerId?: string }): Promise<AiProviderModel[]>;
    setProviderModelSafetyStatus(id: string, status: AiProviderModel["safetyStatus"], actor: AuditActor): Promise<AiProviderModel | null>;
    retireProviderModel(id: string, actor: AuditActor): Promise<AiProviderModel | null>;

    createModelArtifact(input: CreateAiModelArtifactInput, actor: AuditActor): Promise<AiModelArtifact>;
    getModelArtifact(id: string): Promise<AiModelArtifact | null>;
    listModelArtifacts(filter?: { providerModelId?: string; status?: AiModelArtifact["status"] }): Promise<AiModelArtifact[]>;
    setModelArtifactStatus(id: string, status: AiModelArtifact["status"], actor: AuditActor): Promise<AiModelArtifact | null>;
    createInferenceDeployment(input: CreateAiInferenceDeploymentInput, actor: AuditActor): Promise<AiInferenceDeployment>;
    getInferenceDeployment(id: string): Promise<AiInferenceDeployment | null>;
    listInferenceDeployments(filter?: { artifactId?: string; operationalStatus?: AiInferenceDeployment["operationalStatus"] }): Promise<AiInferenceDeployment[]>;
    setInferenceDeploymentStatus(id: string, status: AiInferenceDeployment["operationalStatus"], actor: AuditActor): Promise<AiInferenceDeployment | null>;
    recordInferenceDeploymentVerification(id: string, result: { runtimeVersion?: string; healthy: boolean }, actor: AuditActor): Promise<AiInferenceDeployment | null>;
}
