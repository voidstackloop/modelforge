import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Identity, Invitation, Membership, ServicePrincipal } from "../domain/types.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import type { PrincipalStore } from "./principal-store.js";

interface IdentityRow { id: string; issuer: string; subject: string; display_name: string; email: string | null; created_at: Date; updated_at: Date }
interface MembershipRow { id: string; organization_id: string; identity_id: string; user_id: string; status: Membership["status"]; provisioning_source: Membership["provisioningSource"]; starts_at: Date; expires_at: Date | null; created_at: Date; updated_at: Date }
interface InvitationRow { id: string; organization_id: string; email: string; display_name: string | null; status: Invitation["status"]; token_hash: string; invited_by_user_id: string; expires_at: Date; accepted_at: Date | null; created_at: Date; updated_at: Date }
interface ServicePrincipalRow { id: string; organization_id: string; issuer: string; external_subject: string; display_name: string; status: ServicePrincipal["status"]; policy_ids: string[]; permission_boundary_policy_id: string | null; created_at: Date; updated_at: Date }

const mapIdentity = (row: IdentityRow): Identity => ({ id: row.id, issuer: row.issuer, subject: row.subject, displayName: row.display_name, email: row.email ?? undefined, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const mapMembership = (row: MembershipRow): Membership => ({ id: row.id, organizationId: row.organization_id, identityId: row.identity_id, userId: row.user_id, status: row.status, provisioningSource: row.provisioning_source, startsAt: row.starts_at.toISOString(), expiresAt: row.expires_at?.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const mapInvitation = (row: InvitationRow): Invitation => ({ id: row.id, organizationId: row.organization_id, email: row.email, displayName: row.display_name ?? undefined, status: row.status, tokenHash: row.token_hash, invitedByUserId: row.invited_by_user_id, expiresAt: row.expires_at.toISOString(), acceptedAt: row.accepted_at?.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const mapServicePrincipal = (row: ServicePrincipalRow): ServicePrincipal => ({ id: row.id, organizationId: row.organization_id, issuer: row.issuer, externalSubject: row.external_subject, displayName: row.display_name, status: row.status, policyIds: row.policy_ids, permissionBoundaryPolicyId: row.permission_boundary_policy_id ?? undefined, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

export class PostgresPrincipalStore implements PrincipalStore {
    constructor(private readonly pool: Pool) {}

    private async tenantRead<T>(organizationId: string, query: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const result = await query(client);
            await client.query("COMMIT");
            return result;
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    async upsertIdentity(input: { issuer: string; subject: string; displayName: string; email?: string }): Promise<Identity> {
        const now = new Date();
        const result = await this.pool.query<IdentityRow>(
            `INSERT INTO identities (id, issuer, subject, display_name, email, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$6)
             ON CONFLICT (issuer, subject) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, updated_at = EXCLUDED.updated_at
             RETURNING *`,
            [randomUUID(), input.issuer, input.subject, input.displayName, input.email ?? null, now]
        );
        return mapIdentity(result.rows[0]);
    }
    async findIdentity(issuer: string, subject: string): Promise<Identity | null> { const result=await this.pool.query<IdentityRow>("SELECT * FROM identities WHERE issuer=$1 AND subject=$2",[issuer,subject]); return result.rows[0]?mapIdentity(result.rows[0]):null; }

    async ensureMembership(input: { organizationId: string; identityId: string; userId: string; provisioningSource: Membership["provisioningSource"]; expiresAt?: string }, actor: AuditActor): Promise<Membership> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.organizationId]);
            const now = new Date();
            const result = await client.query<MembershipRow>(
                `INSERT INTO memberships (id, organization_id, identity_id, user_id, status, provisioning_source, starts_at, expires_at, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$6,$6)
                 ON CONFLICT (organization_id, identity_id) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = EXCLUDED.updated_at
                 RETURNING *`,
                [randomUUID(), input.organizationId, input.identityId, input.userId, input.provisioningSource, now, input.expiresAt ? new Date(input.expiresAt) : null]
            );
            await insertAuditEntry(client, { organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "membership.create", targetType: "membership", targetId: result.rows[0].id });
            await client.query("COMMIT");
            return mapMembership(result.rows[0]);
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    async listMemberships(issuer: string, subject: string): Promise<Membership[]> {
        // Discovery is intentionally the one cross-tenant IAM query and is
        // keyed exclusively by a verified issuer+subject, never user input.
        const result = await this.pool.query<MembershipRow>(`SELECT * FROM list_memberships_for_identity($1,$2)`, [issuer, subject]);
        return result.rows.map(mapMembership);
    }

    async listMembershipsByOrganization(organizationId: string): Promise<Membership[]> {
        return this.tenantRead(organizationId, async (client) => (await client.query<MembershipRow>("SELECT * FROM memberships WHERE organization_id=$1 AND status='active' ORDER BY created_at", [organizationId])).rows.map(mapMembership));
    }

    async setMembershipStatus(organizationId: string, userId: string, status: Membership["status"], actor: AuditActor): Promise<Membership | null> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const result = await client.query<MembershipRow>("UPDATE memberships SET status=$3, updated_at=$4 WHERE organization_id=$1 AND user_id=$2 RETURNING *", [organizationId, userId, status, new Date()]);
            if (!result.rows[0]) { await client.query("ROLLBACK"); return null; }
            await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "membership.update", targetType: "membership", targetId: result.rows[0].id, details: { status } });
            await client.query("COMMIT");
            return mapMembership(result.rows[0]);
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    async createInvitation(input: { organizationId: string; email: string; displayName?: string; tokenHash: string; invitedByUserId: string; expiresAt: string }, actor: AuditActor): Promise<Invitation> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.organizationId]);
            const now = new Date();
            const result = await client.query<InvitationRow>(`INSERT INTO invitations (id,organization_id,email,display_name,status,token_hash,invited_by_user_id,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$8) RETURNING *`, [randomUUID(), input.organizationId, input.email, input.displayName ?? null, input.tokenHash, input.invitedByUserId, new Date(input.expiresAt), now]);
            await insertAuditEntry(client, { organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "invitation.create", targetType: "invitation", targetId: result.rows[0].id });
            await client.query("COMMIT"); return mapInvitation(result.rows[0]);
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    async listInvitations(organizationId: string): Promise<Invitation[]> { return this.tenantRead(organizationId, async (client) => (await client.query<InvitationRow>("SELECT * FROM invitations WHERE organization_id=$1 ORDER BY created_at DESC", [organizationId])).rows.map(mapInvitation)); }
    async getInvitation(organizationId: string, id: string): Promise<Invitation | null> { return this.tenantRead(organizationId, async (client) => { const result=await client.query<InvitationRow>("SELECT * FROM invitations WHERE organization_id=$1 AND id=$2", [organizationId,id]); return result.rows[0] ? mapInvitation(result.rows[0]) : null; }); }

    private async transitionInvitation(organizationId: string, id: string, actor: AuditActor, kind: "accept" | "revoke" | "revertAccept", tokenHash?: string): Promise<Invitation | null> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const now = new Date();
            const result = kind === "accept"
                ? await client.query<InvitationRow>(`UPDATE invitations SET status='accepted',accepted_at=$4,updated_at=$4 WHERE organization_id=$1 AND id=$2 AND status='pending' AND token_hash=$3 AND expires_at>$4 RETURNING *`, [organizationId,id,tokenHash,now])
                : kind === "revoke"
                ? await client.query<InvitationRow>(`UPDATE invitations SET status='revoked',updated_at=$3 WHERE organization_id=$1 AND id=$2 AND status='pending' RETURNING *`, [organizationId,id,now])
                : await client.query<InvitationRow>(`UPDATE invitations SET status='pending',accepted_at=NULL,updated_at=$3 WHERE organization_id=$1 AND id=$2 AND status='accepted' RETURNING *`, [organizationId,id,now]);
            if (!result.rows[0]) { await client.query("ROLLBACK"); return null; }
            await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: `invitation.${kind}`, targetType: "invitation", targetId: id });
            await client.query("COMMIT"); return mapInvitation(result.rows[0]);
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    acceptInvitation(organizationId: string, id: string, tokenHash: string, actor: AuditActor): Promise<Invitation | null> { return this.transitionInvitation(organizationId,id,actor,"accept",tokenHash); }
    revokeInvitation(organizationId: string, id: string, actor: AuditActor): Promise<Invitation | null> { return this.transitionInvitation(organizationId,id,actor,"revoke"); }
    async revertAcceptedInvitation(organizationId: string, id: string, actor: AuditActor): Promise<void> { await this.transitionInvitation(organizationId,id,actor,"revertAccept"); }

    async createServicePrincipal(input: { organizationId: string; issuer: string; externalSubject: string; displayName: string; policyIds?: string[]; permissionBoundaryPolicyId?: string }, actor: AuditActor): Promise<ServicePrincipal> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.organizationId]);
            const now = new Date();
            const result = await client.query<ServicePrincipalRow>(`INSERT INTO service_principals (id,organization_id,issuer,external_subject,display_name,status,policy_ids,permission_boundary_policy_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$8) RETURNING *`, [randomUUID(), input.organizationId, input.issuer, input.externalSubject, input.displayName, input.policyIds ?? [], input.permissionBoundaryPolicyId ?? null, now]);
            await insertAuditEntry(client, { organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "servicePrincipal.create", targetType: "servicePrincipal", targetId: result.rows[0].id });
            await client.query("COMMIT"); return mapServicePrincipal(result.rows[0]);
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    async findServicePrincipal(organizationId: string, issuer: string, externalSubject: string): Promise<ServicePrincipal | null> { return this.tenantRead(organizationId, async (client) => { const result=await client.query<ServicePrincipalRow>("SELECT * FROM service_principals WHERE organization_id=$1 AND issuer=$2 AND external_subject=$3", [organizationId,issuer,externalSubject]); return result.rows[0] ? mapServicePrincipal(result.rows[0]) : null; }); }
    async getServicePrincipal(organizationId: string, id: string): Promise<ServicePrincipal | null> { return this.tenantRead(organizationId, async (client) => { const result=await client.query<ServicePrincipalRow>("SELECT * FROM service_principals WHERE organization_id=$1 AND id=$2", [organizationId,id]); return result.rows[0] ? mapServicePrincipal(result.rows[0]) : null; }); }
    async listServicePrincipals(organizationId: string): Promise<ServicePrincipal[]> { return this.tenantRead(organizationId, async (client) => (await client.query<ServicePrincipalRow>("SELECT * FROM service_principals WHERE organization_id=$1 ORDER BY created_at", [organizationId])).rows.map(mapServicePrincipal)); }
    async updateServicePrincipal(organizationId: string, id: string, partial: Partial<Pick<ServicePrincipal, "displayName" | "status" | "policyIds" | "permissionBoundaryPolicyId">>, actor: AuditActor): Promise<ServicePrincipal | null> {
        const existing = await this.getServicePrincipal(organizationId,id); if (!existing) return null;
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const result = await client.query<ServicePrincipalRow>(`UPDATE service_principals SET display_name=$3,status=$4,policy_ids=$5,permission_boundary_policy_id=$6,updated_at=$7 WHERE organization_id=$1 AND id=$2 RETURNING *`, [organizationId,id,partial.displayName ?? existing.displayName,partial.status ?? existing.status,partial.policyIds ?? existing.policyIds,(partial.permissionBoundaryPolicyId ?? existing.permissionBoundaryPolicyId) ?? null,new Date()]);
            await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "servicePrincipal.update", targetType: "servicePrincipal", targetId: id, details: { fields: Object.keys(partial) } });
            await client.query("COMMIT"); return mapServicePrincipal(result.rows[0]);
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
}
