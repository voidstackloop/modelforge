import type { Identity, Invitation, Membership, ServicePrincipal } from "../domain/types.js";
import type { AuditActor } from "./audit-store.js";

export interface PrincipalStore {
    upsertIdentity(input: { issuer: string; subject: string; displayName: string; email?: string }): Promise<Identity>;
    findIdentity(issuer: string, subject: string): Promise<Identity | null>;
    ensureMembership(
        input: {
            organizationId: string;
            identityId: string;
            userId: string;
            provisioningSource: Membership["provisioningSource"];
            expiresAt?: string;
        },
        actor: AuditActor
    ): Promise<Membership>;
    listMemberships(issuer: string, subject: string): Promise<Membership[]>;
    /** Every active membership in this organization — used to snapshot an
     * access-review campaign's items (routes/access-reviews.ts) at creation
     * time. Unlike listMemberships above (keyed by one identity, across all
     * of its organizations), this is keyed by organization, across all of
     * its members. */
    listMembershipsByOrganization(organizationId: string): Promise<Membership[]>;
    setMembershipStatus(organizationId: string, userId: string, status: Membership["status"], actor: AuditActor): Promise<Membership | null>;

    createInvitation(
        input: { organizationId: string; email: string; displayName?: string; tokenHash: string; invitedByUserId: string; expiresAt: string },
        actor: AuditActor
    ): Promise<Invitation>;
    listInvitations(organizationId: string): Promise<Invitation[]>;
    getInvitation(organizationId: string, id: string): Promise<Invitation | null>;
    acceptInvitation(organizationId: string, id: string, tokenHash: string, actor: AuditActor): Promise<Invitation | null>;
    revokeInvitation(organizationId: string, id: string, actor: AuditActor): Promise<Invitation | null>;
    /**
     * Compensating cleanup for invitation acceptance failing partway
     * through — see routes/invitations.ts's accept handler. acceptInvitation
     * atomically transitions 'pending' -> 'accepted' and is deliberately the
     * *first* step (it also verifies the token), so a later failure creating
     * the User/Membership leaves an invitation permanently consumed with no
     * account ever created for it — the invitee is locked out with no way
     * to retry using the same link. Reverting back to 'pending' (only when
     * currently 'accepted', never touching a 'revoked'/'expired' invitation
     * that raced with this) lets the same token be presented again. A
     * caller should treat this as best-effort (catch and log, don't let a
     * cleanup failure mask the original error).
     */
    revertAcceptedInvitation(organizationId: string, id: string, actor: AuditActor): Promise<void>;

    createServicePrincipal(
        input: {
            organizationId: string;
            issuer: string;
            externalSubject: string;
            displayName: string;
            policyIds?: string[];
            permissionBoundaryPolicyId?: string;
        },
        actor: AuditActor
    ): Promise<ServicePrincipal>;
    findServicePrincipal(organizationId: string, issuer: string, externalSubject: string): Promise<ServicePrincipal | null>;
    getServicePrincipal(organizationId: string, id: string): Promise<ServicePrincipal | null>;
    listServicePrincipals(organizationId: string): Promise<ServicePrincipal[]>;
    updateServicePrincipal(
        organizationId: string,
        id: string,
        partial: Partial<Pick<ServicePrincipal, "displayName" | "status" | "policyIds" | "permissionBoundaryPolicyId">>,
        actor: AuditActor
    ): Promise<ServicePrincipal | null>;
}
