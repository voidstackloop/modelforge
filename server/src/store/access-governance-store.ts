import type {
    AccessReviewCampaign,
    AccessReviewDecision,
    AccessReviewItem,
    BreakGlassGrant,
    BreakGlassReviewOutcome,
    Membership,
    PolicyDocument,
    PolicyVersion,
} from "../domain/types.js";
import type { AuditActor } from "./audit-store.js";

/**
 * Break-glass emergency-access grants and admin-driven access-review
 * campaigns — grouped in one interface the same way principal-store.ts
 * groups several related lifecycle entities (Identity/Membership/
 * Invitation/ServicePrincipal) rather than one interface per entity, since
 * both are "access governance" concerns in the same sense. See
 * domain/types.ts's doc comments on BreakGlassGrant/AccessReviewCampaign
 * for the product decisions this shape encodes.
 */
export interface AccessGovernanceStore {
    invokeBreakGlass(
        input: { organizationId: string; userId: string; emergencyPolicyId: string; justification: string; durationMs: number },
        actor: AuditActor
    ): Promise<BreakGlassGrant>;
    /** The one query routes/guards.ts's requireOrgUser makes on every
     * authenticated request: does this user currently hold an active,
     * unreviewed grant. Most-recent match if somehow more than one
     * (shouldn't happen given invokeBreakGlass's own already-active check). */
    getActiveBreakGlassGrant(organizationId: string, userId: string): Promise<BreakGlassGrant | null>;
    listBreakGlassGrants(organizationId: string): Promise<BreakGlassGrant[]>;
    getBreakGlassGrant(organizationId: string, grantId: string): Promise<BreakGlassGrant | null>;
    /** Terminal transition — reviewedAt/reviewOutcome, once set, are never
     * changed again ("immutable evidence" per the roadmap). Returns null if
     * the grant doesn't exist or is already reviewed (routes/break-glass.ts
     * pre-checks the same thing for a clean 400 — this is defense in depth). */
    reviewBreakGlassGrant(organizationId: string, grantId: string, outcome: BreakGlassReviewOutcome, actor: AuditActor): Promise<BreakGlassGrant | null>;

    /** Snapshots the given (already org-filtered, already active-only)
     * memberships into a new campaign's items. A campaign with zero items
     * is created already `completed`. `createdByUserId` is passed
     * explicitly by the caller (routes/access-reviews.ts), matching
     * Invitation.invitedByUserId's existing pattern, rather than derived
     * from `actor.userId` here — AuditActor's userId is optional, but this
     * field is required. */
    createAccessReviewCampaign(
        input: { organizationId: string; createdByUserId: string; memberships: Pick<Membership, "id" | "userId">[] },
        actor: AuditActor
    ): Promise<AccessReviewCampaign>;
    listAccessReviewCampaigns(organizationId: string): Promise<AccessReviewCampaign[]>;
    getAccessReviewCampaign(organizationId: string, campaignId: string): Promise<AccessReviewCampaign | null>;
    listAccessReviewItems(organizationId: string, campaignId: string): Promise<AccessReviewItem[]>;
    getAccessReviewItem(organizationId: string, campaignId: string, itemId: string): Promise<AccessReviewItem | null>;
    /** Returns null if the item is already decided (routes/access-reviews.ts
     * pre-checks the self-decide guard itself — decidedByUserId === the
     * caller — before ever calling this, so that specific rejection never
     * reaches here). When this decision leaves zero 'pending' items in the
     * campaign, also flips the campaign to 'completed' and records a
     * second audit entry, in the same transaction. */
    decideAccessReviewItem(
        organizationId: string,
        campaignId: string,
        itemId: string,
        decision: Exclude<AccessReviewDecision, "pending">,
        actor: AuditActor
    ): Promise<AccessReviewItem | null>;

    /** Creates a new "pending" version for policyId, numbered one past
     * whatever the highest existing version for that policy is (1 if none
     * exist yet). Does not touch the live Policy.document — see
     * routes/policy-versions.ts for why applying it is a separate,
     * explicit approve step. */
    proposePolicyVersion(
        input: { organizationId: string; policyId: string; document: PolicyDocument; proposedByUserId: string },
        actor: AuditActor
    ): Promise<PolicyVersion>;
    listPolicyVersions(organizationId: string, policyId: string): Promise<PolicyVersion[]>;
    getPolicyVersion(organizationId: string, policyId: string, versionId: string): Promise<PolicyVersion | null>;
    /** Precondition: status "pending" (returns null otherwise — the route's
     * own pre-check gives a clean 400; this is defense in depth). Flips
     * whichever OTHER version of this policy currently holds "approved" to
     * "superseded" first, in the same transaction. Does NOT itself apply
     * the document to the live Policy — routes/policy-versions.ts calls
     * tenantStore.updatePolicy() for that, before calling this, so the
     * side effect that actually matters (the live policy changing) happens
     * even if recording the approval here were to fail. */
    approvePolicyVersion(organizationId: string, policyId: string, versionId: string, actor: AuditActor): Promise<PolicyVersion | null>;
    /** Precondition: status "pending". No live-policy side effect —
     * rejecting never changes what's currently active. */
    rejectPolicyVersion(organizationId: string, policyId: string, versionId: string, reason: string | undefined, actor: AuditActor): Promise<PolicyVersion | null>;
    /** Precondition: status "superseded" — you can only roll back to a
     * version that was previously actually active, never one that's
     * "pending" (never activated) or "rejected" (deliberately never
     * activated). Same supersede-the-current-approved-version bookkeeping
     * as approvePolicyVersion; same apply-then-record ordering in the
     * route. */
    rollbackToPolicyVersion(organizationId: string, policyId: string, versionId: string, actor: AuditActor): Promise<PolicyVersion | null>;
}
