import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenantBackupArtifactSchema } from "../domain/types.js";
import { actorFrom } from "../store/audit-store.js";
import { TenantRestoreExecutionError } from "../store/tenant-backup-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

const requestParamsSchema = z.object({ organizationId: z.string().uuid(), requestId: z.string().uuid() });
const proposeRestoreBodySchema = z.object({ artifact: tenantBackupArtifactSchema }).strict();
const rejectRestoreBodySchema = z.object({ reason: z.string().max(2000).optional() }).strict();

/**
 * Enterprise backup, PITR, and tenant-scoped restore — see
 * store/tenant-backup-store.ts's header comment for the full contract
 * (what "restore" does and does not do, and why). Export is gated on its
 * own `tenantBackup:export` action; propose/approve on separate actions so
 * an organization can enforce real dual control (grant propose to one
 * population, approve to a different one) — same separation-of-duties
 * shape as routes/policy-versions.ts.
 */
export function registerTenantBackupRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/backup/export", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "tenantBackup:export", `organization:${organizationId}`);
        const artifact = await deps.tenantBackupStore.exportTenant(organizationId);
        reply
            .header("Content-Type", "application/json")
            .header("Content-Disposition", `attachment; filename="backup-${organizationId}-${Date.now()}.json"`)
            .send(artifact);
    });

    fastify.post("/organizations/:organizationId/backup/restore-requests", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "tenantBackup:proposeRestore", `organization:${organizationId}`);
        const body = proposeRestoreBodySchema.parse(request.body);

        if (body.artifact.organizationId !== organizationId) {
            return reply.code(400).send({ error: "organization_mismatch", message: "This backup was exported from a different organization." });
        }

        const created = await deps.tenantBackupStore.proposeRestore(organizationId, body.artifact, caller.id, actorFrom(caller));
        reply.code(201).send(created);
    });

    fastify.get("/organizations/:organizationId/backup/restore-requests", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        // Either role should see pending/past requests — a proposer tracks
        // their own submission, an approver needs the queue. No separate
        // "read" action; holding either decision-making permission implies
        // visibility into this workflow.
        const canPropose = await hasPermission(deps, caller, organizationId, "tenantBackup:proposeRestore");
        const canApprove = await hasPermission(deps, caller, organizationId, "tenantBackup:approveRestore");
        if (!canPropose && !canApprove) {
            await requirePermission(deps.store, caller, "tenantBackup:proposeRestore", `organization:${organizationId}`); // throws the standard 403
        }
        reply.send(await deps.tenantBackupStore.listRestoreRequests(organizationId));
    });

    fastify.post(
        "/organizations/:organizationId/backup/restore-requests/:requestId/approve",
        { preHandler: deps.authPreHandler },
        async (request, reply) => {
            const { organizationId, requestId } = requestParamsSchema.parse(request.params);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "tenantBackup:approveRestore", `organization:${organizationId}`);

            const existing = await deps.tenantBackupStore.getRestoreRequest(organizationId, requestId);
            if (!existing) return reply.code(404).send({ error: "not_found" });
            if (existing.status !== "pending") return reply.code(400).send({ error: "not_pending", message: "This restore request is no longer pending." });
            if (existing.requestedByUserId === caller.id) {
                return reply.code(400).send({ error: "self_approval", message: "You cannot approve your own restore request." });
            }

            try {
                const approved = await deps.tenantBackupStore.approveRestore(organizationId, requestId, actorFrom(caller));
                if (!approved) return reply.code(400).send({ error: "not_pending", message: "This restore request is no longer pending." });
                reply.send(approved);
            } catch (err) {
                if (err instanceof TenantRestoreExecutionError) {
                    // The store's own transaction already rolled back —
                    // this is a fresh, separate write recording the
                    // failure, deliberately outside that rolled-back
                    // transaction (a failed transaction can't record
                    // anything inside itself).
                    await deps.tenantBackupStore.markRestoreFailed(organizationId, requestId, err.message).catch(() => {});
                    return reply.code(500).send({ error: "restore_failed", message: err.message });
                }
                throw err;
            }
        }
    );

    fastify.post(
        "/organizations/:organizationId/backup/restore-requests/:requestId/reject",
        { preHandler: deps.authPreHandler },
        async (request, reply) => {
            const { organizationId, requestId } = requestParamsSchema.parse(request.params);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "tenantBackup:approveRestore", `organization:${organizationId}`);
            const body = rejectRestoreBodySchema.parse(request.body);

            const existing = await deps.tenantBackupStore.getRestoreRequest(organizationId, requestId);
            if (!existing) return reply.code(404).send({ error: "not_found" });
            if (existing.status !== "pending") return reply.code(400).send({ error: "not_pending", message: "This restore request is no longer pending." });

            const rejected = await deps.tenantBackupStore.rejectRestore(organizationId, requestId, body.reason, actorFrom(caller));
            if (!rejected) return reply.code(400).send({ error: "not_pending", message: "This restore request is no longer pending." });
            reply.send(rejected);
        }
    );
}

async function hasPermission(
    deps: RouteDeps,
    caller: Awaited<ReturnType<typeof requireOrgUser>>,
    organizationId: string,
    action: string
): Promise<boolean> {
    try {
        await requirePermission(deps.store, caller, action, `organization:${organizationId}`);
        return true;
    } catch {
        return false;
    }
}
