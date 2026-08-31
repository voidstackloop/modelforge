import type { Group, Organization, Policy, PolicyDocument, User } from "../domain/types.js";
import type { AuditActor } from "./audit-store.js";
import type { TenantContext, TenantIamRepository } from "../tenant-context.js";

/**
 * Thrown by createUser/updateUser/createGroup/updateGroup when a caller-
 * supplied groupId/policyId resolves to a real group/policy that belongs to
 * a *different* organization than the one being written to. A dangling
 * reference (an id that doesn't resolve to anything at all) is still
 * tolerated, unchanged — resolveEffectivePolicies() has always silently
 * skipped those, and that's a distinct, harmless case (e.g. the entity was
 * deleted after being attached). This error is specifically for the case
 * that must never be allowed: attaching another tenant's policy/group,
 * which would let it show up in resolveEffectivePolicies() and be
 * evaluated as if it were the caller's own organization's grant. Carries a
 * `statusCode` so app.ts's generic error handler renders it as a 400
 * without needing its own special case there.
 */
export class InvalidReferenceError extends Error {
    readonly statusCode = 400;
    constructor(message: string) {
        super(message);
        this.name = "InvalidReferenceError";
    }
}

// Swappable persistence seam for the whole IAM domain — deliberately the
// same shape as this monorepo's other backend-configuration-boundary
// interfaces (app/src/patient-cases-store.ts's PatientCasesBackend,
// app/src/medical-safety.ts's MedicationSafetyProvider): business logic
// (routes/*.ts) depends on this interface only, never on a concrete storage
// implementation, so a Postgres-backed store (schema-per-tenant, per
// docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §2) can be dropped in later
// without touching route handlers.
//
// Every method is async — this interface has to accommodate real network
// I/O (postgres-iam-store.ts), so in-memory-iam-store.ts's methods are
// `async` too even though nothing in them actually awaits anything; that
// keeps both implementations interchangeable behind the exact same call
// shape rather than making callers special-case "the local one is
// synchronous."
// Every mutation below takes an AuditActor as its last parameter —
// docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md's P0 item 11 ("immutable audit
// actor schema and transactional outbox"), added deliberately as a
// required interface parameter rather than optional or injected via
// context: a store method that *can* silently skip auditing eventually
// will, and this is a service whose whole job is proving who did what to
// IAM/clinical data. Every route handler already resolves the caller's own
// User (requireOrgUser) before calling any of these, so building the actor
// costs it nothing. Read methods are unchanged — only state-changing calls
// are audited, matching item 11's own "transactional outbox" framing (a
// record of *changes*, not a log of every read).
export interface IamStore {
    /** PostgreSQL implements this to bind one checked-out connection and
     * SET LOCAL tenant state before any RLS-protected query. */
    bindTenant?(context: TenantContext): TenantIamRepository;
    createOrganization(name: string, actor: AuditActor): Promise<Organization>;
    getOrganization(id: string): Promise<Organization | null>;
    /**
     * Compensating cleanup for a bootstrap (POST /organizations) that fails
     * partway through — see that route's own doc comment for why an
     * organization left half-formed (no admin user, or no membership) is
     * permanently unusable rather than just incomplete: bootstrap is the
     * *only* way to become an admin of a new organization, so a partial
     * failure with nothing cleaned up would orphan the row forever. Cascades
     * (ON DELETE CASCADE, migrations 001/007) remove any users/groups/
     * policies/memberships/invitations/service-principals that did get
     * created. Deliberately does NOT attempt to drop the organization's
     * tenant clinical schema (see tenant-context.ts) — DDL cleanup on a
     * failure path is higher-risk than the orphaned-schema cost it would
     * avoid (an empty, unreferenced schema is harmless); that's a separate,
     * lower-urgency maintenance concern, not part of this compensating path.
     * A caller should treat this as best-effort (catch and log, don't let a
     * cleanup failure mask the original error).
     */
    deleteOrganization(id: string): Promise<void>;

    createUser(
        input: {
            organizationId: string;
            externalSubject: string;
            displayName: string;
            email?: string;
            groupIds?: string[];
            policyIds?: string[];
            permissionBoundaryPolicyId?: string;
        },
        actor: AuditActor
    ): Promise<User>;
    getUser(id: string): Promise<User | null>;
    findUserByExternalSubject(organizationId: string, externalSubject: string): Promise<User | null>;
    /** Every User record (across every organization) matching this OIDC
     * subject — a person can hold a distinct User record, with distinct
     * permissions, in more than one organization. Used by GET /me so a
     * client can discover which organizations it has any standing in at
     * all before picking one to act within. */
    listUsersByExternalSubject(externalSubject: string): Promise<User[]>;
    listUsersByOrganization(organizationId: string): Promise<User[]>;
    updateUser(
        id: string,
        partial: Partial<Pick<User, "displayName" | "email" | "status" | "groupIds" | "policyIds" | "permissionBoundaryPolicyId">>,
        actor: AuditActor
    ): Promise<User | null>;

    createGroup(input: { organizationId: string; name: string; policyIds?: string[] }, actor: AuditActor): Promise<Group>;
    getGroup(id: string): Promise<Group | null>;
    listGroupsByOrganization(organizationId: string): Promise<Group[]>;
    updateGroup(id: string, partial: Partial<Pick<Group, "name" | "policyIds">>, actor: AuditActor): Promise<Group | null>;

    createPolicy(
        input: {
            organizationId: string;
            name: string;
            description?: string;
            document: PolicyDocument;
            builtin?: boolean;
        },
        actor: AuditActor
    ): Promise<Policy>;
    getPolicy(id: string): Promise<Policy | null>;
    listPoliciesByOrganization(organizationId: string): Promise<Policy[]>;
    updatePolicy(id: string, partial: Partial<Pick<Policy, "name" | "description" | "document">>, actor: AuditActor): Promise<Policy | null>;
    /** Returns false without deleting anything if the policy is builtin
     * (see domain/types.ts's Policy.builtin), is the organization's current
     * break-glass emergency policy (see setBreakGlassPolicy below —
     * deleting it out from under itself would silently break break-glass
     * with no clear error), or doesn't exist — a caller distinguishes
     * "already gone" from "refused" by checking getPolicy() first,
     * matching this codebase's general preference for explicit failure
     * over a silently-absorbed no-op. Not audited when it returns false
     * (nothing happened). */
    deletePolicy(id: string, actor: AuditActor): Promise<boolean>;

    /** Sets this organization's single "emergency access" policy — the one
     * Policy routes/guards.ts's requireOrgUser can temporarily attach to a
     * user's effective policy set while they hold an active BreakGlassGrant
     * (domain/types.ts). Pass null to unset. Implementations must clear the
     * flag from whichever *other* policy in this organization currently
     * holds it first, then set it on the target, in one transaction —
     * backstopped by a partial unique index (migrations/011) so "at most
     * one per org" holds even under a racing concurrent call. Throws
     * InvalidReferenceError if policyId doesn't resolve to a policy in this
     * organization. */
    setBreakGlassPolicy(organizationId: string, policyId: string | null, actor: AuditActor): Promise<Policy | null>;
    getBreakGlassPolicy(organizationId: string): Promise<Policy | null>;

    /** Every policy currently in effect for this user: its own directly-
     * attached policies, plus every policy attached to every group it
     * belongs to, de-duplicated by policy id. This is what gets passed to
     * policy-evaluator.ts's evaluatePolicies() — that function has no
     * concept of users/groups at all, by design (see its own doc comment),
     * so this resolution step has to happen here. */
    resolveEffectivePolicies(userId: string): Promise<Policy[]>;

    /**
     * A monotonic counter, bumped by updateGroup/updatePolicy/deletePolicy
     * (each store's doc comment on those methods has the exact call site),
     * that CachingIamStore folds into its effectivePolicies cache key —
     * see that class's doc comment for why a plain cache `.clear()` on
     * those same three mutations isn't enough on its own: restoring Redis
     * from a backup taken *before* a permission-revoking mutation would
     * silently undo the clear() along with everything else, resurrecting
     * the stale decision under its original key. Embedding this counter in
     * the key means a rolled-back Redis simply has no entry for the
     * *current* key, a plain miss rather than a stale hit.
     *
     * Starts at 1 for an organization that has never had a group/policy
     * mutation. Never decreases, never reused across a delete-then-recreate
     * of anything (it's per-organization, not per-entity).
     */
    getAuthorizationEpoch(organizationId: string): Promise<number>;
}
