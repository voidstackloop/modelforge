import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryPrincipalStore } from "./in-memory-principal-store.js";

describe("first-class identities and principals", () => {
    it("models identity membership separately and updates lifecycle state", async () => {
        const store = new InMemoryPrincipalStore(); const org = randomUUID(); const userId = randomUUID(); const actor = { externalSubject: "admin", userId: randomUUID() };
        const identity = await store.upsertIdentity({ issuer: "https://issuer.test", subject: "human", displayName: "Human" });
        const membership = await store.ensureMembership({ organizationId: org, identityId: identity.id, userId, provisioningSource: "invitation" }, actor);
        expect((await store.listMemberships(identity.issuer, identity.subject))[0]).toMatchObject({ id: membership.id, status: "active", provisioningSource: "invitation" });
        expect(await store.setMembershipStatus(org, userId, "deprovisioned", actor)).toMatchObject({ status: "deprovisioned" });
    });

    it("keeps pending invitations and non-human service principals as distinct records", async () => {
        const store = new InMemoryPrincipalStore(); const org = randomUUID(); const admin = randomUUID(); const actor = { externalSubject: "admin", userId: admin };
        const invitation = await store.createInvitation({ organizationId: org, email: "clinician@example.test", tokenHash: "hash", invitedByUserId: admin, expiresAt: new Date(Date.now()+60_000).toISOString() }, actor);
        expect(invitation.status).toBe("pending");
        expect(await store.acceptInvitation(org, invitation.id, "wrong", actor)).toBeNull();
        expect(await store.acceptInvitation(org, invitation.id, "hash", actor)).toMatchObject({ status: "accepted" });
        const principal = await store.createServicePrincipal({ organizationId: org, issuer: "https://issuer.test", externalSubject: "worker", displayName: "Sync worker" }, actor);
        expect(await store.findServicePrincipal(org, principal.issuer, principal.externalSubject)).toMatchObject({ id: principal.id, status: "active" });
    });
});
