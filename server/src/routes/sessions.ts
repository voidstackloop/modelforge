import type { SessionResourceAttributes, SharedChatSession } from "@modelforge/contracts";
import { sharedChatSessionSchema } from "@modelforge/contracts";
import type { FastifyInstance } from "fastify";
import { actorFrom } from "../store/audit-store.js";
import { publicFeed, type StoredSessionChange } from "../store/session-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission, type ResolvedPrincipal } from "./guards.js";
import { organizationParamsSchema, organizationSessionParamsSchema } from "./params.js";
import { withIdempotencyKey } from "./idempotency.js";

/**
 * Shared chat sessions (P1 item 7: remaining shared clinical domains) —
 * structurally identical to routes/cases.ts, one notch simpler:
 * SessionResourceAttributes has no workspaceId/departmentId/
 * activeConsentScopes (chat sessions have no existing UI concept of
 * department/workspace assignment or per-session consent — see
 * packages/contracts's doc comment on sharedChatSessionSchema for why
 * those were deliberately not invented here).
 *
 * Visibility: the owner and anyone in `assignedUserIds` can see a session
 * (chatSession:view, conditioned on resource:isOwner/resource:isAssigned);
 * the builtin OrganizationAdmin's `actions: ["*"]` sees everything, same
 * as it already does for cases. "Shared with the team" means an owner
 * explicitly adds teammates to assignedUserIds — never automatic org-wide
 * visibility.
 *
 * Only the fields in sharedChatSessionSchema are ever accepted/returned
 * here — the local-only ChatSession fields (`params`, `agentWorkspace`,
 * `projectId`) never reach this server at all; see that schema's own doc
 * comment for why (device/hardware-specific tuning, a local filesystem
 * path, and a device-only chat-organization concept respectively).
 */
const resourceName = (organizationId: string, sessionId: string): string => `organization:${organizationId}/chatSession:${sessionId}`;

function conditionContext(resource: SessionResourceAttributes, caller: ResolvedPrincipal): Record<string, string> {
    return {
        "resource:ownerUserId": resource.ownerUserId,
        "resource:isOwner": String(resource.ownerUserId === caller.id),
        "resource:isAssigned": String(resource.assignedUserIds.includes(caller.id)),
    };
}

async function canRead(deps: RouteDeps, caller: ResolvedPrincipal, entry: StoredSessionChange): Promise<boolean> {
    return isPermissionAllowed(deps.store, caller, "chatSession:view", resourceName(caller.organizationId, entry.change.sessionId), conditionContext(entry.resource, caller));
}

function resourceForCreate(organizationId: string, caller: ResolvedPrincipal, session: SharedChatSession): SessionResourceAttributes {
    return { organizationId, sessionId: session.id, ownerUserId: caller.id, assignedUserIds: session.assignedUserIds ?? [] };
}

function resourceForUpdate(current: SessionResourceAttributes, session: SharedChatSession): SessionResourceAttributes {
    return { ...current, assignedUserIds: session.assignedUserIds ?? current.assignedUserIds };
}

function accessMetadataChanged(a: SessionResourceAttributes, b: SessionResourceAttributes): boolean {
    return JSON.stringify([...a.assignedUserIds].sort()) !== JSON.stringify([...b.assignedUserIds].sort());
}

export function registerSessionRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/sessions", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repository = deps.sessionStore.forTenant(caller.tenantContext);
        const { since } = request.query as { since?: string };
        const feed = await repository.readChanges(since ?? null);
        const visibility = await Promise.all(feed.changes.map((entry) => canRead(deps, caller, entry)));
        const visible = feed.changes.filter((_entry, index) => visibility[index]);
        reply.send(publicFeed(visible, feed.cursor));
    });

    fastify.get("/organizations/:organizationId/sessions/:sessionId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, sessionId } = organizationSessionParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const current = await deps.sessionStore.forTenant(caller.tenantContext).getOne(sessionId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "chatSession:view", resourceName(organizationId, sessionId), conditionContext(current.resource, caller)))) {
            return reply.code(404).send({ error: "not_found" });
        }
        reply.send(current.session);
    });

    fastify.post("/organizations/:organizationId/sessions", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "chatSession:create", `organization:${organizationId}/chatSession:*`);
        const idempotency = await withIdempotencyKey(deps.idempotencyStore, organizationId, request, reply);
        if (idempotency.replay) return;
        const session = sharedChatSessionSchema.parse(request.body);
        const result = await deps.sessionStore
            .forTenant(caller.tenantContext)
            .writeOne(session, null, actorFrom(caller), resourceForCreate(organizationId, caller, session));
        if ("conflict" in result) {
            await idempotency.record(409, { error: "already_exists", current: result.current });
            return reply.code(409).send({ error: "already_exists", current: result.current });
        }
        await idempotency.record(201, result.session);
        reply.code(201).send(result.session);
    });

    fastify.put("/organizations/:organizationId/sessions/:sessionId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, sessionId } = organizationSessionParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repository = deps.sessionStore.forTenant(caller.tenantContext);
        const current = await repository.getOne(sessionId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "chatSession:edit", resourceName(organizationId, sessionId), conditionContext(current.resource, caller)))) {
            return reply.code(404).send({ error: "not_found" });
        }
        const idempotency = await withIdempotencyKey(deps.idempotencyStore, organizationId, request, reply);
        if (idempotency.replay) return;
        const session = sharedChatSessionSchema.parse(request.body);
        if (session.id !== sessionId) return reply.code(400).send({ error: "id_mismatch", message: "Body id must match the :sessionId path parameter." });
        const nextResource = resourceForUpdate(current.resource, session);
        if (accessMetadataChanged(current.resource, nextResource)) {
            await requirePermission(deps.store, caller, "chatSession:manageAccess", resourceName(organizationId, sessionId), conditionContext(current.resource, caller));
        }
        const ifMatch = request.headers["if-match"];
        const expectedVersion = typeof ifMatch === "string" && ifMatch.length > 0 ? ifMatch : null;
        const result = await repository.writeOne(session, expectedVersion, actorFrom(caller), nextResource);
        if ("conflict" in result) {
            await idempotency.record(412, { error: "precondition_failed", current: result.current });
            return reply.code(412).send({ error: "precondition_failed", current: result.current });
        }
        await idempotency.record(200, result.session);
        reply.send(result.session);
    });

    fastify.delete("/organizations/:organizationId/sessions/:sessionId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, sessionId } = organizationSessionParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repository = deps.sessionStore.forTenant(caller.tenantContext);
        const current = await repository.getOne(sessionId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "chatSession:delete", resourceName(organizationId, sessionId), conditionContext(current.resource, caller)))) {
            return reply.code(404).send({ error: "not_found" });
        }
        const ifMatch = request.headers["if-match"];
        const expectedVersion = typeof ifMatch === "string" && ifMatch.length > 0 ? ifMatch : null;
        const result = await repository.deleteOne(sessionId, expectedVersion, actorFrom(caller));
        if ("notFound" in result) return reply.code(404).send({ error: "not_found" });
        if ("conflict" in result) return reply.code(412).send({ error: "precondition_failed", current: result.current });
        reply.code(204).send();
    });
}
