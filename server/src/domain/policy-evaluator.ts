import type { Effect, Policy, PolicyCondition, PolicyDocument } from "./types.js";

// The single place this system's actual security guarantee lives. Every
// authorization decision — every route handler, every future service that
// calls POST /authz/check — must go through this function; nothing else in
// this codebase is allowed to grant access by its own separate logic.
//
// Semantics are deliberately AWS IAM's, because they're a well-understood,
// widely-reviewed model rather than something invented here:
//   - Default deny: if nothing matches, the answer is Deny.
//   - Explicit Deny always wins: a matching Deny statement overrides any
//     number of matching Allow statements, regardless of which policy or
//     which order they appear in.
//   - A request is Allowed only if at least one statement, across every
//     policy passed in, matches its action + resource + condition (if any)
//     with effect Allow, and no statement matches with effect Deny.

export interface PolicyEvaluationResult {
    effect: Effect;
    /** Present only when a statement actually matched — absent on a bare
     * default-deny (nothing matched at all), so a caller/audit log can tell
     * "explicitly denied by policy X" apart from "no policy said anything
     * about this." */
    matchedStatement?: { policyId: string; sid?: string; effect: Effect };
}

export interface AuthorizationCheck {
    action: string;
    resource: string;
    context?: Record<string, string>;
}

// A policy pattern's only wildcard is `*`, matching any sequence of
// characters (including none, including across `:`/`/` separators) —
// deliberately simple and fixed rather than a policy author being able to
// write an arbitrary regex, which would make policy documents a code-
// injection-shaped surface instead of a data-shaped one.
//
// Matched with a greedy two-pointer scan (the standard glob/fnmatch
// technique) rather than compiling `pattern.split("*").join(".*")` into a
// regex: actions/resources are attacker-authored strings (anyone holding
// iam:managePolicies in their own organization can write one), and a
// regex built that way is the textbook catastrophic-backtracking shape —
// a pattern with many `*`-separated segments matched against a crafted
// non-matching value can take a backtracking engine exponential time.
// This function runs on every requirePermission/authz:check call, on
// Node's single thread, so a hang here stalls every tenant sharing this
// process, not just the pattern's own organization. The scan below has no
// backtracking blowup: bounded to `pattern.length * value.length` work.
export function matchesPattern(pattern: string, value: string): boolean {
    let pIdx = 0;
    let vIdx = 0;
    let starIdx = -1;
    let starMatchIdx = 0;

    while (vIdx < value.length) {
        if (pattern[pIdx] === "*") {
            starIdx = pIdx;
            starMatchIdx = vIdx;
            pIdx++;
        } else if (pattern[pIdx] === value[vIdx]) {
            pIdx++;
            vIdx++;
        } else if (starIdx !== -1) {
            pIdx = starIdx + 1;
            starMatchIdx++;
            vIdx = starMatchIdx;
        } else {
            return false;
        }
    }
    while (pattern[pIdx] === "*") pIdx++;
    return pIdx === pattern.length;
}

function matchesAny(patterns: string[], value: string): boolean {
    return patterns.some((pattern) => matchesPattern(pattern, value));
}

// A context key absent at evaluation time never satisfies StringEquals
// (there is nothing to equal) and never *violates* StringNotEquals (there is
// nothing to conflict with) — both directions are conservative in the sense
// that a missing key can't itself manufacture a Deny; it can only make a
// condition (and therefore the statement it's attached to) not apply.
function evaluateCondition(condition: PolicyCondition | undefined, context: Record<string, string>): boolean {
    if (!condition) return true;

    if (condition.StringEquals) {
        for (const [key, expected] of Object.entries(condition.StringEquals)) {
            const actual = context[key];
            const expectedValues = Array.isArray(expected) ? expected : [expected];
            if (actual === undefined || !expectedValues.includes(actual)) return false;
        }
    }

    if (condition.StringNotEquals) {
        for (const [key, expected] of Object.entries(condition.StringNotEquals)) {
            const actual = context[key];
            const expectedValues = Array.isArray(expected) ? expected : [expected];
            if (actual !== undefined && expectedValues.includes(actual)) return false;
        }
    }

    return true;
}

/**
 * Evaluates every statement in every given policy against one authorization
 * check. `policies` should be the caller's full effective set — every policy
 * attached directly to the user, plus every policy attached to every group
 * the user belongs to — already resolved by the caller (see
 * ../store/in-memory-iam-store.ts's resolveEffectivePolicies); this function
 * has no concept of users or groups, only policy documents, by design, so it
 * stays independently testable and reusable by any future service.
 */
export function evaluatePolicies(policies: Pick<Policy, "id" | "document">[], check: AuthorizationCheck): PolicyEvaluationResult {
    const context = check.context ?? {};
    let allowMatch: { policyId: string; sid?: string; effect: Effect } | undefined;

    for (const policy of policies) {
        for (const statement of policy.document.statements) {
            if (!matchesAny(statement.actions, check.action)) continue;
            if (!matchesAny(statement.resources, check.resource)) continue;
            if (!evaluateCondition(statement.condition, context)) continue;

            if (statement.effect === "Deny") {
                return { effect: "Deny", matchedStatement: { policyId: policy.id, sid: statement.sid, effect: "Deny" } };
            }
            if (!allowMatch) {
                allowMatch = { policyId: policy.id, sid: statement.sid, effect: "Allow" };
            }
        }
    }

    if (allowMatch) return { effect: "Allow", matchedStatement: allowMatch };
    return { effect: "Deny" };
}

export function isAllowed(policies: Pick<Policy, "id" | "document">[], check: AuthorizationCheck): boolean {
    return evaluatePolicies(policies, check).effect === "Allow";
}

/**
 * A permission boundary caps what an identity's own policies can ever
 * grant, regardless of how permissive they are — the same AWS IAM concept
 * this module's semantics are already modeled on (see file doc comment).
 * The effective decision is Allow only if BOTH the identity's regular
 * policies AND the boundary allow it; either side denying (explicitly, or
 * by default when nothing in it matches) denies the whole request.
 *
 * `boundary` being `undefined` means "no boundary configured" — behaves
 * exactly like a plain `evaluatePolicies(policies, check)` call, so every
 * existing caller/user without a boundary is completely unaffected. It
 * does NOT mean "boundary policy was deleted" — resolving that distinction
 * (a *configured* boundary that no longer exists must fail closed, not
 * silently become unrestricted) is the caller's job before this function
 * is ever reached; see routes/guards.ts's requirePermission for where that
 * happens. This function only ever sees "no boundary" or "here is the
 * boundary policy to enforce," never "the boundary is missing."
 *
 * On a Deny from the boundary side, the returned `matchedStatement` (if
 * any) is the boundary's own — audit/debugging value in knowing *which*
 * side of the intersection actually decided a Deny, without this function
 * needing a richer result shape than PolicyEvaluationResult already has.
 */
export function evaluateWithBoundary(
    policies: Pick<Policy, "id" | "document">[],
    boundary: Pick<Policy, "id" | "document"> | undefined,
    check: AuthorizationCheck
): PolicyEvaluationResult {
    const identityResult = evaluatePolicies(policies, check);
    if (!boundary || identityResult.effect === "Deny") return identityResult;

    const boundaryResult = evaluatePolicies([boundary], check);
    if (boundaryResult.effect === "Deny") return boundaryResult;
    return identityResult;
}

// Exported for builtin-policies.ts and tests that need to build a
// PolicyDocument's shape without re-deriving the version literal by hand.
export const POLICY_DOCUMENT_VERSION: PolicyDocument["version"] = "2026-01-01";
