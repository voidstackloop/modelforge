import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./deps.js";
import { bindTenantIamStore, createTenantContext } from "../tenant-context.js";

/**
 * GET /me — the discovery endpoint a client calls right after obtaining a
 * bearer token, before it can call anything org-scoped: every User record
 * (across every organization) belonging to this identity, plus the name of
 * every policy in effect for each — enough for a UI to offer "which
 * organization do you want to act as" without the client needing to guess
 * or already know an organization id. Names only, not full policy
 * documents, to keep this payload small; a client that needs full documents
 * calls GET /organizations/:id/policies (gated by iam:listPolicies) instead.
 */
export function registerMeRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/me", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const auth = request.auth!;
        const membershipRows = await deps.principalStore.listMemberships(auth.issuer, auth.subject);
        const discovered = await Promise.all(
            membershipRows.map(async (membership) => {
                const organization = await deps.tenantDirectory.resolve(membership.organizationId);
                if (!organization) return null;
                const tenantStore = bindTenantIamStore(deps.store, createTenantContext(organization, request));
                const user = await tenantStore.getUser(membership.userId);
                if (!user) return null;
                const effectivePolicies = await tenantStore.resolveEffectivePolicies(user.id);
                return {
                    organization,
                    user: { id: user.id, displayName: user.displayName, status: membership.status },
                    effectivePolicyNames: effectivePolicies.map((p) => p.name),
                };
            })
        );

        // Compatibility for pre-IAM-v2 in-memory fixtures. PostgreSQL
        // production discovery uses issuer+subject memberships above.
        const memberships = discovered.filter((value) => value !== null);
        if (memberships.length === 0) {
            const users = await deps.store.listUsersByExternalSubject(auth.subject);
            for (const user of users) {
                const organization = await deps.tenantDirectory.resolve(user.organizationId);
                if (!organization) continue;
                const tenantStore = bindTenantIamStore(deps.store, createTenantContext(organization, request));
                memberships.push({ organization, user: { id: user.id, displayName: user.displayName, status: user.status }, effectivePolicyNames: (await tenantStore.resolveEffectivePolicies(user.id)).map((policy) => policy.name) });
            }
        }

        reply.send({ subject: auth.subject, email: auth.email, name: auth.name, memberships });
    });
}
