import { randomUUID } from "node:crypto";
import type { Identity, Invitation, Membership, ServicePrincipal } from "../domain/types.js";
import type { AuditActor, AuditStore } from "./audit-store.js";
import { InMemoryAuditStore } from "./audit-store.js";
import type { PrincipalStore } from "./principal-store.js";

export class InMemoryPrincipalStore implements PrincipalStore {
    private readonly identities = new Map<string, Identity>();
    private readonly memberships = new Map<string, Membership>();
    private readonly invitations = new Map<string, Invitation>();
    private readonly servicePrincipals = new Map<string, ServicePrincipal>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    async upsertIdentity(input: { issuer: string; subject: string; displayName: string; email?: string }): Promise<Identity> {
        const key = `${input.issuer}\u0000${input.subject}`;
        const existing = this.identities.get(key);
        const now = new Date().toISOString();
        const identity: Identity = existing
            ? { ...existing, displayName: input.displayName, email: input.email, updatedAt: now }
            : { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
        this.identities.set(key, identity);
        return identity;
    }
    async findIdentity(issuer: string, subject: string): Promise<Identity | null> { return this.identities.get(`${issuer}\u0000${subject}`) ?? null; }

    async ensureMembership(
        input: {
            organizationId: string;
            identityId: string;
            userId: string;
            provisioningSource: Membership["provisioningSource"];
            expiresAt?: string;
        },
        actor: AuditActor
    ): Promise<Membership> {
        const existing = [...this.memberships.values()].find(
            (membership) => membership.organizationId === input.organizationId && membership.identityId === input.identityId
        );
        if (existing) return existing;
        const now = new Date().toISOString();
        const membership: Membership = {
            id: randomUUID(),
            ...input,
            status: "active",
            startsAt: now,
            createdAt: now,
            updatedAt: now,
        };
        this.memberships.set(membership.id, membership);
        await this.auditStore.record({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "membership.create",
            targetType: "membership",
            targetId: membership.id,
        });
        return membership;
    }

    async listMemberships(issuer: string, subject: string): Promise<Membership[]> {
        const identityIds = new Set([...this.identities.values()].filter((i) => i.issuer === issuer && i.subject === subject).map((i) => i.id));
        return [...this.memberships.values()].filter((membership) => identityIds.has(membership.identityId));
    }

    async listMembershipsByOrganization(organizationId: string): Promise<Membership[]> {
        return [...this.memberships.values()].filter((m) => m.organizationId === organizationId && m.status === "active");
    }

    async setMembershipStatus(
        organizationId: string,
        userId: string,
        status: Membership["status"],
        actor: AuditActor
    ): Promise<Membership | null> {
        const membership = [...this.memberships.values()].find((item) => item.organizationId === organizationId && item.userId === userId);
        if (!membership) return null;
        const updated = { ...membership, status, updatedAt: new Date().toISOString() };
        this.memberships.set(updated.id, updated);
        await this.auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "membership.update", targetType: "membership", targetId: updated.id, details: { status } });
        return updated;
    }

    async createInvitation(
        input: { organizationId: string; email: string; displayName?: string; tokenHash: string; invitedByUserId: string; expiresAt: string },
        actor: AuditActor
    ): Promise<Invitation> {
        const now = new Date().toISOString();
        const invitation: Invitation = { id: randomUUID(), ...input, status: "pending", createdAt: now, updatedAt: now };
        this.invitations.set(invitation.id, invitation);
        await this.auditStore.record({ organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "invitation.create", targetType: "invitation", targetId: invitation.id });
        return invitation;
    }

    async listInvitations(organizationId: string): Promise<Invitation[]> {
        return [...this.invitations.values()].filter((invitation) => invitation.organizationId === organizationId);
    }

    async getInvitation(organizationId: string, id: string): Promise<Invitation | null> {
        const invitation = this.invitations.get(id);
        return invitation?.organizationId === organizationId ? invitation : null;
    }

    async acceptInvitation(organizationId: string, id: string, tokenHash: string, actor: AuditActor): Promise<Invitation | null> {
        const invitation = await this.getInvitation(organizationId, id);
        if (!invitation || invitation.status !== "pending" || invitation.tokenHash !== tokenHash || invitation.expiresAt <= new Date().toISOString()) return null;
        const now = new Date().toISOString();
        const accepted: Invitation = { ...invitation, status: "accepted", acceptedAt: now, updatedAt: now };
        this.invitations.set(id, accepted);
        await this.auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "invitation.accept", targetType: "invitation", targetId: id });
        return accepted;
    }

    async revertAcceptedInvitation(organizationId: string, id: string, actor: AuditActor): Promise<void> {
        const invitation = await this.getInvitation(organizationId, id);
        if (!invitation || invitation.status !== "accepted") return;
        const { acceptedAt: _acceptedAt, ...rest } = invitation;
        const reverted: Invitation = { ...rest, status: "pending", updatedAt: new Date().toISOString() };
        this.invitations.set(id, reverted);
        await this.auditStore.record({
            organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "invitation.revertAccept",
            targetType: "invitation",
            targetId: id,
        });
    }

    async revokeInvitation(organizationId: string, id: string, actor: AuditActor): Promise<Invitation | null> {
        const invitation = await this.getInvitation(organizationId, id);
        if (!invitation || invitation.status !== "pending") return null;
        const revoked: Invitation = { ...invitation, status: "revoked", updatedAt: new Date().toISOString() };
        this.invitations.set(id, revoked);
        await this.auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "invitation.revoke", targetType: "invitation", targetId: id });
        return revoked;
    }

    async createServicePrincipal(
        input: { organizationId: string; issuer: string; externalSubject: string; displayName: string; policyIds?: string[]; permissionBoundaryPolicyId?: string },
        actor: AuditActor
    ): Promise<ServicePrincipal> {
        const now = new Date().toISOString();
        const principal: ServicePrincipal = { id: randomUUID(), ...input, status: "active", policyIds: input.policyIds ?? [], createdAt: now, updatedAt: now };
        this.servicePrincipals.set(principal.id, principal);
        await this.auditStore.record({ organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "servicePrincipal.create", targetType: "servicePrincipal", targetId: principal.id });
        return principal;
    }

    async findServicePrincipal(organizationId: string, issuer: string, externalSubject: string): Promise<ServicePrincipal | null> {
        return [...this.servicePrincipals.values()].find((principal) => principal.organizationId === organizationId && principal.issuer === issuer && principal.externalSubject === externalSubject) ?? null;
    }

    async getServicePrincipal(organizationId: string, id: string): Promise<ServicePrincipal | null> {
        const principal = this.servicePrincipals.get(id);
        return principal?.organizationId === organizationId ? principal : null;
    }

    async listServicePrincipals(organizationId: string): Promise<ServicePrincipal[]> {
        return [...this.servicePrincipals.values()].filter((principal) => principal.organizationId === organizationId);
    }

    async updateServicePrincipal(
        organizationId: string,
        id: string,
        partial: Partial<Pick<ServicePrincipal, "displayName" | "status" | "policyIds" | "permissionBoundaryPolicyId">>,
        actor: AuditActor
    ): Promise<ServicePrincipal | null> {
        const principal = await this.getServicePrincipal(organizationId, id);
        if (!principal) return null;
        const updated = { ...principal, ...partial, updatedAt: new Date().toISOString() };
        this.servicePrincipals.set(id, updated);
        await this.auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "servicePrincipal.update", targetType: "servicePrincipal", targetId: id, details: { fields: Object.keys(partial) } });
        return updated;
    }
}
