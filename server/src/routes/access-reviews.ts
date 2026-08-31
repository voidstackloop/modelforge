import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

const campaignParamsSchema = z.object({ organizationId: z.string().uuid(), campaignId: z.string().uuid() });
const campaignItemParamsSchema = z.object({ organizationId: z.string().uuid(), campaignId: z.string().uuid(), itemId: z.string().uuid() });
const decideItemBodySchema = z.object({ decision: z.enum(["keep", "revoke"]) }).strict();

/**
 * Admin-triggered access-review campaigns: reviewing every active
 * Membership in an organization at creation time, one item per membership.
 * Anyone holding accessReview:decide may decide any item except one where
 * they are the subject — no fixed per-campaign reviewer (see domain/
 * types.ts's AccessReviewCampaign doc comment).
 */
export function registerAccessReviewRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations/:organizationId/access-reviews", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "accessReview:manage", `organization:${organizationId}`);

        const memberships = await deps.principalStore.listMembershipsByOrganization(organizationId);
        const campaign = await deps.accessGovernanceStore.createAccessReviewCampaign(
            { organizationId, createdByUserId: caller.id, memberships: memberships.map((m) => ({ id: m.id, userId: m.userId })) },
            actorFrom(caller)
        );
        reply.code(201).send(campaign);
    });

    fastify.get("/organizations/:organizationId/access-reviews", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "accessReview:list", `organization:${organizationId}`);
        reply.send(await deps.accessGovernanceStore.listAccessReviewCampaigns(organizationId));
    });

    fastify.get(
        "/organizations/:organizationId/access-reviews/:campaignId/items",
        { preHandler: deps.authPreHandler },
        async (request, reply) => {
            const { organizationId, campaignId } = campaignParamsSchema.parse(request.params);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "accessReview:list", `organization:${organizationId}`);
            reply.send(await deps.accessGovernanceStore.listAccessReviewItems(organizationId, campaignId));
        }
    );

    fastify.post(
        "/organizations/:organizationId/access-reviews/:campaignId/items/:itemId/decide",
        { preHandler: deps.authPreHandler },
        async (request, reply) => {
            const { organizationId, campaignId, itemId } = campaignItemParamsSchema.parse(request.params);
            const body = decideItemBodySchema.parse(request.body);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "accessReview:decide", `organization:${organizationId}`);

            const item = await deps.accessGovernanceStore.getAccessReviewItem(organizationId, campaignId, itemId);
            if (!item) return reply.code(404).send({ error: "not_found" });
            if (item.decision !== "pending") return reply.code(400).send({ error: "already_decided", message: "This item has already been decided." });
            if (item.subjectUserId === caller.id) {
                return reply.code(400).send({ error: "self_review", message: "You cannot decide an access-review item about your own membership." });
            }

            const acceptActor = actorFrom(caller);
            if (body.decision === "revoke") {
                // Suspend the membership FIRST, decision-record second: if
                // suspension fails the item stays safely pending/retryable;
                // if it succeeds but the decision-record call then fails,
                // access is already correctly pulled — failing toward
                // over-revocation, never toward "recorded as revoked but
                // never actually pulled." Same orchestration-in-the-route
                // precedent as routes/invitations.ts's accept handler
                // (two independent stores, no cross-store transaction).
                await deps.principalStore.setMembershipStatus(organizationId, item.subjectUserId, "suspended", acceptActor);
            }
            const decided = await deps.accessGovernanceStore.decideAccessReviewItem(organizationId, campaignId, itemId, body.decision, acceptActor);
            if (!decided) return reply.code(400).send({ error: "already_decided", message: "This item has already been decided." });
            reply.send(decided);
        }
    );
}
