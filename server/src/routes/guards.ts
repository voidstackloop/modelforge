import type { FastifyRequest } from "fastify";
import { evaluateWithBoundary } from "../domain/policy-evaluator.js";
import type { AuthorizationPrincipal, Policy } from "../domain/types.js";
import { authzDecisionDuration, startTimer } from "../metrics.js";
import type { IamStore } from "../store/iam-store.js";
import { bindTenantIamStore, createTenantContext, type TenantContext, type TenantIamRepository } from "../tenant-context.js";
import type { RouteDeps } from "./deps.js";

export class AuthzError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string
    ) {
        super(message);
        this.name = "AuthzError";
    }
}

/**
 * Resolves the calling human or service principal for a given organization from the
 * already-verified bearer token (`request.auth`, set by
 * ../auth/auth-plugin.ts) — never from anything client-supplied like a body
 * field or path parameter claiming to be a user id. Throws AuthzError(403)
 * unless it has an active membership-backed User or an active service
 * principal in the target organization. Human identities are created by
 * bootstrap, invitation acceptance, or an administrator; a valid bearer
 * token never grants membership by itself. Suspended/expired principals
 * fail closed.
 */
export type ResolvedPrincipal = AuthorizationPrincipal & {
    readonly tenantContext: TenantContext;
    readonly tenantStore: TenantIamRepository;
    /** The specific policy an active BreakGlassGrant snapshotted for this
     * user, if any — undefined in the overwhelming common case. Resolved
     * here, once per request, the same uncached "plain field, checked
     * live" way the membership-expiry check just above is — never routed
     * through resolveEffectivePolicies' epoch-cached path, so there is
     * nothing for an authorization epoch to invalidate. Only ever set for
     * principalType "human" — break-glass is a self-service, justification-
     * driven human action; service principals cannot invoke it. */
    readonly activeBreakGlassPolicy?: Policy;
};

export async function requireOrgUser(deps: RouteDeps, request: FastifyRequest, organizationId: string): Promise<ResolvedPrincipal> {
    if (!request.auth) throw new AuthzError(401, "Not authenticated.");
    const organization = await deps.tenantDirectory.resolve(organizationId);
    if (!organization) throw new AuthzError(403, "No account exists for this identity in this organization.");
    const tenantContext = createTenantContext(organization, request);
    const tenantStore = bindTenantIamStore(deps.store, tenantContext);
    const user = await tenantStore.findUserByExternalSubject(request.auth.subject);
    if (user) {
        if (user.status !== "active") throw new AuthzError(403, "This account is suspended.");
        const memberships = await deps.principalStore.listMemberships(request.auth.issuer, request.auth.subject);
        const membership = memberships.find((item) => item.organizationId === organizationId);
        if (!membership && (await deps.principalStore.findIdentity(request.auth.issuer, request.auth.subject))) {
            throw new AuthzError(403, "No active membership exists for this identity in this organization.");
        }
        if (membership && (membership.status !== "active" || (membership.expiresAt !== undefined && membership.expiresAt <= new Date().toISOString()))) {
            throw new AuthzError(403, "This membership is not active.");
        }
        const grant = await deps.accessGovernanceStore.getActiveBreakGlassGrant(organizationId, user.id);
        const activeBreakGlassPolicy = grant ? ((await tenantStore.getPolicy(grant.emergencyPolicyId)) ?? undefined) : undefined;
        return Object.assign(user, { principalType: "human" as const, tenantContext, tenantStore, activeBreakGlassPolicy });
    }

    const service = await deps.principalStore.findServicePrincipal(organizationId, request.auth.issuer, request.auth.subject);
    if (!service) throw new AuthzError(403, "No account exists for this identity in this organization.");
    if (service.status !== "active") throw new AuthzError(403, "This service principal is not active.");
    return Object.assign(service, { principalType: "service" as const, groupIds: [] as [], tenantContext, tenantStore });
}

/**
 * Resolves what evaluateWithBoundary needs for one user: their full
 * effective policy set, plus their permission boundary policy if they have
 * one configured. Shared by requirePermission (below) and
 * routes/authz.ts's POST /authz/check handler — the only two places that
 * ever call evaluateWithBoundary — specifically so both give the same
 * answer for the same user rather than each re-implementing boundary
 * resolution and risking the two drifting apart (exactly the bug this
 * function's own introduction fixed: /authz/check used to call
 * evaluatePolicies directly and silently ignored boundaries entirely).
 *
 * Returns `{ deniedByMissingBoundary: true }` when `user.permissionBoundaryPolicyId`
 * is set but no longer resolves to a real policy (deleted after being
 * attached — see domain/types.ts's userSchema doc comment on this field).
 * Callers must treat that as an unconditional Deny without ever reaching
 * evaluateWithBoundary — a *missing* boundary must never be treated the
 * same as *no* boundary, since that would let deleting a policy silently
 * remove the ceiling it was enforcing.
 */
export async function resolveEffectivePoliciesWithBoundary(
    _store: IamStore,
    user: ResolvedPrincipal
): Promise<{ policies: Policy[]; boundary: Policy | undefined } | { deniedByMissingBoundary: true }> {
    const basePolicies =
        user.principalType === "human"
            ? await user.tenantStore.resolveEffectivePolicies(user.id)
            : (await Promise.all(user.policyIds.map((policyId) => user.tenantStore.getPolicy(policyId)))).filter(
                  (policy): policy is Policy => policy !== null
              );
    // Appended, not exempted from the boundary intersection below — an
    // active break-glass grant still can't let a boundary-capped user
    // exceed their configured ceiling, and an explicit Deny anywhere in
    // the user's normal policies still wins (evaluatePolicies scans every
    // statement in the whole list). See guards.ts's activeBreakGlassPolicy
    // doc comment for why this bypasses the epoch-cached path entirely.
    const policies =
        user.principalType === "human" && user.activeBreakGlassPolicy ? [...basePolicies, user.activeBreakGlassPolicy] : basePolicies;
    if (user.permissionBoundaryPolicyId === undefined) return { policies, boundary: undefined };
    const boundary = await user.tenantStore.getPolicy(user.permissionBoundaryPolicyId);
    if (!boundary) return { deniedByMissingBoundary: true };
    return { policies, boundary };
}

/**
 * Requires the resolved user to be allowed `action` on `resource`, per
 * ../domain/policy-evaluator.ts's evaluateWithBoundary() over the user's
 * full effective policy set (and, if configured, their permission
 * boundary — see resolveEffectivePoliciesWithBoundary above). Throws
 * AuthzError(403) with no further detail on denial — never explains *why*
 * (e.g. "matched an explicit Deny statement X") in the response, so a
 * denied caller can't use this as a permission-probing oracle to map out
 * an organization's policies.
 *
 * `context` is caller-supplied condition-matching data; `user:id` and
 * `user:organizationId` are always set by this function *after* spreading
 * the caller's context, so a caller can never override its own resolved
 * identity by sending a context key with the same name — the one place in
 * this file that actually enforces "the client is never trusted for this."
 */
export async function requirePermission(
    store: IamStore,
    user: ResolvedPrincipal,
    action: string,
    resource: string,
    context?: Record<string, string>
): Promise<void> {
    if (!(await isPermissionAllowed(store, user, action, resource, context))) {
        throw new AuthzError(403, `Not authorized to perform "${action}" on "${resource}".`);
    }
}

export async function isPermissionAllowed(
    store: IamStore,
    user: ResolvedPrincipal,
    action: string,
    resource: string,
    context?: Record<string, string>
): Promise<boolean> {
    const elapsed = startTimer();
    let allowed = false;
    try {
        const resolved = await resolveEffectivePoliciesWithBoundary(store, user);
        if ("deniedByMissingBoundary" in resolved) {
            return (allowed = false);
        }

        const mergedContext: Record<string, string> = {
            ...context,
            "user:id": user.id,
            "user:organizationId": user.organizationId,
            "principal:type": user.principalType,
        };
        const result = evaluateWithBoundary(resolved.policies, resolved.boundary, { action, resource, context: mergedContext });
        return (allowed = result.effect === "Allow");
    } finally {
        // See metrics.ts's doc comment on why "effect" (allow/deny) is the
        // only label here — never `action`/`resource`, both of which are
        // effectively unbounded (a resource string embeds a case/session
        // id) and would make this histogram an unbounded-cardinality,
        // tenant-identifying metric instead of an aggregate latency signal.
        authzDecisionDuration.observe({ effect: allowed ? "allow" : "deny" }, elapsed());
    }
}
