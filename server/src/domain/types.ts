import { z } from "zod";

// --- IAM domain model ---------------------------------------------------
//
// Deliberately AWS-IAM-shaped, per docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md
// §5: named policies are JSON documents of {effect, actions, resources,
// condition?} statements, attached to a User directly or via a Group — not
// a fixed enum of roles. Every authorization decision runs through
// policy-evaluator.ts's evaluatePolicies(), which is the single place this
// system's actual security guarantee lives; everything else here is data
// shape and storage.
//
// What this deliberately does NOT do: authenticate anyone. Identity is
// entirely delegated to whatever OIDC provider this deployment is
// configured against (see ../auth/oidc-verifier.ts) — this module only
// models what an already-authenticated principal is allowed to do, per
// docs/ENTERPRISE_READINESS_ASSESSMENT.md §2.1's standing decision not to
// build custom auth/MFA.

export const effectSchema = z.enum(["Allow", "Deny"]);
export type Effect = z.infer<typeof effectSchema>;

// A small, extensible set of condition operators — string comparisons only
// for this first slice (StringEquals/StringNotEquals), matching AWS IAM's
// naming so the shape is immediately recognizable. Each operator maps a
// context key (e.g. "user:department") to one or more values to compare
// against; a context key absent at evaluation time never matches
// StringEquals and always matches StringNotEquals's "not equals" semantics
// only if the key actually differs — see policy-evaluator.ts for the exact
// (deliberately conservative) handling of a missing context key.
export const policyConditionSchema = z
    .object({
        StringEquals: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        StringNotEquals: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    })
    .strict();
export type PolicyCondition = z.infer<typeof policyConditionSchema>;

export const policyStatementSchema = z
    .object({
        sid: z.string().optional(),
        effect: effectSchema,
        // Each entry may contain "*" as a full or partial wildcard segment,
        // e.g. "patientCase:*" or "*". Matched by policy-evaluator.ts's
        // matchesPattern() — never a regex a policy author writes directly,
        // to keep the matching semantics fixed and auditable.
        actions: z.array(z.string().min(1)).min(1),
        resources: z.array(z.string().min(1)).min(1),
        condition: policyConditionSchema.optional(),
    })
    .strict();
export type PolicyStatement = z.infer<typeof policyStatementSchema>;

export const policyDocumentSchema = z
    .object({
        version: z.literal("2026-01-01"),
        statements: z.array(policyStatementSchema).min(1),
    })
    .strict();
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

export const organizationSchema = z.object({
    id: z.string(),
    name: z.string().min(1),
    tenantSchema: z.string().regex(/^tenant_[a-f0-9]{32}$/).optional(),
    createdAt: z.string(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const policySchema = z.object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string().min(1),
    description: z.string().optional(),
    document: policyDocumentSchema,
    // True only for policies this service creates itself (e.g. the
    // org-admin bootstrap policy — see builtin-policies.ts). Not a security
    // boundary by itself (an admin with iam:managePolicies can still create
    // an equally powerful custom policy) — purely so the admin console can
    // visually distinguish and protect built-ins from accidental deletion.
    builtin: z.boolean().default(false),
    // At most one true per organization (see store/iam-store.ts's
    // setBreakGlassPolicy doc comment) — the one policy routes/guards.ts
    // temporarily attaches to a user's effective policy set while they
    // hold an active, unreviewed BreakGlassGrant (below). A separate flag
    // from `builtin` on purpose: an org admin must be able to author,
    // replace, and eventually delete their own emergency policy, which
    // builtin's delete-protection would otherwise obstruct.
    isBreakGlassPolicy: z.boolean().default(false),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Policy = z.infer<typeof policySchema>;

export const groupSchema = z.object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string().min(1),
    policyIds: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Group = z.infer<typeof groupSchema>;

export const userStatusSchema = z.enum(["active", "suspended"]);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const userSchema = z.object({
    id: z.string(),
    organizationId: z.string(),
    // The OIDC provider's `sub` claim — the only thing that ties this
    // record to a real identity. Never a locally-stored password or any
    // other credential; see ../auth/oidc-verifier.ts.
    externalSubject: z.string().min(1),
    displayName: z.string().min(1),
    email: z.string().optional(),
    status: userStatusSchema,
    groupIds: z.array(z.string()),
    // Policies attached directly to this user, in addition to whatever its
    // groups grant — mirrors AWS IAM's inline-policy-on-a-user option
    // alongside group-attached (managed-policy-equivalent) grants.
    policyIds: z.array(z.string()),
    // Caps what this user's own policies (direct + via groups) can ever
    // grant, regardless of how permissive they are — the same AWS IAM
    // permission-boundary concept, see policy-evaluator.ts's
    // evaluateWithBoundary(). Absent means unrestricted (the default,
    // pre-existing behavior). Deliberately not a foreign key at the
    // storage layer (see each IamStore implementation's doc comment on
    // this field): if the referenced policy is later deleted, the
    // reference is left dangling on purpose, so routes/guards.ts's lookup
    // fails closed (denies everything) rather than the deletion silently
    // removing the ceiling and granting unrestricted access.
    permissionBoundaryPolicyId: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const identitySchema = z.object({
    id: z.string().uuid(),
    issuer: z.string().min(1),
    subject: z.string().min(1),
    displayName: z.string().min(1),
    email: z.string().email().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Identity = z.infer<typeof identitySchema>;

export const membershipStatusSchema = z.enum(["active", "suspended", "deprovisioned"]);
export const provisioningSourceSchema = z.enum(["bootstrap", "invitation", "admin", "jit", "scim"]);
export const membershipSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    identityId: z.string().uuid(),
    userId: z.string().uuid(),
    status: membershipStatusSchema,
    provisioningSource: provisioningSourceSchema,
    startsAt: z.string(),
    expiresAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Membership = z.infer<typeof membershipSchema>;

export const invitationStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
export const invitationSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1).optional(),
    status: invitationStatusSchema,
    tokenHash: z.string().min(1),
    invitedByUserId: z.string().uuid(),
    expiresAt: z.string(),
    acceptedAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const servicePrincipalStatusSchema = z.enum(["active", "suspended", "deprovisioned"]);
export const servicePrincipalSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    issuer: z.string().min(1),
    externalSubject: z.string().min(1),
    displayName: z.string().min(1),
    status: servicePrincipalStatusSchema,
    policyIds: z.array(z.string().uuid()),
    permissionBoundaryPolicyId: z.string().uuid().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type ServicePrincipal = z.infer<typeof servicePrincipalSchema>;

// --- SCIM provisioning (P2: SCIM and external group reconciliation) ---
//
// A ScimToken authenticates an institutional IdP's SCIM connector (Okta,
// Azure AD, OneLogin, ...) to this organization's SCIM endpoints
// (routes/scim.ts) — a static bearer token the connector presents on every
// request, not an OIDC identity: SCIM provisioning happens *before* a real
// login, so there is no `sub` claim yet to verify against. Modeled after
// Invitation.tokenHash (hashed, shown once at creation, never stored or
// returned in plaintext again) rather than something JWT/JWKS-based, since
// there is no third-party issuer to trust here — this service issues and
// verifies its own SCIM tokens directly.
//
// SCIM "create user" maps onto the *existing* Invitation mechanism
// (domain/types.ts's invitationSchema above) rather than a new identity-less
// User concept — see docs/SCIM.md for the reasoning and its one real
// consequence: a SCIM resource's `id` is the Invitation's id while the
// invitation is pending, but once accepted it becomes a real User/Membership
// with a *different* id. A persistent SCIM client's own filter-based
// reconciliation (GET .../Users?filter=userName eq "...", what every real
// IdP actually polls with) always converges on the truth; a client that
// cached the old pending-invitation id specifically would see it 404 after
// acceptance. Disclosed, not silently glossed over.
export const scimTokenSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    /** Human label shown in the admin console, e.g. "Okta SCIM connector" —
     * purely descriptive, never used for lookup/auth. */
    name: z.string().min(1),
    tokenHash: z.string().min(1),
    createdByUserId: z.string().uuid(),
    createdAt: z.string(),
    /** Updated (best-effort, never blocks the request it's attached to) on
     * every successful SCIM request authenticated with this token — lets an
     * admin see whether a configured connector is actually calling in. */
    lastUsedAt: z.string().optional(),
    revokedAt: z.string().optional(),
});
export type ScimToken = z.infer<typeof scimTokenSchema>;

// --- Break-glass and access reviews (P1: approvals/access-reviews/break-glass) ---
//
// Break-glass grants access IMMEDIATELY on the user entering a
// justification (self-service, no pre-approval gate — waiting would defeat
// the emergency purpose) and requires a MANDATORY post-hoc review
// afterward. It unlocks exactly one pre-configured "emergency access"
// Policy per organization (Policy.isBreakGlassPolicy above) — the invoker
// cannot request an arbitrary resource/action at invocation time. See
// routes/guards.ts for how an active grant is attached to a user's
// effective policy set (guard-level, not a policy-evaluator condition).

export const breakGlassReviewOutcomeSchema = z.enum(["acknowledged", "flagged"]);
export type BreakGlassReviewOutcome = z.infer<typeof breakGlassReviewOutcomeSchema>;

// Never stored directly — derived at read time from reviewedAt/expiresAt,
// the same "plain field, checked live, no sweep job" shape this codebase
// already uses for Membership.expiresAt. Precedence: reviewed > expired >
// active (reviewedAt set is terminal even though expiresAt has virtually
// always already passed by then).
export const breakGlassGrantStatusSchema = z.enum(["active", "expired", "reviewed"]);
export type BreakGlassGrantStatus = z.infer<typeof breakGlassGrantStatusSchema>;

export const breakGlassGrantSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    userId: z.string().uuid(),
    // The specific policy snapshotted at invocation time — NOT re-resolved
    // from "whatever is currently flagged" on every request, so a later
    // reassignment or deletion of the org's emergency policy never changes
    // what an already-issued grant actually granted. Deliberately not a
    // foreign key at the storage layer — same "let the reference dangle,
    // fail closed on lookup" choice as User.permissionBoundaryPolicyId.
    emergencyPolicyId: z.string().uuid(),
    justification: z.string().min(1).max(2000),
    grantedAt: z.string(),
    expiresAt: z.string(),
    status: breakGlassGrantStatusSchema,
    reviewedByUserId: z.string().uuid().optional(),
    reviewedAt: z.string().optional(),
    reviewOutcome: breakGlassReviewOutcomeSchema.optional(),
});
export type BreakGlassGrant = z.infer<typeof breakGlassGrantSchema>;

// An admin-triggered campaign reviewing every active Membership in an
// organization at creation time — not policy/group combinatorics, which is
// unbounded and has no single clear remediation action the way "suspend
// this membership" does. No fixed per-campaign reviewer: anyone holding
// accessReview:decide may decide any item except one where they are the
// subject (see routes/access-reviews.ts's self-review guard).
export const accessReviewCampaignStatusSchema = z.enum(["open", "completed"]);
export const accessReviewCampaignSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    createdByUserId: z.string().uuid(),
    status: accessReviewCampaignStatusSchema,
    createdAt: z.string(),
    completedAt: z.string().optional(),
    // Computed at read time from access_review_items, not denormalized —
    // avoids an update-counter-on-every-decision race.
    itemCount: z.number().int().nonnegative(),
    decidedCount: z.number().int().nonnegative(),
});
export type AccessReviewCampaign = z.infer<typeof accessReviewCampaignSchema>;

export const accessReviewDecisionSchema = z.enum(["pending", "keep", "revoke"]);
export type AccessReviewDecision = z.infer<typeof accessReviewDecisionSchema>;
export const accessReviewItemSchema = z.object({
    id: z.string().uuid(),
    campaignId: z.string().uuid(),
    organizationId: z.string().uuid(),
    membershipId: z.string().uuid(),
    subjectUserId: z.string().uuid(),
    decision: accessReviewDecisionSchema,
    decidedByUserId: z.string().uuid().optional(),
    decidedAt: z.string().optional(),
    createdAt: z.string(),
});
export type AccessReviewItem = z.infer<typeof accessReviewItemSchema>;

// Policy versioning + dual-control approval + rollback (P1: signed central
// policy/configuration, minus the cryptographic-signing half — deliberately
// out of scope this slice, see server/src/routes/policy-versions.ts).
// PATCH .../policies/:policyId (routes/policies.ts) keeps mutating the live
// Policy.document directly, unchanged — this is an ADDITIONAL, optional
// path for organizations that want real separation-of-duties on policy
// changes: propose a version, a *different* user approves or rejects it,
// with rollback to any previously-approved version. Only one version per
// policy is ever "approved" at a time.
export const policyVersionStatusSchema = z.enum(["pending", "approved", "rejected", "superseded"]);
export type PolicyVersionStatus = z.infer<typeof policyVersionStatusSchema>;
export const policyVersionSchema = z.object({
    id: z.string().uuid(),
    policyId: z.string().uuid(),
    organizationId: z.string().uuid(),
    version: z.number().int().positive(),
    document: policyDocumentSchema,
    // sha256 hex of the canonical document JSON — an integrity/audit aid
    // ("this is exactly the content that was approved"), NOT a
    // cryptographic signature. No signing-key infrastructure in this
    // slice, per explicit product direction.
    contentHash: z.string(),
    status: policyVersionStatusSchema,
    proposedByUserId: z.string().uuid(),
    proposedAt: z.string(),
    decidedByUserId: z.string().uuid().optional(),
    decidedAt: z.string().optional(),
    rejectionReason: z.string().optional(),
});
export type PolicyVersion = z.infer<typeof policyVersionSchema>;

// Audit legal holds (P1: immutable audit ingestion, search, export, and
// legal hold — see server/src/routes/audit.ts). No retention/purge job
// exists anywhere in this codebase today, so a hold is a fully-audited
// compliance record for a future purge job to consult, not an active
// blocker — nothing currently deletes audit data at all. Retention/hold
// *periods* are a legal/compliance decision outside this codebase's
// authority (docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md §19) — this only
// records who placed/released a hold, when, and why, indefinitely.
export const auditLegalHoldStatusSchema = z.enum(["active", "released"]);
export type AuditLegalHoldStatus = z.infer<typeof auditLegalHoldStatusSchema>;
export const auditLegalHoldSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    reason: z.string().min(1),
    status: auditLegalHoldStatusSchema,
    placedByUserId: z.string().uuid(),
    placedAt: z.string(),
    releasedByUserId: z.string().uuid().optional(),
    releasedAt: z.string().optional(),
    releaseReason: z.string().optional(),
});
export type AuditLegalHold = z.infer<typeof auditLegalHoldSchema>;

// Institutional MCP server/tool registry (P2 item 4: "managed model/MCP
// registry and egress controls" — see store/mcp-registry-store.ts's doc
// comment for the full design and why this is organization-scoped rather
// than a global catalog like AiProviderModel below). `allowedTools` being
// the literal string "*" (every tool this server offers) or an explicit
// array is the same "allow everything vs. an explicit list" shape this
// app's own local per-tool allowlist already uses (app/src/agent-tools.ts),
// now centrally managed. `dataEgressPolicy` is a centrally-set, auditable
// policy STATEMENT this server publishes — it does not itself enforce
// anything, since MCP traffic never passes through this server at all;
// enforcement is Electron-side, out of scope for this slice.
export const mcpTransportSchema = z.enum(["stdio", "http"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;
export const mcpDataEgressPolicySchema = z.enum(["none", "metadata-only", "unrestricted"]);
export type McpDataEgressPolicy = z.infer<typeof mcpDataEgressPolicySchema>;
export const mcpRegistryStatusSchema = z.enum(["active", "disabled"]);
export type McpRegistryStatus = z.infer<typeof mcpRegistryStatusSchema>;
export const mcpIntegrationProfileSchema = z.enum(["generic", "modelforge-clinical"]);
export type McpIntegrationProfile = z.infer<typeof mcpIntegrationProfileSchema>;
export const mcpAllowedToolsSchema = z.union([z.literal("*"), z.array(z.string().min(1))]);
export type McpAllowedTools = z.infer<typeof mcpAllowedToolsSchema>;
export const mcpRegistryEntrySchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    name: z.string().min(1),
    transport: mcpTransportSchema,
    endpoint: z.string().min(1),
    allowedTools: mcpAllowedToolsSchema,
    dataEgressPolicy: mcpDataEgressPolicySchema,
    integrationProfile: mcpIntegrationProfileSchema,
    oauthClientId: z.string().min(1).max(512).optional(),
    catalogVersionConstraint: z.string().min(1).max(200).optional(),
    approvalChallengeEndpoint: z.string().url().optional(),
    status: mcpRegistryStatusSchema,
    description: z.string().optional(),
    createdByUserId: z.string().uuid(),
    createdAt: z.string(),
    updatedByUserId: z.string().uuid().optional(),
    updatedAt: z.string(),
});
export type McpRegistryEntry = z.infer<typeof mcpRegistryEntrySchema>;

// Tenant backup export and reconciliation-restore (P1 item 6: enterprise
// backup, PITR, and tenant-scoped restore — see server/src/store/
// tenant-backup-store.ts's doc comment). This is a snapshot-and-recover
// tool, not real continuous PITR (that's WAL-archiving infrastructure,
// outside this codebase's authority per docs/ENTERPRISE_ARCHITECTURE_
// ROADMAP.md §19) — and restore only ever upserts, never deletes, so it
// recovers lost/corrupted data rather than rolling back legitimate
// changes made after the backup. See routes/tenant-backup.ts for why.
//
// TenantBackupArtifact.tables is intentionally loosely typed
// (Record<string, unknown[]>) rather than a fully-detailed per-table
// schema: the exact row shape for each of the ~20 tables it can hold is
// an implementation detail of tenant-backup-store.ts's export/restore
// logic, not something every caller of this shared domain type needs to
// know.
export const tenantBackupArtifactSchema = z.object({
    organizationId: z.string().uuid(),
    exportedAt: z.string(),
    tables: z.record(z.string(), z.array(z.unknown())),
});
export type TenantBackupArtifact = z.infer<typeof tenantBackupArtifactSchema>;

export const tenantRestoreRequestStatusSchema = z.enum(["pending", "approved", "rejected", "completed", "failed"]);
export type TenantRestoreRequestStatus = z.infer<typeof tenantRestoreRequestStatusSchema>;

// Deliberately excludes the artifact itself (potentially a large JSONB
// blob covering an entire tenant) — a list/status view has no need to
// echo it back over HTTP. Only proposeRestore (the client sends it once)
// and the store's own internal approveRestore (reads its own already-
// stored copy to execute) ever touch the full artifact.
//
// summary's {willInsert, alreadyPresent} (not "toUpdate") reflects restore's
// actual semantics: every table is restored via INSERT ... ON CONFLICT DO
// NOTHING — recovering rows that are missing, never overwriting one that
// already exists (see tenant-backup-store.ts's own doc comment for why:
// restore recovers lost data, it does not roll back legitimate changes
// made after the backup, and several tables — authorization_epochs,
// audit_log — would have real correctness/compliance risks if restore
// could regress them).
export const tenantRestoreRequestSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    status: tenantRestoreRequestStatusSchema,
    summary: z.record(z.string(), z.object({ willInsert: z.number().int(), alreadyPresent: z.number().int() })),
    requestedByUserId: z.string().uuid(),
    requestedAt: z.string(),
    decidedByUserId: z.string().uuid().optional(),
    decidedAt: z.string().optional(),
    rejectionReason: z.string().optional(),
    completedAt: z.string().optional(),
    errorMessage: z.string().optional(),
});
export type TenantRestoreRequest = z.infer<typeof tenantRestoreRequestSchema>;

export type AuthorizationPrincipal =
    | (User & { principalType: "human" })
    | (ServicePrincipal & { principalType: "service"; groupIds: [] });

// What a caller sends to POST /authz/check (and what internal route guards
// build for themselves) — the actual authorization question being asked.
// `context` is caller-supplied additional condition-matching data (e.g.
// resource attributes); server-derived context (user:id, user:organizationId)
// is merged in by the route handler, never trusted from the request body,
// so a caller cannot claim to be a different user or organization than the
// bearer token it authenticated with.
export const authorizationRequestSchema = z.object({
    action: z.string().min(1),
    resource: z.string().min(1),
    context: z.record(z.string(), z.string()).optional(),
});
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
