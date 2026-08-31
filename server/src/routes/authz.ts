import type { FastifyInstance } from "fastify";
import { evaluateWithBoundary } from "../domain/policy-evaluator.js";
import { authorizationRequestSchema } from "../domain/types.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, resolveEffectivePoliciesWithBoundary } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

/**
 * POST /organizations/:organizationId/authz/check — the primitive every
 * other service in an enterprise deployment (a future shared patient-case
 * backend, an admin console, anything else) is meant to call to answer
 * "can this bearer token's holder do X to Y" — this is what makes
 * docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §5's "server-side only,
 * enforced against the access token's scope claims" principle concrete and
 * reusable rather than every service re-implementing its own check against
 * this store directly.
 *
 * Unlike every other org-scoped route, this one does *not* call
 * requirePermission on top of requireOrgUser — the whole point of this
 * endpoint is to answer a permission question, not to gate access to
 * answering it with a second permission of its own. It still requires an
 * *account* to exist in this organization at all (requireOrgUser, same as
 * every other route) — a valid bearer token with no corresponding User
 * record in this organization gets 403 here too, consistent with every
 * other endpoint, rather than a special-cased `{ effect: "Deny" }` that
 * would make this one route behave differently from the rest of the
 * service for the same underlying condition. See app.test.ts's "no account
 * in this org gets 403 from /authz/check" case.
 *
 * It DOES go through resolveEffectivePoliciesWithBoundary +
 * evaluateWithBoundary — the same permission-boundary resolution
 * requirePermission uses (see guards.ts) — rather than a bare
 * evaluatePolicies call: this endpoint is documented as "the primitive
 * every other service is meant to call," so its answer for a bounded user
 * must match what every other route in this service already enforces for
 * that same user, not silently ignore the boundary because this one
 * endpoint evaluates policies directly instead of through a guard.
 */
export function registerAuthzRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations/:organizationId/authz/check", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);

        const body = authorizationRequestSchema.parse(request.body);
        // This route is path-scoped to one organization — a resource string
        // naming a different one is never a legitimate question to ask
        // through it, regardless of what the caller's own policies say
        // (a resources: ["*"] policy, entirely legal within one's own org,
        // would otherwise let this answer Allow for another organization's
        // resource — this endpoint is documented as "the primitive every
        // other service is meant to call," so that answer being trustworthy
        // matters beyond just this HTTP API's own other routes, none of
        // which are exploitable this way since they build `resource`
        // themselves from the URL rather than accepting it from the body).
        const resourcePrefix = `organization:${organizationId}`;
        if (body.resource !== resourcePrefix && !body.resource.startsWith(`${resourcePrefix}/`)) {
            return reply.code(400).send({ error: "invalid_request", message: "resource must be scoped to this organization." });
        }
        const resolved = await resolveEffectivePoliciesWithBoundary(deps.store, caller);
        const mergedContext: Record<string, string> = {
            ...body.context,
            "user:id": caller.id,
            "user:organizationId": caller.organizationId,
        };

        // A dangling boundary reference (see guards.ts's doc comment) is an
        // unconditional Deny — matches evaluatePolicies' own bare
        // default-deny shape (no matchedStatement) rather than a special
        // response shape only this one failure mode would ever produce.
        if ("deniedByMissingBoundary" in resolved) {
            return reply.send({ effect: "Deny" });
        }

        const result = evaluateWithBoundary(resolved.policies, resolved.boundary, {
            action: body.action,
            resource: body.resource,
            context: mergedContext,
        });
        reply.send(result);
    });
}
