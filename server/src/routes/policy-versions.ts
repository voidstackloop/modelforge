import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { unknownActionPatterns } from "../domain/action-catalog.js";
import { policyDocumentSchema } from "../domain/types.js";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationPolicyParamsSchema } from "./params.js";

const versionParamsSchema = z.object({ organizationId: z.string().uuid(), policyId: z.string().uuid(), versionId: z.string().uuid() });
const proposeVersionBodySchema = z.object({ document: policyDocumentSchema }).strict();
const rejectVersionBodySchema = z.object({ reason: z.string().max(2000).optional() }).strict();
const rollbackBodySchema = z.object({ versionId: z.string().uuid() }).strict();

/**
 * Policy versioning, dual-control approval, and rollback — an ADDITIONAL,
 * optional path alongside routes/policies.ts's existing direct PATCH
 * (which keeps mutating a policy's live document in place, unchanged). An
 * organization that wants real separation-of-duties on policy changes
 * grants policy:propose to authors and policy:approve to a different
 * population, and does not grant broad iam:managePolicies (which still
 * bypasses this workflow via direct PATCH — a disclosed, deliberate
 * limitation, not an oversight). No cryptographic signing/key-custody
 * here — contentHash (domain/types.ts's PolicyVersion) is an integrity/
 * audit aid only.
 */
export function registerPolicyVersionRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations/:organizationId/policies/:policyId/versions", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, policyId } = organizationPolicyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "policy:propose", `organization:${organizationId}`);

        const policy = await caller.tenantStore.getPolicy(policyId);
        if (!policy || policy.organizationId !== organizationId) {
            return reply.code(404).send({ error: "not_found", message: "Policy not found in this organization." });
        }

        const body = proposeVersionBodySchema.parse(request.body);
        const unknown = unknownActionPatterns(body.document);
        if (unknown.length > 0) {
            return reply.code(400).send({
                error: "unknown_action",
                message: `This policy version references an action that does not match anything in the server's action catalog: ${unknown.join(", ")}. Check for a typo, or see GET /organizations/:organizationId/action-catalog for the full list.`,
                unknownActions: unknown,
            });
        }
        const version = await deps.accessGovernanceStore.proposePolicyVersion(
            { organizationId, policyId, document: body.document, proposedByUserId: caller.id },
            actorFrom(caller)
        );
        reply.code(201).send(version);
    });

    fastify.get("/organizations/:organizationId/policies/:policyId/versions", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, policyId } = organizationPolicyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        // Viewing history is lower-stakes than proposing/deciding — reuses
        // the existing "can see policies" permission rather than a new one.
        await requirePermission(deps.store, caller, "iam:listPolicies", `organization:${organizationId}`);
        reply.send(await deps.accessGovernanceStore.listPolicyVersions(organizationId, policyId));
    });

    fastify.post(
        "/organizations/:organizationId/policies/:policyId/versions/:versionId/approve",
        { preHandler: deps.authPreHandler },
        async (request, reply) => {
            const { organizationId, policyId, versionId } = versionParamsSchema.parse(request.params);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "policy:approve", `organization:${organizationId}`);

            const version = await deps.accessGovernanceStore.getPolicyVersion(organizationId, policyId, versionId);
            if (!version) return reply.code(404).send({ error: "not_found" });
            if (version.status !== "pending") return reply.code(400).send({ error: "not_pending", message: "This version is not awaiting approval." });
            // The one dual-control check this needs: an approver can never
            // be the same person who proposed the version being approved —
            // same self-review pattern as break-glass/access-reviews.
            if (version.proposedByUserId === caller.id) {
                return reply.code(400).send({ error: "self_approval", message: "You cannot approve your own proposed policy version." });
            }

            const actor = actorFrom(caller);
            // Applied to the live policy FIRST, recorded second — the side
            // effect that actually matters (the policy changing) happens
            // even if recording the approval were to then fail. Same
            // ordering principle as routes/access-reviews.ts's revoke.
            await caller.tenantStore.updatePolicy(policyId, { document: version.document }, actor);
            const approved = await deps.accessGovernanceStore.approvePolicyVersion(organizationId, policyId, versionId, actor);
            if (!approved) return reply.code(400).send({ error: "not_pending", message: "This version is not awaiting approval." });
            reply.send(approved);
        }
    );

    fastify.post(
        "/organizations/:organizationId/policies/:policyId/versions/:versionId/reject",
        { preHandler: deps.authPreHandler },
        async (request, reply) => {
            const { organizationId, policyId, versionId } = versionParamsSchema.parse(request.params);
            const body = rejectVersionBodySchema.parse(request.body);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "policy:approve", `organization:${organizationId}`);

            const version = await deps.accessGovernanceStore.getPolicyVersion(organizationId, policyId, versionId);
            if (!version) return reply.code(404).send({ error: "not_found" });
            if (version.status !== "pending") return reply.code(400).send({ error: "not_pending", message: "This version is not awaiting approval." });
            // No self-check here, deliberately — withdrawing your own
            // pending proposal is safe and useful, unlike approving it.

            const rejected = await deps.accessGovernanceStore.rejectPolicyVersion(organizationId, policyId, versionId, body.reason, actorFrom(caller));
            if (!rejected) return reply.code(400).send({ error: "not_pending", message: "This version is not awaiting approval." });
            reply.send(rejected);
        }
    );

    fastify.post("/organizations/:organizationId/policies/:policyId/rollback", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, policyId } = organizationPolicyParamsSchema.parse(request.params);
        const body = rollbackBodySchema.parse(request.body);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "policy:approve", `organization:${organizationId}`);

        const version = await deps.accessGovernanceStore.getPolicyVersion(organizationId, policyId, body.versionId);
        if (!version || version.status !== "superseded") {
            return reply.code(400).send({
                error: "not_rollback_eligible",
                message: "Only a previously-approved (now superseded) version can be rolled back to.",
            });
        }
        // No self-check, deliberately: reverting to a version that was
        // already actually active is lower-risk than approving something
        // new — same "corrective, not a fresh grant" reasoning as
        // break-glass's own no-pre-approval design.

        const actor = actorFrom(caller);
        await caller.tenantStore.updatePolicy(policyId, { document: version.document }, actor);
        const rolledBack = await deps.accessGovernanceStore.rollbackToPolicyVersion(organizationId, policyId, body.versionId, actor);
        if (!rolledBack) {
            return reply.code(400).send({ error: "not_rollback_eligible", message: "Only a previously-approved (now superseded) version can be rolled back to." });
        }
        reply.send(rolledBack);
    });
}
