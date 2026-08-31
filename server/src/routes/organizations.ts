import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { organizationAdminPolicyDocument } from "../domain/builtin-policies.js";
import { actorFrom } from "../store/audit-store.js";
import { bindTenantIamStore, createTenantContext } from "../tenant-context.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

const createOrganizationBodySchema = z.object({ name: z.string().min(1) });

/**
 * The one deliberate bootstrap exception in this whole service: creating an
 * organization requires only a verified identity (any authenticated
 * principal, not an existing account in any organization), because there is
 * no existing organization for a permission check to be scoped against yet.
 * The caller becomes that organization's admin automatically — attached the
 * builtin OrganizationAdmin policy (../domain/builtin-policies.ts), scoped
 * to only that one new organization, never anything wider. Every other
 * route in this service requires an existing, explicitly-granted account
 * (see guards.ts's requireOrgUser) — this is the only place a User record
 * is created without one already having iam:manageUsers.
 */
export function registerOrganizationRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const body = createOrganizationBodySchema.parse(request.body);
        const auth = request.auth!;

        const createdOrganization = await deps.store.createOrganization(body.name, { externalSubject: auth.subject });
        try {
            const organization = await deps.tenantDirectory.provision(createdOrganization);
            const bootstrapActor = { externalSubject: auth.subject, organizationId: organization.id };
            const tenantContext = createTenantContext(organization, request);
            const tenantStore = bindTenantIamStore(deps.store, tenantContext);
            const adminPolicy = await tenantStore.createPolicy(
                {
                    name: "OrganizationAdmin",
                    description: "Full access within this organization only — auto-created when the organization was created.",
                    document: organizationAdminPolicyDocument(organization.id),
                    builtin: true,
                },
                bootstrapActor
            );
            const identity = await deps.principalStore.upsertIdentity({
                issuer: auth.issuer,
                subject: auth.subject,
                displayName: auth.name ?? auth.email ?? auth.subject,
                email: auth.email,
            });
            const adminUser = await tenantStore.createUser(
                {
                    externalSubject: auth.subject,
                    displayName: auth.name ?? auth.email ?? auth.subject,
                    email: auth.email,
                    policyIds: [adminPolicy.id],
                },
                bootstrapActor
            );
            await deps.principalStore.ensureMembership(
                { organizationId: organization.id, identityId: identity.id, userId: adminUser.id, provisioningSource: "bootstrap" },
                actorFrom({ ...adminUser, principalType: "human" })
            );

            reply.code(201).send({ organization, user: adminUser });
        } catch (err) {
            // Bootstrap failed partway — this is the *only* path that can
            // ever make this organization administrable, so leaving it
            // half-formed (no admin policy/user/membership) orphans it
            // forever, not just delays it. Best-effort: a cleanup failure
            // must never mask the original error the caller needs to see.
            await deps.store.deleteOrganization(createdOrganization.id).catch(() => {});
            throw err;
        }
    });

    fastify.get("/organizations/:organizationId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        // Any account holder in the org (not gated by a specific
        // permission) can see the organization's own basic identity —
        // there's nothing sensitive in {id, name, createdAt} to protect
        // further than "you have some standing here at all." A denial here
        // throws AuthzError, caught by app.ts's global error handler.
        const caller = await requireOrgUser(deps, request, organizationId);
        const organization = await caller.tenantStore.getOrganization();
        if (!organization) return reply.code(404).send({ error: "not_found", message: "Organization not found." });
        reply.send(organization);
    });
}
