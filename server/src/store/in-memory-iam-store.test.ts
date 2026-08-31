import { describe, it, expect, beforeEach } from "vitest";
import type { AuditActor } from "./audit-store.js";
import { InMemoryIamStore } from "./in-memory-iam-store.js";
import { InvalidReferenceError } from "./iam-store.js";
import { POLICY_DOCUMENT_VERSION } from "../domain/policy-evaluator.js";
import type { PolicyDocument } from "../domain/types.js";

function allowAllDocument(): PolicyDocument {
    return { version: POLICY_DOCUMENT_VERSION, statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] };
}

// Every mutation now requires an AuditActor (see iam-store.ts's doc
// comment) — none of these tests are about auditing itself, so one shared
// dummy actor covers every call site here. audit-store.test.ts covers the
// actual audit-log content/behavior.
const ACTOR: AuditActor = { externalSubject: "idp|test-actor" };

describe("InMemoryIamStore", () => {
    let store: InMemoryIamStore;

    beforeEach(() => {
        store = new InMemoryIamStore();
    });

    it("creates an organization and reads it back by id", async () => {
        const org = await store.createOrganization("Example Health System", ACTOR);
        expect(await store.getOrganization(org.id)).toEqual(org);
    });

    it("returns null for an unknown organization/user/group/policy id", async () => {
        expect(await store.getOrganization("nope")).toBeNull();
        expect(await store.getUser("nope")).toBeNull();
        expect(await store.getGroup("nope")).toBeNull();
        expect(await store.getPolicy("nope")).toBeNull();
    });

    it("findUserByExternalSubject is scoped per organization — the same subject in two orgs is two distinct users", async () => {
        const orgA = await store.createOrganization("Org A", ACTOR);
        const orgB = await store.createOrganization("Org B", ACTOR);
        const userA = await store.createUser({ organizationId: orgA.id, externalSubject: "idp|shared-subject", displayName: "Dr. Shared" }, ACTOR);
        const userB = await store.createUser({ organizationId: orgB.id, externalSubject: "idp|shared-subject", displayName: "Dr. Shared" }, ACTOR);

        expect(userA.id).not.toBe(userB.id);
        expect((await store.findUserByExternalSubject(orgA.id, "idp|shared-subject"))?.id).toBe(userA.id);
        expect((await store.findUserByExternalSubject(orgB.id, "idp|shared-subject"))?.id).toBe(userB.id);
        expect(await store.findUserByExternalSubject(orgA.id, "idp|nobody")).toBeNull();
    });

    it("listUsersByExternalSubject finds every org-scoped user record for one identity", async () => {
        const orgA = await store.createOrganization("Org A", ACTOR);
        const orgB = await store.createOrganization("Org B", ACTOR);
        await store.createUser({ organizationId: orgA.id, externalSubject: "idp|shared-subject", displayName: "Dr. Shared" }, ACTOR);
        await store.createUser({ organizationId: orgB.id, externalSubject: "idp|shared-subject", displayName: "Dr. Shared" }, ACTOR);
        await store.createUser({ organizationId: orgA.id, externalSubject: "idp|someone-else", displayName: "Someone Else" }, ACTOR);

        expect(await store.listUsersByExternalSubject("idp|shared-subject")).toHaveLength(2);
        expect(await store.listUsersByExternalSubject("idp|someone-else")).toHaveLength(1);
        expect(await store.listUsersByExternalSubject("idp|nobody")).toHaveLength(0);
    });

    it("new users default to active status with no groups/policies", async () => {
        const org = await store.createOrganization("Org", ACTOR);
        const user = await store.createUser({ organizationId: org.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);
        expect(user.status).toBe("active");
        expect(user.groupIds).toEqual([]);
        expect(user.policyIds).toEqual([]);
    });

    it("updateUser merges the given fields and bumps updatedAt without touching others", async () => {
        const org = await store.createOrganization("Org", ACTOR);
        const user = await store.createUser({ organizationId: org.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);
        const updated = await store.updateUser(user.id, { status: "suspended" }, ACTOR);
        expect(updated?.status).toBe("suspended");
        expect(updated?.displayName).toBe("X");
        // ISO timestamps compare chronologically as strings; >= rather than
        // a strict inequality since createUser and updateUser can land in
        // the same millisecond when a test runs this fast.
        expect(updated!.updatedAt >= user.updatedAt).toBe(true);
    });

    it("updateUser/updateGroup/updatePolicy return null for an unknown id rather than throwing", async () => {
        expect(await store.updateUser("nope", { status: "suspended" }, ACTOR)).toBeNull();
        expect(await store.updateGroup("nope", { name: "x" }, ACTOR)).toBeNull();
        expect(await store.updatePolicy("nope", { name: "x" }, ACTOR)).toBeNull();
    });

    it("deletePolicy removes a non-builtin policy and returns true", async () => {
        const org = await store.createOrganization("Org", ACTOR);
        const policy = await store.createPolicy({ organizationId: org.id, name: "Custom", document: allowAllDocument() }, ACTOR);
        expect(await store.deletePolicy(policy.id, ACTOR)).toBe(true);
        expect(await store.getPolicy(policy.id)).toBeNull();
    });

    it("deletePolicy refuses to delete a builtin policy and leaves it in place", async () => {
        const org = await store.createOrganization("Org", ACTOR);
        const policy = await store.createPolicy({ organizationId: org.id, name: "OrgAdmin", document: allowAllDocument(), builtin: true }, ACTOR);
        expect(await store.deletePolicy(policy.id, ACTOR)).toBe(false);
        expect(await store.getPolicy(policy.id)).not.toBeNull();
    });

    it("deletePolicy returns false for an unknown id", async () => {
        expect(await store.deletePolicy("nope", ACTOR)).toBe(false);
    });

    describe("cross-organization policyId/groupId attachment is rejected", () => {
        // A dangling id (never existed, or was deleted) stays tolerated —
        // see the "silently skips" test above — but an id that verifiably
        // resolves to a real policy/group in a *different* organization
        // must never be attachable. Left unguarded, resolveEffectivePolicies
        // would include the foreign policy in this user's effective set,
        // breaking tenant isolation.
        it("createUser rejects a policyId belonging to a different organization", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

            await expect(
                store.createUser({ organizationId: orgA.id, externalSubject: "idp|x", displayName: "X", policyIds: [foreignPolicy.id] }, ACTOR)
            ).rejects.toThrow(InvalidReferenceError);
        });

        it("createUser rejects a groupId belonging to a different organization", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const foreignGroup = await store.createGroup({ organizationId: orgB.id, name: "Foreign" }, ACTOR);

            await expect(
                store.createUser({ organizationId: orgA.id, externalSubject: "idp|x", displayName: "X", groupIds: [foreignGroup.id] }, ACTOR)
            ).rejects.toThrow(InvalidReferenceError);
        });

        it("updateUser rejects attaching a policyId belonging to a different organization, and does not partially apply the update", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const user = await store.createUser({ organizationId: orgA.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);
            const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

            await expect(store.updateUser(user.id, { displayName: "Renamed", policyIds: [foreignPolicy.id] }, ACTOR)).rejects.toThrow(
                InvalidReferenceError
            );
            expect((await store.getUser(user.id))?.displayName).toBe("X"); // unchanged
        });

        it("createGroup rejects a policyId belonging to a different organization", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

            await expect(store.createGroup({ organizationId: orgA.id, name: "G", policyIds: [foreignPolicy.id] }, ACTOR)).rejects.toThrow(
                InvalidReferenceError
            );
        });

        it("updateGroup rejects attaching a policyId belonging to a different organization", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const group = await store.createGroup({ organizationId: orgA.id, name: "G" }, ACTOR);
            const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

            await expect(store.updateGroup(group.id, { policyIds: [foreignPolicy.id] }, ACTOR)).rejects.toThrow(InvalidReferenceError);
        });

        it("still tolerates a same-organization policyId/groupId exactly as before", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "Local", document: allowAllDocument() }, ACTOR);
            const group = await store.createGroup({ organizationId: org.id, name: "G", policyIds: [policy.id] }, ACTOR);

            const user = await store.createUser(
                {
                    organizationId: org.id,
                    externalSubject: "idp|x",
                    displayName: "X",
                    groupIds: [group.id],
                    policyIds: [policy.id],
                },
                ACTOR
            );
            expect(user.policyIds).toEqual([policy.id]);
        });

        it("createUser rejects a permissionBoundaryPolicyId belonging to a different organization", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

            await expect(
                store.createUser(
                    {
                        organizationId: orgA.id,
                        externalSubject: "idp|x",
                        displayName: "X",
                        permissionBoundaryPolicyId: foreignPolicy.id,
                    },
                    ACTOR
                )
            ).rejects.toThrow(InvalidReferenceError);
        });

        it("updateUser rejects a permissionBoundaryPolicyId belonging to a different organization, and does not partially apply the update", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const user = await store.createUser({ organizationId: orgA.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);
            const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

            await expect(
                store.updateUser(user.id, { displayName: "Renamed", permissionBoundaryPolicyId: foreignPolicy.id }, ACTOR)
            ).rejects.toThrow(InvalidReferenceError);
            expect((await store.getUser(user.id))?.displayName).toBe("X"); // unchanged
        });

        it("still tolerates a same-organization permissionBoundaryPolicyId", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "Boundary", document: allowAllDocument() }, ACTOR);
            const user = await store.createUser(
                {
                    organizationId: org.id,
                    externalSubject: "idp|x",
                    displayName: "X",
                    permissionBoundaryPolicyId: policy.id,
                },
                ACTOR
            );
            expect(user.permissionBoundaryPolicyId).toBe(policy.id);
        });
    });

    describe("resolveEffectivePolicies", () => {
        it("returns an empty list for a user with no direct or group policies", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const user = await store.createUser({ organizationId: org.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);
            expect(await store.resolveEffectivePolicies(user.id)).toEqual([]);
        });

        it("returns an empty list for an unknown user id, rather than throwing", async () => {
            expect(await store.resolveEffectivePolicies("nope")).toEqual([]);
        });

        it("includes policies attached directly to the user", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "Direct", document: allowAllDocument() }, ACTOR);
            const user = await store.createUser(
                {
                    organizationId: org.id,
                    externalSubject: "idp|x",
                    displayName: "X",
                    policyIds: [policy.id],
                },
                ACTOR
            );
            expect((await store.resolveEffectivePolicies(user.id)).map((p) => p.id)).toEqual([policy.id]);
        });

        it("includes policies attached via group membership", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "Via group", document: allowAllDocument() }, ACTOR);
            const group = await store.createGroup({ organizationId: org.id, name: "Clinicians", policyIds: [policy.id] }, ACTOR);
            const user = await store.createUser(
                {
                    organizationId: org.id,
                    externalSubject: "idp|x",
                    displayName: "X",
                    groupIds: [group.id],
                },
                ACTOR
            );
            expect((await store.resolveEffectivePolicies(user.id)).map((p) => p.id)).toEqual([policy.id]);
        });

        it("de-duplicates a policy attached both directly and via a group", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "Shared", document: allowAllDocument() }, ACTOR);
            const group = await store.createGroup({ organizationId: org.id, name: "Clinicians", policyIds: [policy.id] }, ACTOR);
            const user = await store.createUser(
                {
                    organizationId: org.id,
                    externalSubject: "idp|x",
                    displayName: "X",
                    groupIds: [group.id],
                    policyIds: [policy.id],
                },
                ACTOR
            );
            expect((await store.resolveEffectivePolicies(user.id)).map((p) => p.id)).toEqual([policy.id]);
        });

        it("silently skips a policyId/groupId that no longer resolves to anything, rather than throwing", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const user = await store.createUser(
                {
                    organizationId: org.id,
                    externalSubject: "idp|x",
                    displayName: "X",
                    groupIds: ["deleted-group"],
                    policyIds: ["deleted-policy"],
                },
                ACTOR
            );
            expect(await store.resolveEffectivePolicies(user.id)).toEqual([]);
        });
    });
});
