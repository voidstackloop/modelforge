import type { FastifyReply, FastifyRequest } from "fastify";
import type { AiProvider, AiProviderModel } from "@modelforge/contracts";
import type { AiInferenceAdmission } from "../ai-gateway/admission.js";
import type { AiProviderClient } from "../ai-gateway/provider-client.js";
import type { AccessGovernanceStore } from "../store/access-governance-store.js";
import type { AiGatewayStore } from "../store/ai-gateway-store.js";
import type { AiProviderRegistryStore } from "../store/ai-provider-registry-store.js";
import type { AuditLegalHoldStore } from "../store/audit-legal-hold-store.js";
import type { AuditStore } from "../store/audit-store.js";
import type { CaseStore } from "../store/case-store.js";
import type { CaseMigrationStore } from "../store/case-migration-store.js";
import type { IamStore } from "../store/iam-store.js";
import type { IdempotencyStore } from "../store/idempotency-store.js";
import type { McpRegistryStore } from "../store/mcp-registry-store.js";
import type { DicomwebAdapter } from "../imaging/dicomweb-adapter.js";
import type { ImagingContentDelivery } from "../imaging/content-delivery.js";
import type { ImagingObjectStore } from "../imaging/object-store.js";
import type { ImagingStore } from "../store/imaging-store.js";
import type { PrincipalStore } from "../store/principal-store.js";
import type { ScimTokenStore } from "../store/scim-token-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { TenantBackupStore } from "../store/tenant-backup-store.js";
import type { TenantDirectory } from "../tenant-context.js";
import type { ComputeControlStore } from "../store/compute-control-store.js";
import type { ComputeControlPlane } from "../compute/control-plane.js";
import type { ComputePolicySignatureVerifier } from "../compute/policy-signature.js";

export interface RouteDeps {
    store: IamStore;
    caseStore: CaseStore;
    caseMigrationStore: CaseMigrationStore;
    idempotencyStore: IdempotencyStore;
    auditStore: AuditStore;
    auditLegalHoldStore: AuditLegalHoldStore;
    tenantBackupStore: TenantBackupStore;
    sessionStore: SessionStore;
    principalStore: PrincipalStore;
    accessGovernanceStore: AccessGovernanceStore;
    scimTokenStore: ScimTokenStore;
    imagingStore: ImagingStore;
    imagingObjectStore: ImagingObjectStore;
    aiGatewayStore: AiGatewayStore;
    aiProviderRegistryStore: AiProviderRegistryStore;
    mcpRegistryStore: McpRegistryStore;
    computeControlStore: ComputeControlStore;
    computeControlPlane: ComputeControlPlane;
    verifyComputePolicySignature: ComputePolicySignatureVerifier;
    resolveComputeAgentCertificateFingerprint: (request: FastifyRequest) => string | undefined;
    aiAdmission: AiInferenceAdmission;
    /** How routes/ai-gateway.ts resolves an actual model client for a given
     * catalog row — see app.ts's own default and ai-gateway/provider-
     * client.ts's doc comments on what's real vs. production-shaped-but-
     * untested here. */
    resolveAiProviderClient: (provider: AiProvider, providerModel: AiProviderModel) => AiProviderClient | Promise<AiProviderClient>;
    /** Swappable per docs/IMAGING.md's "prefer PACS/VNA integration through
     * an adapter" — defaults to LocalDicomwebAdapter (app.ts); index.ts
     * swaps in a ProxyDicomwebAdapter factory when PACS_BASE_URL is
     * configured. Routes never construct an adapter directly. */
    createDicomwebAdapter: (organizationId: string) => DicomwebAdapter;
    imagingStorageMode: "local-filesystem" | "s3";
    dicomwebMode: "local" | "pacs-proxy";
    /** CDN delivery for pixel data. Defaults to OriginStreamContentDelivery
     * (stream every byte through this server), which is what runs unless a
     * deployment explicitly configures CloudFront — see
     * imaging/content-delivery.ts. */
    imagingContentDelivery: ImagingContentDelivery;
    /** How long a break-glass grant lasts once invoked (routes/break-glass.ts) —
     * see config.ts's breakGlass.grantDurationMs doc comment for why this is
     * a placeholder default, not a derived requirement. */
    breakGlassGrantDurationMs: number;
    tenantDirectory: TenantDirectory;
    authPreHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}
