import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission } from "./guards.js";
import { organizationStudyParamsSchema } from "./params.js";

/**
 * Viewer sessions (item 8): authorize first, then issue a short-lived,
 * narrowly-scoped token — never a permanent object URL, credential, bucket
 * path, or PHI in a query string. routes/imaging-dicomweb.ts is the only
 * consumer of the token this issues; it is never itself a bearer credential
 * usable against any other route.
 */
const studyResourceName = (organizationId: string, studyId: string): string => `organization:${organizationId}/imagingStudy:${studyId}`;
export const hashViewerToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

const VIEWER_SESSION_TTL_MS = 30 * 60_000; // 30 minutes — short-lived; the viewer re-requests a session as needed, it never caches one long-term

const createViewerSessionBodySchema = z
    .object({
        seriesIds: z.array(z.string().min(1)).optional(),
        instanceIds: z.array(z.string().min(1)).optional(),
        requestDownload: z.boolean().default(false),
    })
    .strict();

export function registerImagingViewerSessionRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations/:organizationId/imaging/studies/:studyId/viewer-sessions", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const study = await repo.getStudy(studyId);
        if (!study) return reply.code(404).send({ error: "not_found" });
        const context = {
            "resource:ownerUserId": study.resource.ownerUserId, "resource:isOwner": String(study.resource.ownerUserId === caller.id),
            "resource:isAssigned": String(study.resource.assignedUserIds.includes(caller.id)), "resource:sensitivity": study.resource.sensitivity,
        };
        const canView = await isPermissionAllowed(deps.store, caller, "imagingStudy:view", studyResourceName(organizationId, studyId), context);
        if (!canView) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "imagingInstance:retrieve", studyResourceName(organizationId, studyId), context);

        const body = createViewerSessionBodySchema.parse(request.body);
        const grantedActions: ("view" | "measure" | "download")[] = ["view", "measure"];
        if (body.requestDownload) grantedActions.push("download"); // internal members are not subject to item 11's external-download-off-by-default rule

        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + VIEWER_SESSION_TTL_MS).toISOString();
        const session = await repo.createViewerSession(
            { userId: caller.id, studyId, seriesIds: body.seriesIds, instanceIds: body.instanceIds, grantedActions, tokenHash: hashViewerToken(token), expiresAt },
            actorFrom(caller)
        );
        reply.code(201).send({ session, token });
    });

    fastify.post("/organizations/:organizationId/imaging/viewer-sessions/:sessionId/revoke", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, sessionId } = z.object({ organizationId: z.string().uuid(), sessionId: z.string().min(1) }).parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        await repo.revokeViewerSession(sessionId, actorFrom(caller));
        reply.code(204).send();
    });
}
