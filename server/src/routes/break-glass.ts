import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

const grantParamsSchema = z.object({ organizationId: z.string().uuid(), grantId: z.string().uuid() });
const invokeBreakGlassBodySchema = z.object({ justification: z.string().min(10).max(2000) }).strict();
const reviewBreakGlassBodySchema = z.object({ outcome: z.enum(["acknowledged", "flagged"]) }).strict();
const setBreakGlassPolicyBodySchema = z.object({ policyId: z.string().uuid().nullable() }).strict();

/**
 * Break-glass emergency access: grants immediately on the caller entering a
 * justification (self-service, no pre-approval gate — waiting would defeat
 * the emergency purpose), unlocking exactly one pre-configured "emergency
 * access" Policy per organization (see domain/types.ts's
 * Policy.isBreakGlassPolicy). Requires a mandatory post-hoc review
 * afterward. See routes/guards.ts's requireOrgUser/resolveEffectivePolicies
 * WithBoundary for how an active grant is actually attached to a caller's
 * effective policy set on every subsequent request.
 */
export function registerBreakGlassRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations/:organizationId/break-glass/invoke", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const body = invokeBreakGlassBodySchema.parse(request.body);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "breakGlass:invoke", `organization:${organizationId}`);

        const emergencyPolicy = await caller.tenantStore.getBreakGlassPolicy();
        if (!emergencyPolicy) {
            return reply.code(409).send({
                error: "no_break_glass_policy_configured",
                message: "This organization has not configured an emergency access policy yet.",
            });
        }
        const existingGrant = await deps.accessGovernanceStore.getActiveBreakGlassGrant(organizationId, caller.id);
        if (existingGrant) {
            return reply.code(409).send({ error: "break_glass_already_active", message: "You already have an active break-glass grant." });
        }

        const grant = await deps.accessGovernanceStore.invokeBreakGlass(
            {
                organizationId,
                userId: caller.id,
                emergencyPolicyId: emergencyPolicy.id,
                justification: body.justification,
                durationMs: deps.breakGlassGrantDurationMs,
            },
            actorFrom(caller)
        );
        reply.code(201).send(grant);
    });

    fastify.get("/organizations/:organizationId/break-glass/grants", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "breakGlass:list", `organization:${organizationId}`);
        reply.send(await deps.accessGovernanceStore.listBreakGlassGrants(organizationId));
    });

    fastify.post(
        "/organizations/:organizationId/break-glass/grants/:grantId/review",
        { preHandler: deps.authPreHandler },
        async (request, reply) => {
            const { organizationId, grantId } = grantParamsSchema.parse(request.params);
            const body = reviewBreakGlassBodySchema.parse(request.body);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "breakGlass:review", `organization:${organizationId}`);

            const grant = await deps.accessGovernanceStore.getBreakGlassGrant(organizationId, grantId);
            if (!grant) return reply.code(404).send({ error: "not_found" });
            if (grant.reviewedAt) return reply.code(400).send({ error: "already_reviewed", message: "This grant has already been reviewed." });
            // A reviewer can never be the same person who invoked the grant
            // being reviewed — the one self-approval boundary this feature
            // needs (break-glass itself has no pre-approval step to
            // self-approve, per its own design).
            if (grant.userId === caller.id) {
                return reply.code(400).send({ error: "self_review", message: "You cannot review your own break-glass grant." });
            }

            const reviewed = await deps.accessGovernanceStore.reviewBreakGlassGrant(organizationId, grantId, body.outcome, actorFrom(caller));
            if (!reviewed) return reply.code(400).send({ error: "already_reviewed", message: "This grant has already been reviewed." });
            reply.send(reviewed);
        }
    );

    fastify.put("/organizations/:organizationId/break-glass/policy", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const body = setBreakGlassPolicyBodySchema.parse(request.body);
        const caller = await requireOrgUser(deps, request, organizationId);
        // Reuses the existing iam:managePolicies action rather than a new
        // one — anyone who already holds it can create an equally
        // privileged policy and self-attach it via iam:manageUsers/
        // manageGroups regardless, so a separate action here would not
        // actually raise the achievable ceiling.
        await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);
        const updated = await caller.tenantStore.setBreakGlassPolicy(body.policyId, actorFrom(caller));
        reply.send(updated);
    });
}
