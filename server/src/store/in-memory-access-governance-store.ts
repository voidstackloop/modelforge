import { createHash, randomUUID } from "node:crypto";
import type {
    AccessReviewCampaign,
    AccessReviewDecision,
    AccessReviewItem,
    BreakGlassGrant,
    BreakGlassGrantStatus,
    BreakGlassReviewOutcome,
    Membership,
    PolicyDocument,
    PolicyVersion,
} from "../domain/types.js";
import type { AccessGovernanceStore } from "./access-governance-store.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Stored without itemCount/decidedCount — those are computed fresh from
// access_review_items on every read (see hydrateCampaign), never a
// persisted running counter, to avoid an update-counter-on-every-decision
// race with concurrent decisions.
type StoredCampaign = Omit<AccessReviewCampaign, "itemCount" | "decidedCount">;

function computeBreakGlassStatus(grant: { expiresAt: string; reviewedAt?: string }): BreakGlassGrantStatus {
    if (grant.reviewedAt) return "reviewed";
    if (grant.expiresAt <= new Date().toISOString()) return "expired";
    return "active";
}

export class InMemoryAccessGovernanceStore implements AccessGovernanceStore {
    private readonly grants = new Map<string, BreakGlassGrant>();
    private readonly campaigns = new Map<string, StoredCampaign>();
    private readonly items = new Map<string, AccessReviewItem>();
    private readonly policyVersions = new Map<string, PolicyVersion>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    private hydrateCampaign(core: StoredCampaign): AccessReviewCampaign {
        const items = [...this.items.values()].filter((item) => item.campaignId === core.id);
        return { ...core, itemCount: items.length, decidedCount: items.filter((item) => item.decision !== "pending").length };
    }

    async invokeBreakGlass(
        input: { organizationId: string; userId: string; emergencyPolicyId: string; justification: string; durationMs: number },
        actor: AuditActor
    ): Promise<BreakGlassGrant> {
        const now = new Date();
        const grant: BreakGlassGrant = {
            id: randomUUID(),
            organizationId: input.organizationId,
            userId: input.userId,
            emergencyPolicyId: input.emergencyPolicyId,
            justification: input.justification,
            grantedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + input.durationMs).toISOString(),
            status: "active",
        };
        this.grants.set(grant.id, grant);
        await this.auditStore.record({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "breakGlass.invoke",
            targetType: "breakGlassGrant",
            targetId: grant.id,
            details: { justification: input.justification, emergencyPolicyId: input.emergencyPolicyId, expiresAt: grant.expiresAt },
        });
        return grant;
    }

    async getActiveBreakGlassGrant(organizationId: string, userId: string): Promise<BreakGlassGrant | null> {
        const now = new Date().toISOString();
        const candidates = [...this.grants.values()]
            .filter((g) => g.organizationId === organizationId && g.userId === userId && !g.reviewedAt && g.expiresAt > now)
            .sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1));
        return candidates[0] ?? null;
    }

    async listBreakGlassGrants(organizationId: string): Promise<BreakGlassGrant[]> {
        return [...this.grants.values()]
            .filter((g) => g.organizationId === organizationId)
            .map((g) => ({ ...g, status: computeBreakGlassStatus(g) }))
            .sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1));
    }

    async getBreakGlassGrant(organizationId: string, grantId: string): Promise<BreakGlassGrant | null> {
        const grant = this.grants.get(grantId);
        if (!grant || grant.organizationId !== organizationId) return null;
        return { ...grant, status: computeBreakGlassStatus(grant) };
    }

    async reviewBreakGlassGrant(
        organizationId: string,
        grantId: string,
        outcome: BreakGlassReviewOutcome,
        actor: AuditActor
    ): Promise<BreakGlassGrant | null> {
        const grant = this.grants.get(grantId);
        if (!grant || grant.organizationId !== organizationId || grant.reviewedAt) return null;
        const now = new Date().toISOString();
        const reviewed: BreakGlassGrant = { ...grant, status: "reviewed", reviewedByUserId: actor.userId, reviewedAt: now, reviewOutcome: outcome };
        this.grants.set(grantId, reviewed);
        await this.auditStore.record({
            organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "breakGlass.review",
            targetType: "breakGlassGrant",
            targetId: grantId,
            details: { outcome, grantUserId: grant.userId, originalJustification: grant.justification, grantExpiresAt: grant.expiresAt },
        });
        return reviewed;
    }

    async createAccessReviewCampaign(
        input: { organizationId: string; createdByUserId: string; memberships: Pick<Membership, "id" | "userId">[] },
        actor: AuditActor
    ): Promise<AccessReviewCampaign> {
        const now = new Date().toISOString();
        const campaignId = randomUUID();
        const itemCount = input.memberships.length;
        const core: StoredCampaign = {
            id: campaignId,
            organizationId: input.organizationId,
            createdByUserId: input.createdByUserId,
            status: itemCount === 0 ? "completed" : "open",
            createdAt: now,
            completedAt: itemCount === 0 ? now : undefined,
        };
        this.campaigns.set(campaignId, core);
        for (const membership of input.memberships) {
            const itemId = randomUUID();
            this.items.set(itemId, {
                id: itemId,
                campaignId,
                organizationId: input.organizationId,
                membershipId: membership.id,
                subjectUserId: membership.userId,
                decision: "pending",
                createdAt: now,
            });
        }
        await this.auditStore.record({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "accessReview.campaignCreate",
            targetType: "accessReviewCampaign",
            targetId: campaignId,
            details: { itemCount },
        });
        if (itemCount === 0) {
            await this.auditStore.record({
                organizationId: input.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "accessReview.campaignComplete",
                targetType: "accessReviewCampaign",
                targetId: campaignId,
                details: { itemCount: 0, keepCount: 0, revokeCount: 0 },
            });
        }
        return this.hydrateCampaign(core);
    }

    async listAccessReviewCampaigns(organizationId: string): Promise<AccessReviewCampaign[]> {
        return [...this.campaigns.values()]
            .filter((c) => c.organizationId === organizationId)
            .map((c) => this.hydrateCampaign(c))
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }

    async getAccessReviewCampaign(organizationId: string, campaignId: string): Promise<AccessReviewCampaign | null> {
        const core = this.campaigns.get(campaignId);
        if (!core || core.organizationId !== organizationId) return null;
        return this.hydrateCampaign(core);
    }

    async listAccessReviewItems(organizationId: string, campaignId: string): Promise<AccessReviewItem[]> {
        const campaign = this.campaigns.get(campaignId);
        if (!campaign || campaign.organizationId !== organizationId) return [];
        return [...this.items.values()].filter((item) => item.campaignId === campaignId);
    }

    async getAccessReviewItem(organizationId: string, campaignId: string, itemId: string): Promise<AccessReviewItem | null> {
        const item = this.items.get(itemId);
        if (!item || item.organizationId !== organizationId || item.campaignId !== campaignId) return null;
        return item;
    }

    async decideAccessReviewItem(
        organizationId: string,
        campaignId: string,
        itemId: string,
        decision: Exclude<AccessReviewDecision, "pending">,
        actor: AuditActor
    ): Promise<AccessReviewItem | null> {
        const item = this.items.get(itemId);
        if (!item || item.organizationId !== organizationId || item.campaignId !== campaignId || item.decision !== "pending") return null;
        const now = new Date().toISOString();
        const decided: AccessReviewItem = { ...item, decision, decidedByUserId: actor.userId, decidedAt: now };
        this.items.set(itemId, decided);
        await this.auditStore.record({
            organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "accessReview.itemDecide",
            targetType: "accessReviewItem",
            targetId: itemId,
            details: { campaignId, membershipId: item.membershipId, subjectUserId: item.subjectUserId, decision },
        });

        const siblingItems = [...this.items.values()].filter((sibling) => sibling.campaignId === campaignId);
        const campaign = this.campaigns.get(campaignId);
        if (campaign && campaign.status === "open" && !siblingItems.some((sibling) => sibling.decision === "pending")) {
            this.campaigns.set(campaignId, { ...campaign, status: "completed", completedAt: now });
            await this.auditStore.record({
                organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "accessReview.campaignComplete",
                targetType: "accessReviewCampaign",
                targetId: campaignId,
                details: {
                    itemCount: siblingItems.length,
                    keepCount: siblingItems.filter((sibling) => sibling.decision === "keep").length,
                    revokeCount: siblingItems.filter((sibling) => sibling.decision === "revoke").length,
                },
            });
        }
        return decided;
    }

    async proposePolicyVersion(
        input: { organizationId: string; policyId: string; document: PolicyDocument; proposedByUserId: string },
        actor: AuditActor
    ): Promise<PolicyVersion> {
        const existingVersions = [...this.policyVersions.values()].filter((v) => v.policyId === input.policyId);
        const nextVersion = existingVersions.length === 0 ? 1 : Math.max(...existingVersions.map((v) => v.version)) + 1;
        const version: PolicyVersion = {
            id: randomUUID(),
            policyId: input.policyId,
            organizationId: input.organizationId,
            version: nextVersion,
            document: input.document,
            contentHash: digest(input.document),
            status: "pending",
            proposedByUserId: input.proposedByUserId,
            proposedAt: new Date().toISOString(),
        };
        this.policyVersions.set(version.id, version);
        await this.auditStore.record({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "policyVersion.propose",
            targetType: "policyVersion",
            targetId: version.id,
            details: { policyId: input.policyId, version: nextVersion, contentHash: version.contentHash },
        });
        return version;
    }

    async listPolicyVersions(organizationId: string, policyId: string): Promise<PolicyVersion[]> {
        return [...this.policyVersions.values()]
            .filter((v) => v.organizationId === organizationId && v.policyId === policyId)
            .sort((a, b) => b.version - a.version);
    }

    async getPolicyVersion(organizationId: string, policyId: string, versionId: string): Promise<PolicyVersion | null> {
        const version = this.policyVersions.get(versionId);
        if (!version || version.organizationId !== organizationId || version.policyId !== policyId) return null;
        return version;
    }

    /** Shared by approvePolicyVersion/rollbackToPolicyVersion: both mean
     * "make this version the one active version," differing only in the
     * status a version must currently be in and the audit action name. */
    private async activateVersion(
        organizationId: string,
        policyId: string,
        versionId: string,
        requiredStatus: "pending" | "superseded",
        auditAction: "policyVersion.approve" | "policyVersion.rollback",
        actor: AuditActor
    ): Promise<PolicyVersion | null> {
        const target = this.policyVersions.get(versionId);
        if (!target || target.organizationId !== organizationId || target.policyId !== policyId || target.status !== requiredStatus) return null;
        const now = new Date().toISOString();
        const currentlyApproved = [...this.policyVersions.values()].find((v) => v.policyId === policyId && v.status === "approved");
        if (currentlyApproved) {
            this.policyVersions.set(currentlyApproved.id, { ...currentlyApproved, status: "superseded" });
        }
        const activated: PolicyVersion = { ...target, status: "approved", decidedByUserId: actor.userId, decidedAt: now };
        this.policyVersions.set(versionId, activated);
        await this.auditStore.record({
            organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: auditAction,
            targetType: "policyVersion",
            targetId: versionId,
            details:
                auditAction === "policyVersion.approve"
                    ? { policyId, version: target.version, contentHash: target.contentHash }
                    : { policyId, fromVersion: currentlyApproved?.version, toVersion: target.version },
        });
        return activated;
    }

    async approvePolicyVersion(organizationId: string, policyId: string, versionId: string, actor: AuditActor): Promise<PolicyVersion | null> {
        return this.activateVersion(organizationId, policyId, versionId, "pending", "policyVersion.approve", actor);
    }

    async rejectPolicyVersion(
        organizationId: string,
        policyId: string,
        versionId: string,
        reason: string | undefined,
        actor: AuditActor
    ): Promise<PolicyVersion | null> {
        const target = this.policyVersions.get(versionId);
        if (!target || target.organizationId !== organizationId || target.policyId !== policyId || target.status !== "pending") return null;
        const rejected: PolicyVersion = {
            ...target,
            status: "rejected",
            decidedByUserId: actor.userId,
            decidedAt: new Date().toISOString(),
            rejectionReason: reason,
        };
        this.policyVersions.set(versionId, rejected);
        await this.auditStore.record({
            organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "policyVersion.reject",
            targetType: "policyVersion",
            targetId: versionId,
            details: { policyId, version: target.version, reason },
        });
        return rejected;
    }

    async rollbackToPolicyVersion(organizationId: string, policyId: string, versionId: string, actor: AuditActor): Promise<PolicyVersion | null> {
        return this.activateVersion(organizationId, policyId, versionId, "superseded", "policyVersion.rollback", actor);
    }
}
