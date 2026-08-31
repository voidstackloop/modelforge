import { matchesPattern } from "./policy-evaluator.js";

/**
 * Versioned, canonical catalog of every action string this server's route
 * layer actually checks via requirePermission/isPermissionAllowed —
 * docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md P0 item 10 ("Version the action
 * and resource-type catalog"). Built FROM the real call sites (every
 * `requirePermission`/`isPermissionAllowed` call across server/src/routes/
 * as of this catalog's version date), not designed in the abstract — every
 * entry here corresponds to an action the server genuinely enforces
 * somewhere. If a route ever adds a new action string, add it here in the
 * same change — nothing enforces that automatically, this file is the
 * canonical list precisely because there is exactly one of it.
 *
 * Two jobs, both advisory:
 *  1. Documentation/discoverability — one place to see every action a
 *     policy statement can meaningfully reference, instead of grepping
 *     route files. Exposed to callers with iam:listPolicies via GET
 *     /organizations/:organizationId/action-catalog for the admin
 *     console's policy editor.
 *  2. Typo defense — routes/policies.ts (POST/PATCH) and
 *     routes/policy-versions.ts (propose) call
 *     unknownActionPatterns(document) on a submitted policy and reject the
 *     request (400) if it references a pattern that cannot match anything
 *     real, catching a misspelled action at authoring time instead of it
 *     silently never matching any actual requirePermission() check.
 *
 * Deliberately NOT wired into policyDocumentSchema itself (domain/types.ts)
 * and NOT consulted by requirePermission/isPermissionAllowed at request
 * time: the actual security decision always stays in
 * policy-evaluator.ts's evaluatePolicies against whatever literal string
 * each route hands it, matching that file's own "the single place this
 * system's actual security guarantee lives" doc comment. A gap or bug in
 * this catalog can therefore never itself grant or deny a real request —
 * at worst it makes a legitimately-matching typo-defense check too
 * strict/loose, never a live authorization outcome. Kept out of the schema
 * for the same reason it's only called from the three user-facing routes
 * above, not from anywhere internal (builtin-policies.ts's server-
 * constructed OrganizationAdmin policy, or unit tests exercising the
 * evaluator's matching logic directly with arbitrary test action strings):
 * this is a boundary check on external input, not a general-purpose
 * constraint on every PolicyDocument this codebase ever constructs.
 */
export const ACTION_CATALOG_VERSION = "2026-08-30c";

export interface ActionCatalogEntry {
    action: string;
    description: string;
}

export const ACTION_CATALOG: readonly ActionCatalogEntry[] = [
    // Identity & access management
    { action: "iam:listUsers", description: "List users, invitations, and service principals in an organization." },
    { action: "iam:manageUsers", description: "Create/update users, service principals, and invitations. Attaching policyIds/permissionBoundaryPolicyId to one also requires iam:managePolicies." },
    { action: "iam:listGroups", description: "List groups." },
    { action: "iam:manageGroups", description: "Create/update groups and their membership. Attaching a policyId also requires iam:managePolicies." },
    { action: "iam:listPolicies", description: "List policies and policy-version history." },
    { action: "iam:managePolicies", description: "Create/update/delete policies directly, and attach a policyId/permissionBoundaryPolicyId to a user or group. Bypasses the policy:propose/policy:approve dual-control workflow below — see routes/policies.ts's own doc comment." },

    // Policy versioning / dual control (routes/policy-versions.ts)
    { action: "policy:propose", description: "Propose a new PolicyVersion for dual-control review." },
    { action: "policy:approve", description: "Approve, reject, or roll back a proposed PolicyVersion. Self-approval of one's own proposal is always rejected server-side regardless of this grant." },

    // Patient cases (routes/cases.ts, routes/case-migrations.ts)
    { action: "patientCase:view", description: "Read a patient case." },
    { action: "patientCase:create", description: "Create a new patient case." },
    { action: "patientCase:edit", description: "Edit an existing patient case." },
    { action: "patientCase:delete", description: "Delete a patient case." },
    { action: "patientCase:manageAccess", description: "Change a case's owner/workspace/department/assignedUserIds/consent scopes." },
    { action: "patientCase:migrate", description: "Run a staged local-to-shared case migration (stage/validate/activate/rollback)." },

    // Shared chat sessions (routes/sessions.ts)
    { action: "chatSession:view", description: "Read a shared chat session." },
    { action: "chatSession:create", description: "Create a new shared chat session." },
    { action: "chatSession:edit", description: "Edit an existing shared chat session." },
    { action: "chatSession:delete", description: "Delete a shared chat session." },
    { action: "chatSession:manageAccess", description: "Change a session's assignedUserIds." },

    // Audit (routes/audit.ts)
    { action: "audit:read", description: "Read/search/export the organization's audit trail, and verify its hash chain." },
    { action: "audit:manageLegalHold", description: "Place or release a legal hold on the audit trail." },
    { action: "audit:exportSiem", description: "Pull the audit trail as a machine-consumption feed for an external SIEM, separate from audit:read's human-review search/CSV export." },

    // Break-glass (routes/break-glass.ts)
    { action: "breakGlass:invoke", description: "Self-invoke an emergency-access grant against the org's configured emergency policy." },
    { action: "breakGlass:list", description: "List break-glass grants." },
    { action: "breakGlass:review", description: "Record the mandatory post-hoc review of a break-glass grant. Also gated on iam:managePolicies for configuring the emergency policy itself." },

    // Access reviews (routes/access-reviews.ts)
    { action: "accessReview:manage", description: "Create/complete access-review campaigns." },
    { action: "accessReview:list", description: "List campaigns and their items." },
    { action: "accessReview:decide", description: "Decide an access-review item. Deciding an item for one's own membership is always rejected server-side regardless of this grant." },

    // Tenant backup/restore (routes/tenant-backup.ts)
    { action: "tenantBackup:export", description: "Export a tenant data backup artifact." },
    { action: "tenantBackup:proposeRestore", description: "Propose a dual-control tenant restore from a backup artifact." },
    { action: "tenantBackup:approveRestore", description: "Approve or reject a proposed tenant restore. Self-approval is always rejected server-side regardless of this grant." },

    // SCIM provisioning (routes/scim-tokens.ts) — the SCIM protocol
    // endpoints themselves (routes/scim.ts) are authorized by possessing a
    // valid SCIM bearer token, not by this action; this one gates only the
    // OIDC-authenticated admin operations of creating/listing/revoking
    // those tokens.
    { action: "scim:manageTokens", description: "Create, list, and revoke SCIM bearer tokens for external IdP provisioning connectors." },

    // Clinical imaging (routes/imaging-*.ts) — X-ray/MRI/CT/ultrasound and
    // related diagnostic imaging. See docs/IMAGING.md.
    { action: "imagingStudy:view", description: "View an imaging study's metadata, series, and instance list." },
    { action: "imagingStudy:manageAccess", description: "Change a study's sensitivity, workspace/department, or assignedUserIds." },
    { action: "imagingStudy:ingest", description: "Upload/import DICOM objects and manage the ingestion pipeline, including resolving ambiguous patient matches." },
    { action: "imagingInstance:retrieve", description: "Retrieve DICOM pixel data (WADO-RS) or a thumbnail for an instance — gated separately from imagingStudy:view since it is the actual PHI-bearing pixel access." },
    { action: "imagingAnnotation:create", description: "Create a measurement/note/region annotation on a study." },
    { action: "diagnosticReport:view", description: "View a study's diagnostic report(s), including amendment history." },
    { action: "diagnosticReport:author", description: "Create/amend/correct a diagnostic report." },
    { action: "diagnosticReport:sign", description: "Sign a diagnostic report, attributing final authorship." },
    { action: "diagnosticReport:acknowledgeCritical", description: "Acknowledge a critical-result report." },
    { action: "imagingShare:manage", description: "Create and revoke internal/cross-organization/external-portal share grants for imaging studies." },
    { action: "imagingDeidentification:request", description: "Request a de-identified copy-on-export for research/teaching/external-export." },
    { action: "imagingDeidentification:review", description: "Approve or reject a de-identification job flagged for mandatory human review." },

    // ClinicalAiGateway (server/src/ai-gateway/, routes/ai-gateway.ts) — the
    // sole path by which patient data reaches an AI model. See
    // docs/CLINICAL_AI_GATEWAY.md. These actions gate "can this user use
    // the gateway at all" — the separate, non-IAM concerns of consent and
    // per-tenant provider/model approval are enforced in
    // ai-gateway/policy.ts, not by these actions.
    { action: "aiGateway:invoke", description: "Create an AI request envelope and submit it for a patient case — the core clinical-AI-assistance action." },
    { action: "aiGateway:review", description: "Review, accept, reject, correct, or escalate a draft AI output." },
    { action: "aiGateway:viewAuditTrail", description: "View the full request/output/review/safety-event history for a patient case's AI usage." },
    { action: "aiGateway:manageProviders", description: "Create/update providers and models in the global catalog, and engage/disengage a provider's kill switch." },
    { action: "aiGateway:manageTenantSettings", description: "Approve a provider/model for this tenant, including whether PHI may be sent to it." },
    { action: "aiGateway:manageConsent", description: "Grant or revoke a patient's AI-use consent record." },

    // Institutional MCP registry (routes/mcp-registry.ts) — a centrally
    // administered allowlist of MCP servers/tools a managed-mode desktop
    // app may fetch and enforce locally; see store/mcp-registry-store.ts's
    // doc comment for the enforcement scope boundary.
    { action: "mcpRegistry:list", description: "List the organization's registered MCP servers and their allowlisted tools/egress policy." },
    { action: "mcpRegistry:manage", description: "Create, update, or enable/disable an entry in the organization's MCP server registry." },

    // Hybrid CPU/GPU control plane (routes/compute-control.ts).
    { action: "compute:list", description: "Read compute nodes, pools, policies, requests, leases, and PHI-free capacity summaries." },
    { action: "compute:manageNodes", description: "Enroll, cordon, drain, or restore compute nodes." },
    { action: "compute:managePools", description: "Create and update regional compute pools and membership." },
    { action: "compute:managePolicies", description: "Create and activate signed CPU/GPU resource guardrail policies." },
    { action: "compute:manageCritical", description: "Perform high-impact compute operations including quarantine and hard quota changes; intended for step-up or break-glass policies." },
    { action: "compute:submit", description: "Submit and cancel organization compute workloads." },
    { action: "compute:agent", description: "Send node heartbeats and acknowledge, renew, or release fenced leases from an enrolled node agent." },
] as const;

const ACTION_STRINGS = new Set(ACTION_CATALOG.map((entry) => entry.action));

/**
 * Whether `pattern` (one entry from a policy statement's `actions` array)
 * could ever match a real, catalogued action. Exact catalog membership
 * always passes; a wildcard pattern (e.g. "*", "iam:*") passes if it
 * matches at least one catalog entry, using policy-evaluator.ts's own
 * matchesPattern — imported directly, not reimplemented, so this can never
 * silently drift from what a real authorization check actually does.
 */
export function isKnownActionPattern(pattern: string): boolean {
    if (ACTION_STRINGS.has(pattern)) return true;
    return ACTION_CATALOG.some((entry) => matchesPattern(pattern, entry.action));
}

/** Every pattern across every statement in `document` that isn't a known
 * action or a wildcard matching one — routes/policies.ts and
 * routes/policy-versions.ts reject a submission with any entries here. */
export function unknownActionPatterns(document: { statements: readonly { actions: readonly string[] }[] }): string[] {
    const unknown = new Set<string>();
    for (const statement of document.statements) {
        for (const pattern of statement.actions) {
            if (!isKnownActionPattern(pattern)) unknown.add(pattern);
        }
    }
    return [...unknown];
}

/**
 * Resource-type templates, for documentation only — never validated
 * against (see file doc comment on why the resources side deliberately
 * stops at documentation: a concrete resource string always embeds a
 * caller-supplied id, e.g. `organization:{organizationId}/patientCase:
 * {caseId}`, so there is no fixed catalog of *values* to check membership
 * against, only shapes). `{param}` segments are illustrative, not part of
 * the literal pattern syntax policy-evaluator.ts's matchesPattern
 * understands (which only ever sees `*` as a wildcard).
 */
export interface ResourceTypeCatalogEntry {
    template: string;
    description: string;
}

export const RESOURCE_TYPE_CATALOG: readonly ResourceTypeCatalogEntry[] = [
    { template: "organization:{organizationId}", description: "The organization itself — iam:list*/iam:manage* actions." },
    { template: "organization:{organizationId}/patientCase:{caseId}", description: "One patient case." },
    { template: "organization:{organizationId}/patientCase:*", description: "Every patient case in the organization." },
    { template: "organization:{organizationId}/chatSession:{sessionId}", description: "One shared chat session." },
    { template: "organization:{organizationId}/chatSession:*", description: "Every shared chat session in the organization." },
    { template: "organization:{organizationId}/computeNode:{nodeId}", description: "One enrolled compute node." },
    { template: "organization:{organizationId}/computePool:{poolId}", description: "One regional compute pool." },
    { template: "organization:{organizationId}/computeRequest:{requestId}", description: "One scheduled compute workload." },
    { template: "organization:{organizationId}/computeLease:{leaseId}", description: "One fenced compute allocation lease." },
] as const;
