import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
    AccessReviewCampaign,
    AccessReviewDecision,
    AccessReviewItem,
    BreakGlassGrant,
    BreakGlassReviewOutcome,
    Membership,
    PolicyDocument,
    PolicyVersion,
    PolicyVersionStatus,
} from "../domain/types.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import type { AccessGovernanceStore } from "./access-governance-store.js";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface GrantRow {
    id: string; organization_id: string; user_id: string; emergency_policy_id: string; justification: string;
    granted_at: Date; expires_at: Date; reviewed_by_user_id: string | null; reviewed_at: Date | null; review_outcome: BreakGlassReviewOutcome | null;
}
interface CampaignRow {
    id: string; organization_id: string; created_by_user_id: string; status: AccessReviewCampaign["status"]; created_at: Date; completed_at: Date | null;
    item_count: string; decided_count: string;
}
interface ItemRow {
    id: string; campaign_id: string; organization_id: string; membership_id: string; subject_user_id: string;
    decision: AccessReviewDecision; decided_by_user_id: string | null; decided_at: Date | null; created_at: Date;
}
interface PolicyVersionRow {
    id: string; policy_id: string; organization_id: string; version: number; document: PolicyDocument; content_hash: string;
    status: PolicyVersionStatus; proposed_by_user_id: string; proposed_at: Date; decided_by_user_id: string | null; decided_at: Date | null;
    rejection_reason: string | null;
}
function mapPolicyVersion(row: PolicyVersionRow): PolicyVersion {
    return {
        id: row.id, policyId: row.policy_id, organizationId: row.organization_id, version: row.version, document: row.document,
        contentHash: row.content_hash, status: row.status, proposedByUserId: row.proposed_by_user_id, proposedAt: row.proposed_at.toISOString(),
        decidedByUserId: row.decided_by_user_id ?? undefined, decidedAt: row.decided_at?.toISOString(), rejectionReason: row.rejection_reason ?? undefined,
    };
}

function mapGrant(row: GrantRow): BreakGlassGrant {
    const reviewedAt = row.reviewed_at?.toISOString();
    return {
        id: row.id, organizationId: row.organization_id, userId: row.user_id, emergencyPolicyId: row.emergency_policy_id,
        justification: row.justification, grantedAt: row.granted_at.toISOString(), expiresAt: row.expires_at.toISOString(),
        status: reviewedAt ? "reviewed" : row.expires_at.toISOString() <= new Date().toISOString() ? "expired" : "active",
        reviewedByUserId: row.reviewed_by_user_id ?? undefined, reviewedAt, reviewOutcome: row.review_outcome ?? undefined,
    };
}
function mapCampaign(row: CampaignRow): AccessReviewCampaign {
    return {
        id: row.id, organizationId: row.organization_id, createdByUserId: row.created_by_user_id, status: row.status,
        createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString(),
        itemCount: Number(row.item_count), decidedCount: Number(row.decided_count),
    };
}
function mapItem(row: ItemRow): AccessReviewItem {
    return {
        id: row.id, campaignId: row.campaign_id, organizationId: row.organization_id, membershipId: row.membership_id,
        subjectUserId: row.subject_user_id, decision: row.decision, decidedByUserId: row.decided_by_user_id ?? undefined,
        decidedAt: row.decided_at?.toISOString(), createdAt: row.created_at.toISOString(),
    };
}

const CAMPAIGN_SELECT = `
    SELECT c.*, COUNT(i.id)::int AS item_count, COUNT(i.id) FILTER (WHERE i.decision != 'pending')::int AS decided_count
    FROM access_review_campaigns c
    LEFT JOIN access_review_items i ON i.campaign_id = c.id
`;

export class PostgresAccessGovernanceStore implements AccessGovernanceStore {
    constructor(private readonly pool: Pool) {}

    private async tenantRead<T>(organizationId: string, query: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const result = await query(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async invokeBreakGlass(
        input: { organizationId: string; userId: string; emergencyPolicyId: string; justification: string; durationMs: number },
        actor: AuditActor
    ): Promise<BreakGlassGrant> {
        return this.tenantRead(input.organizationId, async (client) => {
            const id = randomUUID();
            const grantedAt = new Date();
            const expiresAt = new Date(grantedAt.getTime() + input.durationMs);
            const result = await client.query<GrantRow>(
                `INSERT INTO break_glass_grants (id, organization_id, user_id, emergency_policy_id, justification, granted_at, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [id, input.organizationId, input.userId, input.emergencyPolicyId, input.justification, grantedAt, expiresAt]
            );
            await insertAuditEntry(client, {
                organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "breakGlass.invoke", targetType: "breakGlassGrant", targetId: id,
                details: { justification: input.justification, emergencyPolicyId: input.emergencyPolicyId, expiresAt: expiresAt.toISOString() },
            });
            return mapGrant(result.rows[0]);
        });
    }

    async getActiveBreakGlassGrant(organizationId: string, userId: string): Promise<BreakGlassGrant | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<GrantRow>(
                `SELECT * FROM break_glass_grants WHERE organization_id=$1 AND user_id=$2 AND reviewed_at IS NULL AND expires_at > now() ORDER BY granted_at DESC LIMIT 1`,
                [organizationId, userId]
            );
            return result.rows[0] ? mapGrant(result.rows[0]) : null;
        });
    }

    async listBreakGlassGrants(organizationId: string): Promise<BreakGlassGrant[]> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<GrantRow>("SELECT * FROM break_glass_grants WHERE organization_id=$1 ORDER BY granted_at DESC", [organizationId]);
            return result.rows.map(mapGrant);
        });
    }

    async getBreakGlassGrant(organizationId: string, grantId: string): Promise<BreakGlassGrant | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<GrantRow>("SELECT * FROM break_glass_grants WHERE organization_id=$1 AND id=$2", [organizationId, grantId]);
            return result.rows[0] ? mapGrant(result.rows[0]) : null;
        });
    }

    async reviewBreakGlassGrant(organizationId: string, grantId: string, outcome: BreakGlassReviewOutcome, actor: AuditActor): Promise<BreakGlassGrant | null> {
        return this.tenantRead(organizationId, async (client) => {
            const existing = await client.query<GrantRow>("SELECT * FROM break_glass_grants WHERE organization_id=$1 AND id=$2", [organizationId, grantId]);
            if (!existing.rows[0] || existing.rows[0].reviewed_at) return null;
            const now = new Date();
            const result = await client.query<GrantRow>(
                "UPDATE break_glass_grants SET reviewed_by_user_id=$3, reviewed_at=$4, review_outcome=$5 WHERE organization_id=$1 AND id=$2 RETURNING *",
                [organizationId, grantId, actor.userId ?? null, now, outcome]
            );
            const grant = existing.rows[0];
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "breakGlass.review", targetType: "breakGlassGrant", targetId: grantId,
                details: { outcome, grantUserId: grant.user_id, originalJustification: grant.justification, grantExpiresAt: grant.expires_at.toISOString() },
            });
            return mapGrant(result.rows[0]);
        });
    }

    async createAccessReviewCampaign(
        input: { organizationId: string; createdByUserId: string; memberships: Pick<Membership, "id" | "userId">[] },
        actor: AuditActor
    ): Promise<AccessReviewCampaign> {
        return this.tenantRead(input.organizationId, async (client) => {
            const id = randomUUID();
            const itemCount = input.memberships.length;
            const status = itemCount === 0 ? "completed" : "open";
            const now = new Date();
            await client.query(
                `INSERT INTO access_review_campaigns (id, organization_id, created_by_user_id, status, created_at, completed_at)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [id, input.organizationId, input.createdByUserId, status, now, itemCount === 0 ? now : null]
            );
            for (const membership of input.memberships) {
                await client.query(
                    `INSERT INTO access_review_items (id, campaign_id, organization_id, membership_id, subject_user_id, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6)`,
                    [randomUUID(), id, input.organizationId, membership.id, membership.userId, now]
                );
            }
            await insertAuditEntry(client, {
                organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "accessReview.campaignCreate", targetType: "accessReviewCampaign", targetId: id, details: { itemCount },
            });
            if (itemCount === 0) {
                await insertAuditEntry(client, {
                    organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                    action: "accessReview.campaignComplete", targetType: "accessReviewCampaign", targetId: id,
                    details: { itemCount: 0, keepCount: 0, revokeCount: 0 },
                });
            }
            const result = await client.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.id=$1 GROUP BY c.id`, [id]);
            return mapCampaign(result.rows[0]);
        });
    }

    async listAccessReviewCampaigns(organizationId: string): Promise<AccessReviewCampaign[]> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.organization_id=$1 GROUP BY c.id ORDER BY c.created_at DESC`, [organizationId]);
            return result.rows.map(mapCampaign);
        });
    }

    async getAccessReviewCampaign(organizationId: string, campaignId: string): Promise<AccessReviewCampaign | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.organization_id=$1 AND c.id=$2 GROUP BY c.id`, [organizationId, campaignId]);
            return result.rows[0] ? mapCampaign(result.rows[0]) : null;
        });
    }

    async listAccessReviewItems(organizationId: string, campaignId: string): Promise<AccessReviewItem[]> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<ItemRow>(
                "SELECT * FROM access_review_items WHERE organization_id=$1 AND campaign_id=$2 ORDER BY created_at",
                [organizationId, campaignId]
            );
            return result.rows.map(mapItem);
        });
    }

    async getAccessReviewItem(organizationId: string, campaignId: string, itemId: string): Promise<AccessReviewItem | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<ItemRow>(
                "SELECT * FROM access_review_items WHERE organization_id=$1 AND campaign_id=$2 AND id=$3",
                [organizationId, campaignId, itemId]
            );
            return result.rows[0] ? mapItem(result.rows[0]) : null;
        });
    }

    async decideAccessReviewItem(
        organizationId: string,
        campaignId: string,
        itemId: string,
        decision: Exclude<AccessReviewDecision, "pending">,
        actor: AuditActor
    ): Promise<AccessReviewItem | null> {
        return this.tenantRead(organizationId, async (client) => {
            const now = new Date();
            const updated = await client.query<ItemRow>(
                `UPDATE access_review_items SET decision=$4, decided_by_user_id=$5, decided_at=$6
                 WHERE organization_id=$1 AND campaign_id=$2 AND id=$3 AND decision='pending' RETURNING *`,
                [organizationId, campaignId, itemId, decision, actor.userId ?? null, now]
            );
            if (!updated.rows[0]) return null;
            const item = updated.rows[0];
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "accessReview.itemDecide", targetType: "accessReviewItem", targetId: itemId,
                details: { campaignId, membershipId: item.membership_id, subjectUserId: item.subject_user_id, decision },
            });

            const remaining = await client.query<{ pending: string; keep: string; revoke: string; total: string }>(
                `SELECT COUNT(*) FILTER (WHERE decision='pending')::text AS pending,
                        COUNT(*) FILTER (WHERE decision='keep')::text AS keep,
                        COUNT(*) FILTER (WHERE decision='revoke')::text AS revoke,
                        COUNT(*)::text AS total
                 FROM access_review_items WHERE campaign_id=$1`,
                [campaignId]
            );
            const counts = remaining.rows[0];
            if (Number(counts.pending) === 0) {
                const completed = await client.query(
                    "UPDATE access_review_campaigns SET status='completed', completed_at=$2 WHERE id=$1 AND status='open'",
                    [campaignId, now]
                );
                if ((completed.rowCount ?? 0) > 0) {
                    await insertAuditEntry(client, {
                        organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                        action: "accessReview.campaignComplete", targetType: "accessReviewCampaign", targetId: campaignId,
                        details: { itemCount: Number(counts.total), keepCount: Number(counts.keep), revokeCount: Number(counts.revoke) },
                    });
                }
            }
            return mapItem(item);
        });
    }

    async proposePolicyVersion(
        input: { organizationId: string; policyId: string; document: PolicyDocument; proposedByUserId: string },
        actor: AuditActor
    ): Promise<PolicyVersion> {
        return this.tenantRead(input.organizationId, async (client) => {
            // Locks the policy row itself to serialize concurrent proposals
            // against the same policy — cheap (one row, already indexed by
            // primary key), and avoids two concurrent proposals computing
            // the same "next version" number.
            await client.query("SELECT id FROM policies WHERE id=$1 FOR UPDATE", [input.policyId]);
            const nextVersion = await client.query<{ next: string }>(
                "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM policy_versions WHERE policy_id=$1",
                [input.policyId]
            );
            const id = randomUUID();
            const now = new Date();
            const contentHash = digest(input.document);
            const result = await client.query<PolicyVersionRow>(
                `INSERT INTO policy_versions (id, policy_id, organization_id, version, document, content_hash, status, proposed_by_user_id, proposed_at)
                 VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING *`,
                [id, input.policyId, input.organizationId, Number(nextVersion.rows[0].next), JSON.stringify(input.document), contentHash, input.proposedByUserId, now]
            );
            await insertAuditEntry(client, {
                organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "policyVersion.propose", targetType: "policyVersion", targetId: id,
                details: { policyId: input.policyId, version: Number(nextVersion.rows[0].next), contentHash },
            });
            return mapPolicyVersion(result.rows[0]);
        });
    }

    async listPolicyVersions(organizationId: string, policyId: string): Promise<PolicyVersion[]> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<PolicyVersionRow>(
                "SELECT * FROM policy_versions WHERE organization_id=$1 AND policy_id=$2 ORDER BY version DESC",
                [organizationId, policyId]
            );
            return result.rows.map(mapPolicyVersion);
        });
    }

    async getPolicyVersion(organizationId: string, policyId: string, versionId: string): Promise<PolicyVersion | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<PolicyVersionRow>(
                "SELECT * FROM policy_versions WHERE organization_id=$1 AND policy_id=$2 AND id=$3",
                [organizationId, policyId, versionId]
            );
            return result.rows[0] ? mapPolicyVersion(result.rows[0]) : null;
        });
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
        return this.tenantRead(organizationId, async (client) => {
            const target = await client.query<PolicyVersionRow>(
                "SELECT * FROM policy_versions WHERE organization_id=$1 AND policy_id=$2 AND id=$3 AND status=$4 FOR UPDATE",
                [organizationId, policyId, versionId, requiredStatus]
            );
            if (!target.rows[0]) return null;
            const currentlyApproved = await client.query<PolicyVersionRow>(
                "SELECT * FROM policy_versions WHERE policy_id=$1 AND status='approved'",
                [policyId]
            );
            if (currentlyApproved.rows[0]) {
                await client.query("UPDATE policy_versions SET status='superseded' WHERE id=$1", [currentlyApproved.rows[0].id]);
            }
            const now = new Date();
            const activated = await client.query<PolicyVersionRow>(
                "UPDATE policy_versions SET status='approved', decided_by_user_id=$2, decided_at=$3 WHERE id=$1 RETURNING *",
                [versionId, actor.userId ?? null, now]
            );
            const row = target.rows[0];
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: auditAction, targetType: "policyVersion", targetId: versionId,
                details:
                    auditAction === "policyVersion.approve"
                        ? { policyId, version: row.version, contentHash: row.content_hash }
                        : { policyId, fromVersion: currentlyApproved.rows[0]?.version, toVersion: row.version },
            });
            return mapPolicyVersion(activated.rows[0]);
        });
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
        return this.tenantRead(organizationId, async (client) => {
            const existing = await client.query<PolicyVersionRow>(
                "SELECT * FROM policy_versions WHERE organization_id=$1 AND policy_id=$2 AND id=$3 AND status='pending'",
                [organizationId, policyId, versionId]
            );
            if (!existing.rows[0]) return null;
            const now = new Date();
            const result = await client.query<PolicyVersionRow>(
                "UPDATE policy_versions SET status='rejected', decided_by_user_id=$2, decided_at=$3, rejection_reason=$4 WHERE id=$1 RETURNING *",
                [versionId, actor.userId ?? null, now, reason ?? null]
            );
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "policyVersion.reject", targetType: "policyVersion", targetId: versionId,
                details: { policyId, version: existing.rows[0].version, reason },
            });
            return mapPolicyVersion(result.rows[0]);
        });
    }

    async rollbackToPolicyVersion(organizationId: string, policyId: string, versionId: string, actor: AuditActor): Promise<PolicyVersion | null> {
        return this.activateVersion(organizationId, policyId, versionId, "superseded", "policyVersion.rollback", actor);
    }
}
