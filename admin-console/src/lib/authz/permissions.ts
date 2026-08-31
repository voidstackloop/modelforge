import { ApiError, checkAuthz } from "../api/client";

export const FIXED_ACTIONS = [
    "iam:listUsers",
    "iam:manageUsers",
    "iam:listGroups",
    "iam:manageGroups",
    "iam:listPolicies",
    "iam:managePolicies",
    "audit:read",
    "breakGlass:invoke",
    "breakGlass:list",
    "breakGlass:review",
    "accessReview:manage",
    "accessReview:list",
    "accessReview:decide",
    "policy:propose",
    "policy:approve",
    "audit:manageLegalHold",
    "tenantBackup:export",
    "tenantBackup:proposeRestore",
    "tenantBackup:approveRestore",
    "aiGateway:viewAuditTrail",
    "aiGateway:manageProviders",
    "mcpRegistry:list",
    "mcpRegistry:manage",
    "compute:list",
    "compute:manageNodes",
    "compute:managePools",
    "compute:managePolicies",
    "compute:manageCritical",
    "compute:submit",
] as const;

export type FixedAction = (typeof FIXED_ACTIONS)[number];
export type PermissionMap = Record<FixedAction, boolean>;

const cache = new Map<string, PermissionMap>();

/**
 * Drives which nav links/buttons render — explicitly UX only, never a
 * trust boundary. The server enforces every one of these independently
 * and returns a deliberately generic 403 with no reason (see
 * server/src/routes/guards.ts's doc comment: specifically so a client
 * can't use denial responses to enumerate policy internals), so this
 * module fails closed (a rejected/erroring check counts as Deny) rather
 * than ever assuming access.
 */
export async function loadPermissions(organizationId: string, force = false): Promise<PermissionMap> {
    if (!force) {
        const cached = cache.get(organizationId);
        if (cached) return cached;
    }
    const resource = `organization:${organizationId}`;
    const results = await Promise.all(
        FIXED_ACTIONS.map((action) =>
            checkAuthz(organizationId, action, resource)
                .then((r) => r.effect === "Allow")
                .catch(() => false)
        )
    );
    const map = Object.fromEntries(FIXED_ACTIONS.map((action, i) => [action, results[i]])) as PermissionMap;
    cache.set(organizationId, map);
    return map;
}

export function clearPermissionsCache(organizationId?: string): void {
    if (organizationId) cache.delete(organizationId);
    else cache.clear();
}

/**
 * Shared mutation-error handler for every screen: a 403 despite a cached
 * Allow means the cache was stale (the caller's policies changed since
 * load) — re-sync it so nav/buttons reflect reality on the next render,
 * then surface the server's own message. Never throws further; the caller
 * decides how to display `message` (InlineNotice for a page-level load
 * failure, a toast for a transient action failure).
 */
export function describeApiError(err: unknown, organizationId: string): string {
    if (err instanceof ApiError) {
        if (err.status === 403) clearPermissionsCache(organizationId);
        return err.body?.message ?? err.message;
    }
    return err instanceof Error ? err.message : "Something went wrong.";
}
