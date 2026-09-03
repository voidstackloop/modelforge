import type { FastifyReply, FastifyRequest } from "fastify";
import type { AiProvider, AiProviderModel, FhirSmartConfiguration } from "@modelforge/contracts";
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
import type { McpClinicalStore } from "../store/mcp-clinical-store.js";
import type { McpApprovalTicketIssuer } from "../mcp-approval-issuer.js";
import type { DicomwebAdapter } from "../imaging/dicomweb-adapter.js";
import type { ImagingContentDelivery } from "../imaging/content-delivery.js";
import type { ImagingObjectStore } from "../imaging/object-store.js";
import type { ImagingStore } from "../store/imaging-store.js";
import type { Hl7IngestionStore } from "../store/hl7-ingestion-store.js";
import type { SmartLaunchStore } from "../store/smart-launch-store.js";
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
    mcpClinicalStore: McpClinicalStore;
    mcpApprovalTicketIssuer: McpApprovalTicketIssuer;
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
    /** routes/fhir.ts's `.well-known/smart-configuration` document —
     * resolved once at startup (index.ts) via OIDC discovery against the
     * configured issuer (auth/oidc-verifier.ts's
     * resolveAuthorizationServerMetadata). Undefined in test/dev builds
     * that construct RouteDeps without live discovery (e.g. every
     * app.test.ts-style app.inject() suite, which uses a synthetic
     * non-resolvable issuer) — the route itself handles that case with a
     * 503, never a crash. */
    smartConfiguration: FhirSmartConfiguration | undefined;
    hl7IngestionStore: Hl7IngestionStore;
    smartLaunchStore: SmartLaunchStore;
    /** SMART_LAUNCH_ENCRYPTION_KEY, decoded — undefined when unset, in
     * which case routes/smart-launch.ts's own token-exchange route fails
     * closed with 503 rather than encrypting with no real key. Unlike
     * hl7Mllp (a whole listener that simply doesn't start), the SMART
     * launch routes are always registered — this flag is checked per
     * request instead, so configuring/listing trusted issuers and viewing
     * one's own session list still works even before an operator sets
     * this, and only the step that would actually need to encrypt a new
     * token is blocked. */
    smartLaunchEncryptionKey: Buffer | undefined;
}
