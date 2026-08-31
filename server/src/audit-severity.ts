/**
 * Institutional alert mapping (docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md P2
 * item 2, "SIEM export and institutional alert mapping"). A receiving SIEM
 * needs *some* way to prioritize which exported audit events deserve an
 * alert rule without an institution having to author its own classification
 * for every one of this server's ~50 action strings — this is that
 * classification, computed server-side so it's consistent for every
 * consumer rather than reimplemented differently per institution.
 *
 * Deliberately NOT a specific SIEM product's severity scale (no CEF numeric
 * levels, no syslog facility/severity codes) — this server has no way to
 * know which product an institution runs, matching the same "no infra
 * product choice this codebase can't make" boundary as every other P2/§19
 * item. A three-level classification is a normalized, product-agnostic
 * signal a receiving connector's own alert rules can map onto whatever
 * native severity scale that product uses.
 *
 * Built from the real action strings this codebase actually records (every
 * `action:` literal at an `insertAuditEntry`/`AuditStore.record` call site
 * across `server/src/store/*.ts`, confirmed by direct grep before writing
 * this), not designed in the abstract — the same "don't guess a vocabulary
 * that might not exist" discipline `domain/action-catalog.ts` already
 * applies to policy action strings. Deliberately does NOT attempt to cover
 * every action: a routine create/read/update on a resource that isn't
 * itself security- or safety-sensitive stays "info" by omission, which is
 * the correct default, not a gap to fill in later.
 *
 * One real, disclosed limitation: several genuinely security-relevant
 * outcomes (a membership being suspended, a user being deactivated) are
 * recorded generically as `"membership.update"`/`"user.update"` with the
 * actual change living only in `details` (e.g. `{ status: "suspended" }`),
 * not in a distinct action string — see store/postgres-principal-store.ts.
 * This classifier only ever looks at `action`, so it cannot distinguish
 * "renamed a user" from "suspended a user" today. Splitting those into
 * their own action strings would be a real (larger, cross-cutting) change
 * to every principal-store call site and its existing tests, out of scope
 * for this slice — a consumer that needs that distinction must inspect the
 * exported entry's own `details` field, which this export already includes
 * unredacted.
 */
export type AuditSeverity = "critical" | "warning" | "info";

/** Emergency access invoked, a critical imaging finding acknowledged, or a
 * legal hold released — each is either an active safety mechanism firing or
 * the removal of one, the two classes of event an institution's security
 * team should never learn about only in a weekly digest. */
const CRITICAL_ACTIONS = new Set([
    "breakGlass.invoke",
    "auditLegalHold.release",
    "diagnosticReport.acknowledgeCritical",
    "tenantBackup.approveRestore",
]);

/** Access-narrowing, access-granting, or policy-changing actions — routine
 * in volume, but exactly what a "who changed what access" alert rule wants
 * to see, unlike a plain read or an unrelated field edit. */
const WARNING_ACTIONS = new Set([
    "policy.update",
    "policy.delete",
    "policyVersion.reject",
    "invitation.revoke",
    "scimToken.revoke",
    "servicePrincipal.create",
    "accessReview.itemDecide",
    "tenantBackup.proposeRestore",
    "tenantBackup.rejectRestore",
    "aiSafetyEvent.record",
    "imagingShareGrant.create",
    "imagingShareGrant.revoke",
    "imagingViewerSession.create",
]);

export function classifyAuditSeverity(action: string): AuditSeverity {
    if (CRITICAL_ACTIONS.has(action)) return "critical";
    if (WARNING_ACTIONS.has(action)) return "warning";
    return "info";
}
