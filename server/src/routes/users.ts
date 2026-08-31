import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema, organizationUserParamsSchema } from "./params.js";

// .uuid() here (not just z.string(), matching params.ts's deliberate use of
// .uuid() for path params) — every group/policy id in this store is a
// server-generated randomUUID(), so a non-UUID value is never legitimate.
// Without this, a malformed id used to reach the store layer: silently
// dropped with no error in InMemoryIamStore (a Map.get() miss looks the
// same as "doesn't exist"), or a raw Postgres "invalid input syntax for
// type uuid" 500 in PostgresIamStore — neither is the clean 400 a
// malformed request should get.
const createUserBodySchema = z.object({
    externalSubject: z.string().min(1),
    displayName: z.string().min(1),
    email: z.string().optional(),
    groupIds: z.array(z.string().uuid()).optional(),
    policyIds: z.array(z.string().uuid()).optional(),
    permissionBoundaryPolicyId: z.string().uuid().optional(),
});

const updateUserBodySchema = z
    .object({
        displayName: z.string().min(1).optional(),
        email: z.string().optional(),
        status: z.enum(["active", "suspended"]).optional(),
        groupIds: z.array(z.string().uuid()).optional(),
        policyIds: z.array(z.string().uuid()).optional(),
        permissionBoundaryPolicyId: z.string().uuid().optional(),
    })
    .strict();

/**
 * Every route here requires the *caller* to already hold an account with
 * iam:listUsers/iam:manageUsers in the target organization (see
 * guards.ts's requirePermission) — this is exactly the "only an existing
 * admin (or the org-bootstrap flow) can create a User record" rule
 * organizations.ts's doc comment describes. There is no self-service
 * sign-up path here by design: an institution's IAM data should only ever
 * grow through someone already holding that authority granting it.
 */
export function registerUserRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/users", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:listUsers", `organization:${organizationId}`);
        reply.send(await caller.tenantStore.listUsers());
    });

    fastify.post("/organizations/:organizationId/users", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:manageUsers", `organization:${organizationId}`);

        const body = createUserBodySchema.parse(request.body);
        // Attaching a policyId directly is a security-posture change, not a
        // user-administration one — iam:manageUsers alone must not be able
        // to grant a user any policy, including this org's own builtin
        // admin policy (whose id is trivially discoverable via
        // iam:listPolicies or the bootstrap response). Real AWS IAM draws
        // this exact line: iam:AttachUserPolicy/iam:PutUserPolicy are
        // separate permissions from iam:CreateUser/iam:UpdateUser, because
        // collapsing them is a well-known escalation shape. groupIds isn't
        // gated the same way: assigning someone to an *existing* group is
        // ordinary user administration — the actual grant happened when
        // that group's own policyIds were set (createGroup/updateGroup,
        // which already require iam:managePolicies too — see groups.ts).
        // A permission boundary is at least as security-sensitive as a
        // direct policy attachment (it's the ceiling on everything else
        // this user could ever be granted) — same gate, same reasoning.
        if (body.policyIds !== undefined || body.permissionBoundaryPolicyId !== undefined) {
            await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);
        }
        // A new user is created with exactly the groups/policies the caller
        // explicitly requested — never a default grant. An admin who wants
        // a brand-new user to have zero access simply omits both fields;
        // that user then exists but can do nothing until explicitly granted
        // something, matching AWS IAM's "a new principal starts with no
        // permissions" default.
        const identity = await deps.principalStore.upsertIdentity({
            issuer: request.auth!.issuer,
            subject: body.externalSubject,
            displayName: body.displayName,
            email: body.email,
        });
        const user = await caller.tenantStore.createUser(body, actorFrom(caller));
        await deps.principalStore.ensureMembership(
            { organizationId, identityId: identity.id, userId: user.id, provisioningSource: "admin" },
            actorFrom(caller)
        );
        reply.code(201).send(user);
    });

    fastify.patch("/organizations/:organizationId/users/:userId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, userId } = organizationUserParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:manageUsers", `organization:${organizationId}`);

        const existing = await caller.tenantStore.getUser(userId);
        // 404, not 403, when the user id belongs to a *different*
        // organization than the one in the URL — this endpoint is scoped
        // to organizationId, and a user record from another org simply
        // doesn't exist from this endpoint's point of view.
        if (!existing || existing.organizationId !== organizationId) {
            return reply.code(404).send({ error: "not_found", message: "User not found in this organization." });
        }

        const body = updateUserBodySchema.parse(request.body);
        // See the POST handler above for why this is gated separately —
        // same rule applies to changing an existing user's direct policy
        // attachments or permission boundary.
        if (body.policyIds !== undefined || body.permissionBoundaryPolicyId !== undefined) {
            await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);
        }
        const updated = await caller.tenantStore.updateUser(userId, body, actorFrom(caller));
        if (body.status !== undefined) {
            await deps.principalStore.setMembershipStatus(
                organizationId,
                userId,
                body.status === "active" ? "active" : "suspended",
                actorFrom(caller)
            );
        }
        reply.send(updated);
    });
}
