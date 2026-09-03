import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { completeLaunchCallback, createLaunchSession, SmartLaunchCallbackError, SmartLaunchError } from "../smart-launch/service.js";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema, organizationSmartLaunchSessionParamsSchema, organizationSmartLaunchStateParamsSchema } from "./params.js";

/**
 * SMART App Launch, client role — see packages/contracts/src/smart-launch.ts
 * and docs/SMART_LAUNCH.md for the full flow and its standing design
 * decision: every route here sits behind the same bearer-token
 * `deps.authPreHandler` every other route in this API does. There is no
 * unauthenticated redirect entry point — a launch always starts from an
 * already-authenticated ModelForge caller, who is handed an authorization
 * URL to navigate to (a client-side redirect this server does not itself
 * perform), not the other way around.
 *
 * `smartLaunch:manage` gates the admin-configured trusted-issuer allowlist
 * (client_id, allowed redirect URIs — the two things that make the
 * exact-match validation in smart-launch/service.ts meaningful);
 * `smartLaunch:use` gates any org member actually starting/completing a
 * launch or managing their own resulting sessions. A completed launch's
 * token is never returned in any response body — see
 * store/smart-launch-store.ts's own publicToken/publicLaunchSession.
 */
// issuer identifies the trusted-issuer row within the request body, not
// the URL path — a full URL is an awkward path segment, and PUT/DELETE
// both need one either way.
const upsertTrustedIssuerBodySchema = z
    .object({
        issuer: z.string().url().max(2_000),
        clientId: z.string().min(1).max(500),
        redirectUris: z.array(z.string().url().max(2_000)).min(1).max(20),
    })
    .strict();

const deleteTrustedIssuerBodySchema = z.object({ issuer: z.string().url().max(2_000) }).strict();

const createLaunchSessionBodySchema = z
    .object({
        issuer: z.string().url().max(2_000),
        redirectUri: z.string().url().max(2_000),
        scopes: z.array(z.string().min(1).max(200)).max(20).optional(),
        launch: z.string().max(500).optional(),
    })
    .strict();

const callbackBodySchema = z.object({ code: z.string().min(1).max(2_000) }).strict();

export function registerSmartLaunchRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    // --- Trusted issuer administration ---------------------------------

    fastify.put("/organizations/:organizationId/smart/trusted-issuers", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "smartLaunch:manage", `organization:${organizationId}/smartLaunchTrustedIssuers`);
        const body = upsertTrustedIssuerBodySchema.parse(request.body);
        const repo = deps.smartLaunchStore.forTenant(caller.tenantContext);
        const trusted = await repo.upsertTrustedIssuer({ issuer: body.issuer, clientId: body.clientId, redirectUris: body.redirectUris, addedByUserId: caller.id }, actorFrom(caller));
        reply.code(200).send(trusted);
    });

    // Readable by smartLaunch:use as well as smartLaunch:manage — a
    // clinician has to know which EHRs are configured (issuer, clientId,
    // redirectUris) to actually start a launch, and none of that is
    // secret (this is a public PKCE client; there is no client_secret to
    // protect here, see smart-launch/service.ts's own doc comment). Only
    // PUT/delete below stay manage-only.
    fastify.get("/organizations/:organizationId/smart/trusted-issuers", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const resource = `organization:${organizationId}/smartLaunchTrustedIssuers`;
        const canManage = await isPermissionAllowed(deps.store, caller, "smartLaunch:manage", resource);
        const canUse = canManage || (await isPermissionAllowed(deps.store, caller, "smartLaunch:use", `organization:${organizationId}/smartLaunchSessions`));
        if (!canUse) return reply.code(403).send({ error: "forbidden", message: 'Not authorized to perform "smartLaunch:use" or "smartLaunch:manage" on this organization.' });
        const repo = deps.smartLaunchStore.forTenant(caller.tenantContext);
        reply.send({ trustedIssuers: await repo.listTrustedIssuers() });
    });

    fastify.post("/organizations/:organizationId/smart/trusted-issuers/delete", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "smartLaunch:manage", `organization:${organizationId}/smartLaunchTrustedIssuers`);
        const body = deleteTrustedIssuerBodySchema.parse(request.body);
        const repo = deps.smartLaunchStore.forTenant(caller.tenantContext);
        const deleted = await repo.deleteTrustedIssuer(body.issuer, actorFrom(caller));
        if (!deleted) return reply.code(404).send({ error: "not_found" });
        reply.code(204).send();
    });

    // --- Launch flow -----------------------------------------------------

    fastify.post("/organizations/:organizationId/smart/launch-sessions", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "smartLaunch:use", `organization:${organizationId}/smartLaunchSessions`);
        const body = createLaunchSessionBodySchema.parse(request.body);
        const repo = deps.smartLaunchStore.forTenant(caller.tenantContext);
        try {
            const result = await createLaunchSession({ repo, requestedByUserId: caller.id, issuer: body.issuer, redirectUri: body.redirectUri, scopes: body.scopes, launch: body.launch, actor: actorFrom(caller) });
            reply.code(201).send(result);
        } catch (err) {
            if (err instanceof SmartLaunchError) return reply.code(422).send({ error: err.code, message: err.message });
            throw err;
        }
    });

    fastify.post("/organizations/:organizationId/smart/launch-sessions/:state/callback", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, state } = organizationSmartLaunchStateParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "smartLaunch:use", `organization:${organizationId}/smartLaunchSessions`);
        if (!deps.smartLaunchEncryptionKey) {
            return reply.code(503).send({ error: "smart_launch_unavailable", message: "SMART_LAUNCH_ENCRYPTION_KEY is not configured on this server; no launch token can be safely stored." });
        }
        const body = callbackBodySchema.parse(request.body);
        const repo = deps.smartLaunchStore.forTenant(caller.tenantContext);
        try {
            const token = await completeLaunchCallback({ repo, state, code: body.code, callerId: caller.id, encryptionKey: deps.smartLaunchEncryptionKey, actor: actorFrom(caller) });
            reply.code(201).send(token);
        } catch (err) {
            if (err instanceof SmartLaunchCallbackError) {
                const status = err.code === "session_not_found" ? 404 : err.code === "forbidden" ? 403 : 409;
                return reply.code(status).send({ error: err.code, message: err.message });
            }
            throw err;
        }
    });

    // --- Session management (a caller's own sessions only) --------------

    fastify.get("/organizations/:organizationId/smart/sessions", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "smartLaunch:use", `organization:${organizationId}/smartLaunchSessions`);
        const repo = deps.smartLaunchStore.forTenant(caller.tenantContext);
        reply.send({ sessions: await repo.listTokensForUser(caller.id) });
    });

    fastify.post("/organizations/:organizationId/smart/sessions/:sessionId/revoke", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, sessionId } = organizationSmartLaunchSessionParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "smartLaunch:use", `organization:${organizationId}/smartLaunchSessions`);
        const repo = deps.smartLaunchStore.forTenant(caller.tenantContext);
        const existing = await repo.getToken(sessionId);
        // Identical 404 for absent and "exists but belongs to someone
        // else" — same nondisclosure discipline as every other resource
        // route in this API.
        if (!existing || existing.requestedByUserId !== caller.id) return reply.code(404).send({ error: "not_found" });
        await repo.deleteToken(sessionId, actorFrom(caller));
        reply.code(204).send();
    });
}
