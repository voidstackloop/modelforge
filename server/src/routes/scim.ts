import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Invitation, Membership, ScimToken, User } from "../domain/types.js";
import { bindTenantIamStore, schemaNameForTenant, type TenantContext } from "../tenant-context.js";
import type { RouteDeps } from "./deps.js";
import { organizationParamsSchema } from "./params.js";

/**
 * SCIM 2.0 (RFC 7643/7644) provisioning endpoints — P2 backlog item 1
 * ("SCIM and external group reconciliation"). See docs/SCIM.md for the
 * full design and its disclosed limitations; the short version:
 *
 *  - Authenticated with a static bearer token (routes/scim-tokens.ts),
 *    never OIDC — SCIM provisioning happens *before* a real login, so
 *    there is no `sub` claim yet to verify against.
 *  - "Create a SCIM User" maps onto this codebase's existing Invitation
 *    mechanism, per an explicit product decision (asked directly rather
 *    than guessed at, given the real security stakes of an identity-
 *    binding mechanism): reuse the smallest, safest, already-tested path
 *    rather than inventing an identity-less User concept. The consequence:
 *    a SCIM resource's `id` is the Invitation's id while pending, and
 *    becomes the real User's id once accepted — NOT stable across that
 *    transition. A real IdP's periodic filter-based reconciliation
 *    (GET .../Users?filter=userName eq "...") always converges on the
 *    truth regardless; a client that cached the old id specifically would
 *    see a 404 after acceptance.
 *  - Groups are out of scope for this slice — SCIM group-membership push
 *    would need a way to apply a grant to a still-pending (Identity-less)
 *    invitee, which does not exist yet. Disclosed, not attempted.
 *  - DELETE never hard-deletes, matching this codebase's "never hard-
 *    delete" convention elsewhere (MasterVault's soft-delete-only design,
 *    tenant-backup's non-destructive restore): it has the same effect as
 *    PATCH/PUT with active=false — revoke a pending invitation, or
 *    suspend an existing membership.
 *  - PUT only ever acts on `active` — updating displayName/email on a
 *    still-pending invitation via PUT is not supported in this slice (no
 *    PrincipalStore.updateInvitation exists); PATCH/PUT on an
 *    already-accepted user does update displayName/email, via the normal
 *    updateUser path.
 */

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

// SCIM-created invitations get a longer default lifetime than the admin
// console's 72-hour default (createInvitationSchema in routes/invitations.ts):
// an IT-provisioned account is often created well ahead of someone's actual
// start date, not moments before they're expected to click through.
const SCIM_INVITATION_EXPIRY_HOURS = 24 * 90;

const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

function scimTenantContext(organizationId: string, tenantSchema: string | undefined, scimTokenId: string): TenantContext {
    const schemaName = tenantSchema ?? schemaNameForTenant(organizationId);
    return Object.freeze({ organizationId, schemaName, issuer: "scim", subject: scimTokenId });
}

function scimError(reply: FastifyReply, status: number, detail: string, scimType?: string): void {
    reply.code(status).send({ schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) });
}

/** Verifies the SCIM bearer token for `organizationId`, or sends a SCIM-
 * shaped 401 and returns undefined. Every route below calls this first,
 * before touching any tenant data. */
async function requireScimAuth(deps: RouteDeps, request: FastifyRequest, reply: FastifyReply, organizationId: string): Promise<ScimToken | undefined> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        scimError(reply, 401, "Authorization: Bearer <token> header is required.");
        return undefined;
    }
    const token = await deps.scimTokenStore.findActiveByHash(organizationId, hashToken(header.slice("Bearer ".length).trim()));
    if (!token) {
        scimError(reply, 401, "Invalid or revoked SCIM token.");
        return undefined;
    }
    return token;
}

interface ScimUserResource {
    schemas: string[];
    id: string;
    userName: string;
    displayName?: string;
    name?: { formatted: string };
    emails?: { value: string; primary: boolean }[];
    active: boolean;
    meta: { resourceType: "User"; created: string; lastModified: string };
}

function invitationToScim(invitation: Invitation): ScimUserResource {
    return {
        schemas: [SCIM_USER_SCHEMA],
        id: invitation.id,
        userName: invitation.email,
        displayName: invitation.displayName,
        name: invitation.displayName ? { formatted: invitation.displayName } : undefined,
        emails: [{ value: invitation.email, primary: true }],
        // "pending" and "accepted" both mean provisioning intent held; only
        // revoked/expired should read as inactive to a SCIM client.
        active: invitation.status === "pending" || invitation.status === "accepted",
        meta: { resourceType: "User", created: invitation.createdAt, lastModified: invitation.updatedAt },
    };
}

function userToScim(user: User, membership: Membership | undefined): ScimUserResource {
    return {
        schemas: [SCIM_USER_SCHEMA],
        id: user.id,
        userName: user.email ?? user.externalSubject,
        displayName: user.displayName,
        name: { formatted: user.displayName },
        emails: user.email ? [{ value: user.email, primary: true }] : undefined,
        active: user.status === "active" && (membership?.status ?? "active") === "active",
        meta: { resourceType: "User", created: user.createdAt, lastModified: user.updatedAt },
    };
}

async function membershipFor(deps: RouteDeps, organizationId: string, userId: string): Promise<Membership | undefined> {
    const memberships = await deps.principalStore.listMembershipsByOrganization(organizationId);
    return memberships.find((m) => m.userId === userId);
}

/** Tries a real User first (the "truth" once someone has actually accepted
 * and logged in), falling back to a still-pending invitation. */
async function findScimResourceById(deps: RouteDeps, organizationId: string, tenantContext: TenantContext, id: string): Promise<ScimUserResource | null> {
    const tenantRepo = bindTenantIamStore(deps.store, tenantContext);
    const user = await tenantRepo.getUser(id);
    if (user) return userToScim(user, await membershipFor(deps, organizationId, user.id));
    const invitation = await deps.principalStore.getInvitation(organizationId, id);
    return invitation ? invitationToScim(invitation) : null;
}

async function findScimResourceByEmail(deps: RouteDeps, organizationId: string, tenantContext: TenantContext, email: string): Promise<ScimUserResource | null> {
    const tenantRepo = bindTenantIamStore(deps.store, tenantContext);
    const normalized = email.toLowerCase();
    const users = await tenantRepo.listUsers();
    const user = users.find((u) => u.email?.toLowerCase() === normalized);
    if (user) return userToScim(user, await membershipFor(deps, organizationId, user.id));
    const invitations = await deps.principalStore.listInvitations(organizationId);
    const invitation = invitations.find((i) => i.email.toLowerCase() === normalized && i.status === "pending");
    return invitation ? invitationToScim(invitation) : null;
}

async function listAllScimResources(deps: RouteDeps, organizationId: string, tenantContext: TenantContext): Promise<ScimUserResource[]> {
    const tenantRepo = bindTenantIamStore(deps.store, tenantContext);
    const users = await tenantRepo.listUsers();
    const memberships = await deps.principalStore.listMembershipsByOrganization(organizationId);
    const userViews = users
        .filter((u) => u.email !== undefined)
        .map((u) => userToScim(u, memberships.find((m) => m.userId === u.id)));
    const knownEmails = new Set(userViews.map((v) => v.userName.toLowerCase()));
    const invitations = await deps.principalStore.listInvitations(organizationId);
    const invitationViews = invitations
        .filter((i) => i.status === "pending" && !knownEmails.has(i.email.toLowerCase()))
        .map(invitationToScim);
    return [...userViews, ...invitationViews];
}

// Only the one filter every real SCIM client actually sends for idempotent
// sync (`userName eq "value"`) — SCIM's full filter grammar (RFC 7644 §3.4.2.2)
// supports and/or/not, other operators, and complex attribute paths, none
// of which is worth the parser surface for what institutional IdPs use in
// practice. An unsupported filter expression is rejected with 400, not
// silently ignored (which would return an unfiltered list a client might
// mistake for "no matches" or "everyone matches").
function parseUserNameEqFilter(filter: string): string | null {
    const match = /^userName\s+eq\s+"([^"]*)"$/i.exec(filter.trim());
    return match ? match[1] : null;
}

const createUserBodySchema = z.object({
    schemas: z.array(z.string()).optional(),
    userName: z.string().email(),
    displayName: z.string().min(1).optional(),
    name: z.object({ formatted: z.string().min(1).optional() }).optional(),
    active: z.boolean().optional(),
});

const patchOpSchema = z.object({
    Operations: z.array(
        z.object({
            op: z.string(),
            path: z.string().optional(),
            value: z.unknown().optional(),
        })
    ),
});

/** Extracts a target `active` boolean from a SCIM PatchOp body, supporting
 * both real-world shapes: Azure AD's path-based `{op,path:"active",value:bool}`
 * and Okta's value-object `{op,value:{active:bool}}`. Returns undefined if
 * no operation in the payload sets `active` — callers no-op in that case
 * rather than guessing. */
function extractActiveFromPatch(body: z.infer<typeof patchOpSchema>): boolean | undefined {
    for (const operation of body.Operations) {
        if (operation.op.toLowerCase() !== "replace" && operation.op.toLowerCase() !== "add") continue;
        if (operation.path?.toLowerCase() === "active" && typeof operation.value === "boolean") {
            return operation.value;
        }
        if (!operation.path && typeof operation.value === "object" && operation.value !== null && "active" in operation.value) {
            const value = (operation.value as { active: unknown }).active;
            if (typeof value === "boolean") return value;
        }
    }
    return undefined;
}

/** The one mutation every deprovisioning/reprovisioning path (PATCH, PUT,
 * DELETE) reduces to: flip whichever underlying record `id` resolves to.
 * `active=false` revokes a still-pending invitation (nothing to "suspend"
 * yet) or suspends an existing membership; `active=true` only ever
 * reactivates an existing suspended membership — SCIM has no concept of
 * "unrevoke an invitation," and this codebase's invitations are one-shot
 * by design (see routes/invitations.ts). */
async function setActive(deps: RouteDeps, organizationId: string, tenantContext: TenantContext, id: string, active: boolean, actorExternalSubject: string): Promise<ScimUserResource | null> {
    const actor = { externalSubject: actorExternalSubject, userId: undefined, organizationId };
    const tenantRepo = bindTenantIamStore(deps.store, tenantContext);
    const user = await tenantRepo.getUser(id);
    if (user) {
        await tenantRepo.updateUser(id, { status: active ? "active" : "suspended" }, actor);
        await deps.principalStore.setMembershipStatus(organizationId, id, active ? "active" : "suspended", actor);
        const updated = await tenantRepo.getUser(id);
        return updated ? userToScim(updated, await membershipFor(deps, organizationId, id)) : null;
    }
    const invitation = await deps.principalStore.getInvitation(organizationId, id);
    if (invitation && invitation.status === "pending") {
        if (!active) {
            const revoked = await deps.principalStore.revokeInvitation(organizationId, id, actor);
            return revoked ? invitationToScim(revoked) : null;
        }
        return invitationToScim(invitation); // already the closest thing to "active" a pending invitation has
    }
    return null;
}

export function registerScimRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    // Lightweight, mostly-static discovery endpoints — several real IdP
    // SCIM-connector setup wizards fetch these before the first real Users
    // call, and a missing/erroring response can fail their "test
    // connection" step even though the actual CRUD endpoints work fine.
    fastify.get("/scim/v2/organizations/:organizationId/ServiceProviderConfig", async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        if (!(await requireScimAuth(deps, request, reply, organizationId))) return;
        reply.send({
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
            patch: { supported: true },
            bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
            filter: { supported: true, maxResults: 200 },
            changePassword: { supported: false },
            sort: { supported: false },
            etag: { supported: false },
            authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer Token", description: "A static per-connector bearer token issued via the admin console." }],
        });
    });

    fastify.get("/scim/v2/organizations/:organizationId/ResourceTypes", async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        if (!(await requireScimAuth(deps, request, reply, organizationId))) return;
        reply.send([
            {
                schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
                id: "User",
                name: "User",
                endpoint: "/Users",
                schema: SCIM_USER_SCHEMA,
            },
        ]);
    });

    fastify.get("/scim/v2/organizations/:organizationId/Users", async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const scimToken = await requireScimAuth(deps, request, reply, organizationId);
        if (!scimToken) return;
        const organization = await deps.tenantDirectory.resolve(organizationId);
        if (!organization) return scimError(reply, 404, "Organization not found.");
        const tenantContext = scimTenantContext(organizationId, organization.tenantSchema, scimToken.id);

        const query = request.query as { filter?: string; startIndex?: string; count?: string };
        let resources: ScimUserResource[];
        if (query.filter) {
            const email = parseUserNameEqFilter(query.filter);
            if (email === null) {
                return scimError(reply, 400, `Unsupported filter expression: "${query.filter}". Only userName eq "value" is supported.`, "invalidFilter");
            }
            const match = await findScimResourceByEmail(deps, organizationId, tenantContext, email);
            resources = match ? [match] : [];
        } else {
            resources = await listAllScimResources(deps, organizationId, tenantContext);
        }

        const startIndex = Math.max(1, Number(query.startIndex) || 1);
        const count = Math.min(200, Number(query.count) || 100);
        const page = resources.slice(startIndex - 1, startIndex - 1 + count);
        reply.send({
            schemas: [SCIM_LIST_RESPONSE_SCHEMA],
            totalResults: resources.length,
            startIndex,
            itemsPerPage: page.length,
            Resources: page,
        });
    });

    fastify.get("/scim/v2/organizations/:organizationId/Users/:id", async (request, reply) => {
        const { organizationId, id } = z.object({ organizationId: z.string().uuid(), id: z.string() }).parse(request.params);
        const scimToken = await requireScimAuth(deps, request, reply, organizationId);
        if (!scimToken) return;
        const organization = await deps.tenantDirectory.resolve(organizationId);
        if (!organization) return scimError(reply, 404, "Organization not found.");
        const tenantContext = scimTenantContext(organizationId, organization.tenantSchema, scimToken.id);
        const resource = await findScimResourceById(deps, organizationId, tenantContext, id);
        if (!resource) return scimError(reply, 404, `User ${id} not found.`);
        reply.send(resource);
    });

    fastify.post("/scim/v2/organizations/:organizationId/Users", async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const scimToken = await requireScimAuth(deps, request, reply, organizationId);
        if (!scimToken) return;
        const organization = await deps.tenantDirectory.resolve(organizationId);
        if (!organization) return scimError(reply, 404, "Organization not found.");
        const tenantContext = scimTenantContext(organizationId, organization.tenantSchema, scimToken.id);

        const body = createUserBodySchema.parse(request.body);
        const email = body.userName.toLowerCase();
        const existing = await findScimResourceByEmail(deps, organizationId, tenantContext, email);
        if (existing) return scimError(reply, 409, `userName ${email} already exists.`, "uniqueness");

        const expiresAt = new Date(Date.now() + SCIM_INVITATION_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
        // A real, usable acceptance token — not a throwaway value. Without
        // this, a SCIM-created invitation would be permanently unacceptable:
        // routes/invitations.ts's accept endpoint requires the actual
        // token, and nothing else about "SCIM" changes that requirement.
        // Attributed to the SCIM token's own creator (the admin who set up
        // this connector), since there is no human "inviter" in an
        // automated provisioning call.
        const acceptanceToken = randomBytes(32).toString("base64url");
        const invitation = await deps.principalStore.createInvitation(
            {
                organizationId,
                email,
                displayName: body.displayName ?? body.name?.formatted,
                tokenHash: hashToken(acceptanceToken),
                invitedByUserId: scimToken.createdByUserId,
                expiresAt,
            },
            { externalSubject: `scim:${scimToken.id}`, userId: undefined, organizationId }
        );
        reply.code(201).send({
            ...invitationToScim(invitation),
            // Non-standard extension attribute — SCIM itself has no concept
            // of "a secret the provisioning target needs delivered out of
            // band." This is the only moment this plaintext token is ever
            // retrievable (routes/invitations.ts's own GET list strips it,
            // same one-time-reveal property as an admin-console-created
            // invitation — that reveal just normally happens in a human's
            // browser, not an automated connector's HTTP response). The
            // organization is responsible for actually getting this to the
            // invitee — most IdPs' SCIM connectors surface the raw response
            // in their own provisioning/request logs for exactly this kind
            // of operational need. See docs/SCIM.md.
            modelforgeInviteToken: acceptanceToken,
        });
    });

    fastify.put("/scim/v2/organizations/:organizationId/Users/:id", async (request, reply) => {
        const { organizationId, id } = z.object({ organizationId: z.string().uuid(), id: z.string() }).parse(request.params);
        const scimToken = await requireScimAuth(deps, request, reply, organizationId);
        if (!scimToken) return;
        const organization = await deps.tenantDirectory.resolve(organizationId);
        if (!organization) return scimError(reply, 404, "Organization not found.");
        const tenantContext = scimTenantContext(organizationId, organization.tenantSchema, scimToken.id);

        const body = createUserBodySchema.parse(request.body);
        const resource = await setActive(deps, organizationId, tenantContext, id, body.active ?? true, `scim:${scimToken.id}`);
        if (!resource) return scimError(reply, 404, `User ${id} not found.`);
        reply.send(resource);
    });

    fastify.patch("/scim/v2/organizations/:organizationId/Users/:id", async (request, reply) => {
        const { organizationId, id } = z.object({ organizationId: z.string().uuid(), id: z.string() }).parse(request.params);
        const scimToken = await requireScimAuth(deps, request, reply, organizationId);
        if (!scimToken) return;
        const organization = await deps.tenantDirectory.resolve(organizationId);
        if (!organization) return scimError(reply, 404, "Organization not found.");
        const tenantContext = scimTenantContext(organizationId, organization.tenantSchema, scimToken.id);

        const body = patchOpSchema.parse(request.body);
        const active = extractActiveFromPatch(body);
        if (active === undefined) {
            // No-op: nothing this slice understands was in the PatchOp —
            // per RFC 7644 §3.5.2, still a valid, successful no-op response,
            // not an error (a client patching an attribute this server
            // doesn't model, e.g. a custom extension, shouldn't fail).
            const current = await findScimResourceById(deps, organizationId, tenantContext, id);
            if (!current) return scimError(reply, 404, `User ${id} not found.`);
            return reply.send(current);
        }
        const resource = await setActive(deps, organizationId, tenantContext, id, active, `scim:${scimToken.id}`);
        if (!resource) return scimError(reply, 404, `User ${id} not found.`);
        reply.send(resource);
    });

    fastify.delete("/scim/v2/organizations/:organizationId/Users/:id", async (request, reply) => {
        const { organizationId, id } = z.object({ organizationId: z.string().uuid(), id: z.string() }).parse(request.params);
        const scimToken = await requireScimAuth(deps, request, reply, organizationId);
        if (!scimToken) return;
        const organization = await deps.tenantDirectory.resolve(organizationId);
        if (!organization) return scimError(reply, 404, "Organization not found.");
        const tenantContext = scimTenantContext(organizationId, organization.tenantSchema, scimToken.id);

        const resource = await setActive(deps, organizationId, tenantContext, id, false, `scim:${scimToken.id}`);
        if (!resource) return scimError(reply, 404, `User ${id} not found.`);
        reply.code(204).send();
    });
}
