import { randomUUID } from "node:crypto";
import type { Group, Organization, Policy, PolicyDocument, User } from "../domain/types.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";
import { InvalidReferenceError, type IamStore } from "./iam-store.js";

/**
 * The only IamStore implementation available without a real Postgres
 * instance — everything lives in process memory and is lost on restart.
 * This is a real, disclosed scope boundary (see this package's README.md),
 * not an accident: it let the entire IAM domain (policy evaluation, routes,
 * auth wiring) be built and genuinely tested end to end before
 * postgres-iam-store.ts existed. Every method is `async` to match
 * IamStore's interface (which has to accommodate real network I/O for the
 * Postgres implementation) even though nothing here actually awaits
 * anything — this keeps both implementations interchangeable behind the
 * exact same call shape.
 *
 * `auditStore` defaults to a private, per-instance InMemoryAuditStore
 * nothing else can see — every existing `new InMemoryIamStore()` call site
 * (tests overwhelmingly) keeps working unchanged. index.ts passes an
 * explicit *shared* instance (also given to InMemoryCaseStore) so a real
 * deployment's audit trail merges both domains' mutations in one place.
 */
export class InMemoryIamStore implements IamStore {
    private organizations = new Map<string, Organization>();
    private users = new Map<string, User>();
    private groups = new Map<string, Group>();
    private policies = new Map<string, Policy>();
    private authorizationEpochs = new Map<string, number>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    /** See IamStore.getAuthorizationEpoch's doc comment. Called at the end
     * of every updateGroup/updatePolicy/deletePolicy that actually mutated
     * something (not on a no-op "target doesn't exist" call). */
    private bumpAuthorizationEpoch(organizationId: string): void {
        this.authorizationEpochs.set(organizationId, (this.authorizationEpochs.get(organizationId) ?? 1) + 1);
    }

    /** Throws InvalidReferenceError if any given policyId resolves to a
     * real policy belonging to a *different* organization. An id that
     * doesn't resolve to anything at all is left alone — see
     * InvalidReferenceError's doc comment for why that stays tolerated. */
    private assertPoliciesBelongToOrganization(organizationId: string, policyIds: string[]): void {
        for (const id of policyIds) {
            const policy = this.policies.get(id);
            if (policy && policy.organizationId !== organizationId) {
                throw new InvalidReferenceError(`Policy "${id}" does not belong to this organization.`);
            }
        }
    }

    /** Same as assertPoliciesBelongToOrganization, for groupIds. */
    private assertGroupsBelongToOrganization(organizationId: string, groupIds: string[]): void {
        for (const id of groupIds) {
            const group = this.groups.get(id);
            if (group && group.organizationId !== organizationId) {
                throw new InvalidReferenceError(`Group "${id}" does not belong to this organization.`);
            }
        }
    }

    async createOrganization(name: string, actor: AuditActor): Promise<Organization> {
        const org: Organization = { id: randomUUID(), name, createdAt: new Date().toISOString() };
        this.organizations.set(org.id, org);
        await this.auditStore.record({
            organizationId: org.id,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "organization.create",
            targetType: "organization",
            targetId: org.id,
        });
        return org;
    }

    async getOrganization(id: string): Promise<Organization | null> {
        return this.organizations.get(id) ?? null;
    }

    /** See IamStore.deleteOrganization's doc comment. Manually cascades to
     * users/groups/policies/the epoch counter — this store has no real
     * foreign keys to do it for us the way Postgres's ON DELETE CASCADE
     * does. Memberships/invitations/service-principals live in a separate
     * PrincipalStore and aren't touched here; the bootstrap flow that's
     * this method's only caller today never reaches its ensureMembership
     * step until after every step this DOES clean up has already
     * succeeded, so there is nothing there for it to orphan. */
    async deleteOrganization(id: string): Promise<void> {
        for (const [userId, user] of this.users) if (user.organizationId === id) this.users.delete(userId);
        for (const [groupId, group] of this.groups) if (group.organizationId === id) this.groups.delete(groupId);
        for (const [policyId, policy] of this.policies) if (policy.organizationId === id) this.policies.delete(policyId);
        this.authorizationEpochs.delete(id);
        this.organizations.delete(id);
    }

    async createUser(
        input: {
            organizationId: string;
            externalSubject: string;
            displayName: string;
            email?: string;
            groupIds?: string[];
            policyIds?: string[];
            permissionBoundaryPolicyId?: string;
        },
        actor: AuditActor
    ): Promise<User> {
        this.assertGroupsBelongToOrganization(input.organizationId, input.groupIds ?? []);
        this.assertPoliciesBelongToOrganization(input.organizationId, input.policyIds ?? []);
        if (input.permissionBoundaryPolicyId !== undefined) {
            this.assertPoliciesBelongToOrganization(input.organizationId, [input.permissionBoundaryPolicyId]);
        }
        const now = new Date().toISOString();
        const user: User = {
            id: randomUUID(),
            organizationId: input.organizationId,
            externalSubject: input.externalSubject,
            displayName: input.displayName,
            email: input.email,
            status: "active",
            groupIds: input.groupIds ?? [],
            policyIds: input.policyIds ?? [],
            permissionBoundaryPolicyId: input.permissionBoundaryPolicyId,
            createdAt: now,
            updatedAt: now,
        };
        this.users.set(user.id, user);
        await this.auditStore.record({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "user.create",
            targetType: "user",
            targetId: user.id,
        });
        return user;
    }

    async getUser(id: string): Promise<User | null> {
        return this.users.get(id) ?? null;
    }

    async findUserByExternalSubject(organizationId: string, externalSubject: string): Promise<User | null> {
        for (const user of this.users.values()) {
            if (user.organizationId === organizationId && user.externalSubject === externalSubject) return user;
        }
        return null;
    }

    async listUsersByExternalSubject(externalSubject: string): Promise<User[]> {
        return [...this.users.values()].filter((u) => u.externalSubject === externalSubject);
    }

    async listUsersByOrganization(organizationId: string): Promise<User[]> {
        return [...this.users.values()].filter((u) => u.organizationId === organizationId);
    }

    async updateUser(
        id: string,
        partial: Partial<Pick<User, "displayName" | "email" | "status" | "groupIds" | "policyIds" | "permissionBoundaryPolicyId">>,
        actor: AuditActor
    ): Promise<User | null> {
        const existing = this.users.get(id);
        if (!existing) return null;
        if (partial.groupIds !== undefined) this.assertGroupsBelongToOrganization(existing.organizationId, partial.groupIds);
        if (partial.policyIds !== undefined) this.assertPoliciesBelongToOrganization(existing.organizationId, partial.policyIds);
        if (partial.permissionBoundaryPolicyId !== undefined) {
            this.assertPoliciesBelongToOrganization(existing.organizationId, [partial.permissionBoundaryPolicyId]);
        }
        const updated: User = { ...existing, ...partial, updatedAt: new Date().toISOString() };
        this.users.set(id, updated);
        await this.auditStore.record({
            organizationId: existing.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "user.update",
            targetType: "user",
            targetId: id,
            details: { fields: Object.keys(partial) },
        });
        return updated;
    }

    async createGroup(input: { organizationId: string; name: string; policyIds?: string[] }, actor: AuditActor): Promise<Group> {
        this.assertPoliciesBelongToOrganization(input.organizationId, input.policyIds ?? []);
        const now = new Date().toISOString();
        const group: Group = {
            id: randomUUID(),
            organizationId: input.organizationId,
            name: input.name,
            policyIds: input.policyIds ?? [],
            createdAt: now,
            updatedAt: now,
        };
        this.groups.set(group.id, group);
        await this.auditStore.record({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "group.create",
            targetType: "group",
            targetId: group.id,
        });
        return group;
    }

    async getGroup(id: string): Promise<Group | null> {
        return this.groups.get(id) ?? null;
    }

    async listGroupsByOrganization(organizationId: string): Promise<Group[]> {
        return [...this.groups.values()].filter((g) => g.organizationId === organizationId);
    }

    async updateGroup(id: string, partial: Partial<Pick<Group, "name" | "policyIds">>, actor: AuditActor): Promise<Group | null> {
        const existing = this.groups.get(id);
        if (!existing) return null;
        if (partial.policyIds !== undefined) this.assertPoliciesBelongToOrganization(existing.organizationId, partial.policyIds);
        const updated: Group = { ...existing, ...partial, updatedAt: new Date().toISOString() };
        this.groups.set(id, updated);
        this.bumpAuthorizationEpoch(existing.organizationId);
        await this.auditStore.record({
            organizationId: existing.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "group.update",
            targetType: "group",
            targetId: id,
            details: { fields: Object.keys(partial) },
        });
        return updated;
    }

    async createPolicy(
        input: {
            organizationId: string;
            name: string;
            description?: string;
            document: PolicyDocument;
            builtin?: boolean;
        },
        actor: AuditActor
    ): Promise<Policy> {
        const now = new Date().toISOString();
        const policy: Policy = {
            id: randomUUID(),
            organizationId: input.organizationId,
            name: input.name,
            description: input.description,
            document: input.document,
            builtin: input.builtin ?? false,
            isBreakGlassPolicy: false,
            createdAt: now,
            updatedAt: now,
        };
        this.policies.set(policy.id, policy);
        await this.auditStore.record({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "policy.create",
            targetType: "policy",
            targetId: policy.id,
        });
        return policy;
    }

    async getPolicy(id: string): Promise<Policy | null> {
        return this.policies.get(id) ?? null;
    }

    async listPoliciesByOrganization(organizationId: string): Promise<Policy[]> {
        return [...this.policies.values()].filter((p) => p.organizationId === organizationId);
    }

    async updatePolicy(
        id: string,
        partial: Partial<Pick<Policy, "name" | "description" | "document">>,
        actor: AuditActor
    ): Promise<Policy | null> {
        const existing = this.policies.get(id);
        if (!existing) return null;
        const updated: Policy = { ...existing, ...partial, updatedAt: new Date().toISOString() };
        this.policies.set(id, updated);
        this.bumpAuthorizationEpoch(existing.organizationId);
        await this.auditStore.record({
            organizationId: existing.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "policy.update",
            targetType: "policy",
            targetId: id,
            details: { fields: Object.keys(partial) },
        });
        return updated;
    }

    async deletePolicy(id: string, actor: AuditActor): Promise<boolean> {
        const existing = this.policies.get(id);
        if (!existing || existing.builtin || existing.isBreakGlassPolicy) return false;
        this.policies.delete(id);
        this.bumpAuthorizationEpoch(existing.organizationId);
        await this.auditStore.record({
            organizationId: existing.organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "policy.delete",
            targetType: "policy",
            targetId: id,
        });
        return true;
    }

    async setBreakGlassPolicy(organizationId: string, policyId: string | null, actor: AuditActor): Promise<Policy | null> {
        const previous = [...this.policies.values()].find((p) => p.organizationId === organizationId && p.isBreakGlassPolicy);
        if (previous) this.policies.set(previous.id, { ...previous, isBreakGlassPolicy: false, updatedAt: new Date().toISOString() });
        let updated: Policy | null = null;
        if (policyId !== null) {
            const target = this.policies.get(policyId);
            if (!target || target.organizationId !== organizationId) {
                throw new InvalidReferenceError(`Policy ${policyId} does not exist in organization ${organizationId}.`);
            }
            updated = { ...target, isBreakGlassPolicy: true, updatedAt: new Date().toISOString() };
            this.policies.set(policyId, updated);
        }
        await this.auditStore.record({
            organizationId,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "breakGlassPolicy.set",
            targetType: "policy",
            targetId: policyId ?? previous?.id ?? organizationId,
            details: { policyId, previousPolicyId: previous?.id },
        });
        return updated;
    }

    async getBreakGlassPolicy(organizationId: string): Promise<Policy | null> {
        return [...this.policies.values()].find((p) => p.organizationId === organizationId && p.isBreakGlassPolicy) ?? null;
    }

    async getAuthorizationEpoch(organizationId: string): Promise<number> {
        return this.authorizationEpochs.get(organizationId) ?? 1;
    }

    async resolveEffectivePolicies(userId: string): Promise<Policy[]> {
        const user = this.users.get(userId);
        if (!user) return [];
        const policyIds = new Set(user.policyIds);
        for (const groupId of user.groupIds) {
            const group = this.groups.get(groupId);
            if (!group) continue;
            for (const policyId of group.policyIds) policyIds.add(policyId);
        }
        const policies: Policy[] = [];
        for (const id of policyIds) {
            const policy = this.policies.get(id);
            if (policy) policies.push(policy);
        }
        return policies;
    }
}
