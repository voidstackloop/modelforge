import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

const tokenParamsSchema = z.object({ organizationId: z.string().uuid(), tokenId: z.string().uuid() });
const createTokenBodySchema = z.object({ name: z.string().min(1) }).strict();
const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** Never returns tokenHash — same reason routes/invitations.ts's
 * publicInvitation strips tokenHash: the plaintext bearer secret is shown
 * exactly once, at creation, and never again. */
const publicToken = <T extends { tokenHash: string }>(token: T): Omit<T, "tokenHash"> => {
    const { tokenHash: _secret, ...safe } = token;
    return safe;
};

/**
 * Admin management of SCIM bearer tokens — OIDC-authenticated, gated on
 * scim:manageTokens, distinct from routes/scim.ts's SCIM protocol endpoints
 * themselves (which authenticate with the token this issues, not OIDC).
 */
export function registerScimTokenRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/scim-tokens", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "scim:manageTokens", `organization:${organizationId}`);
        reply.send((await deps.scimTokenStore.listByOrganization(organizationId)).map(publicToken));
    });

    fastify.post("/organizations/:organizationId/scim-tokens", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "scim:manageTokens", `organization:${organizationId}`);
        const body = createTokenBodySchema.parse(request.body);
        const secret = randomBytes(32).toString("base64url");
        const token = await deps.scimTokenStore.create(organizationId, body.name, hashToken(secret), caller.id, actorFrom(caller));
        reply.code(201).send({ token: publicToken(token), secret });
    });

    fastify.delete("/organizations/:organizationId/scim-tokens/:tokenId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, tokenId } = tokenParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "scim:manageTokens", `organization:${organizationId}`);
        const revoked = await deps.scimTokenStore.revoke(organizationId, tokenId, actorFrom(caller));
        if (!revoked) return reply.code(404).send({ error: "not_found" });
        reply.code(204).send();
    });
}
