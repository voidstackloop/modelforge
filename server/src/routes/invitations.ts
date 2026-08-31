import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import { bindTenantIamStore, createTenantContext } from "../tenant-context.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

const invitationParamsSchema = z.object({ organizationId: z.string().uuid(), invitationId: z.string().uuid() });
const createInvitationSchema = z.object({
    email: z.string().email(),
    displayName: z.string().min(1).optional(),
    expiresInHours: z.number().int().min(1).max(24 * 30).default(72),
});
const acceptInvitationSchema = z.object({ token: z.string().min(32).max(512) }).strict();
const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
const publicInvitation = <T extends { tokenHash: string }>(invitation: T): Omit<T, "tokenHash"> => {
    const { tokenHash: _secret, ...safe } = invitation;
    return safe;
};

export function registerInvitationRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/invitations", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:listUsers", `organization:${organizationId}`);
        reply.send((await deps.principalStore.listInvitations(organizationId)).map(publicInvitation));
    });

    fastify.post("/organizations/:organizationId/invitations", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:manageUsers", `organization:${organizationId}`);
        const body = createInvitationSchema.parse(request.body);
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000).toISOString();
        const invitation = await deps.principalStore.createInvitation(
            { organizationId, email: body.email.toLowerCase(), displayName: body.displayName, tokenHash: hashToken(token), invitedByUserId: caller.id, expiresAt },
            actorFrom(caller)
        );
        reply.code(201).send({ invitation: publicInvitation(invitation), token });
    });

    fastify.post("/organizations/:organizationId/invitations/:invitationId/accept", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, invitationId } = invitationParamsSchema.parse(request.params);
        const body = acceptInvitationSchema.parse(request.body);
        const invitation = await deps.principalStore.getInvitation(organizationId, invitationId);
        const auth = request.auth!;
        if (!invitation || invitation.status !== "pending" || (auth.email && auth.email.toLowerCase() !== invitation.email.toLowerCase())) {
            return reply.code(404).send({ error: "not_found" });
        }
        const organization = await deps.tenantDirectory.resolve(organizationId);
        if (!organization) return reply.code(404).send({ error: "not_found" });
        const context = createTenantContext(organization, request);
        const tenantStore = bindTenantIamStore(deps.store, context);
        // Checked against Membership, not "does a User row exist": a prior
        // acceptance attempt can fail after creating the User but before
        // ensureMembership succeeds (see the catch block below), which would
        // otherwise permanently 409-lock a legitimate retry against its own
        // orphaned User row even though no membership was ever established.
        const existingMemberships = await deps.principalStore.listMemberships(auth.issuer, auth.subject);
        if (existingMemberships.some((membership) => membership.organizationId === organizationId)) {
            return reply.code(409).send({ error: "membership_exists" });
        }
        const acceptActor = { externalSubject: auth.subject, organizationId };
        const accepted = await deps.principalStore.acceptInvitation(organizationId, invitationId, hashToken(body.token), acceptActor);
        if (!accepted) return reply.code(404).send({ error: "not_found" });
        try {
            const displayName = auth.name ?? accepted.displayName ?? accepted.email;
            const email = auth.email ?? accepted.email;
            const identity = await deps.principalStore.upsertIdentity({ issuer: auth.issuer, subject: auth.subject, displayName, email });
            // Reuse rather than unconditionally create: a retry after a
            // failure further down this same try block (e.g. ensureMembership
            // below) will find the User this attempt already made and finish
            // the job on it, instead of piling up a second orphaned User row
            // for the same subject on every retry — createUser itself has no
            // upsert-on-conflict behavior.
            const user =
                (await tenantStore.findUserByExternalSubject(auth.subject)) ??
                (await tenantStore.createUser({ externalSubject: auth.subject, displayName, email }, acceptActor));
            await deps.principalStore.ensureMembership(
                { organizationId, identityId: identity.id, userId: user.id, provisioningSource: "invitation" },
                actorFrom({ ...user, principalType: "human" })
            );
            reply.send({ invitation: publicInvitation(accepted), user });
        } catch (err) {
            // acceptInvitation above already consumed the token (status
            // 'pending' -> 'accepted') — it has to run first, since it's
            // also what verifies the token. A failure creating the
            // User/Membership after that would otherwise leave the
            // invitation permanently spent with no account ever created
            // for it, locking the invitee out with no way to retry the
            // same link. Best-effort: a cleanup failure must never mask
            // the original error the caller needs to see.
            await deps.principalStore.revertAcceptedInvitation(organizationId, invitationId, acceptActor).catch(() => {});
            throw err;
        }
    });

    fastify.delete("/organizations/:organizationId/invitations/:invitationId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, invitationId } = invitationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:manageUsers", `organization:${organizationId}`);
        const invitation = await deps.principalStore.revokeInvitation(organizationId, invitationId, actorFrom(caller));
        if (!invitation) return reply.code(404).send({ error: "not_found" });
        reply.code(204).send();
    });
}
