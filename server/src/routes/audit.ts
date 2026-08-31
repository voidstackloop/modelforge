import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuditSearchFilters, StoredAuditLogEntry } from "../store/audit-store.js";
import { actorFrom } from "../store/audit-store.js";
import { classifyAuditSeverity } from "../audit-severity.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

/** Caps a single SIEM-export poll's response size — an operator's connector
 * that fell behind (or is polling for the first time against a long-lived
 * organization) shouldn't be able to request an unbounded response; it
 * simply calls again with the last `sequence` it saw to keep paging
 * forward, exactly like a normal `?since=` change-feed client. */
const SIEM_EXPORT_MAX_LIMIT = 5000;
const SIEM_EXPORT_DEFAULT_LIMIT = 500;

function parseSiemExportQuery(query: unknown): { since: string | undefined; limit: number } {
    const q = (query ?? {}) as Record<string, unknown>;
    const since = typeof q.since === "string" && /^\d+$/.test(q.since) ? q.since : undefined;
    let limit = SIEM_EXPORT_DEFAULT_LIMIT;
    if (typeof q.limit === "string" && /^\d+$/.test(q.limit)) {
        const parsed = Number(q.limit);
        if (parsed > 0) limit = Math.min(parsed, SIEM_EXPORT_MAX_LIMIT);
    }
    return { since, limit };
}

const legalHoldParamsSchema = z.object({ organizationId: z.string().uuid(), holdId: z.string().uuid() });
const placeLegalHoldBodySchema = z.object({ reason: z.string().min(1) }).strict();
const releaseLegalHoldBodySchema = z.object({ releaseReason: z.string().max(2000).optional() }).strict();

/**
 * Parses AuditSearchFilters from a query string, failing OPEN on anything
 * malformed (drop that one filter silently) rather than 400ing — same
 * convention routes/cases.ts's own `?since=` cursor already uses ("fails
 * open to returning everything, rather than erroring"). A caller who wants
 * to be sure a filter took effect can always check the response.
 */
function parseAuditFilters(query: unknown): AuditSearchFilters {
    const q = (query ?? {}) as Record<string, unknown>;
    const filters: AuditSearchFilters = {};
    if (typeof q.action === "string" && q.action) filters.action = q.action;
    if (typeof q.targetType === "string" && q.targetType) filters.targetType = q.targetType;
    if (typeof q.targetId === "string" && q.targetId) filters.targetId = q.targetId;
    if (typeof q.actorUserId === "string" && q.actorUserId) filters.actorUserId = q.actorUserId;
    if (typeof q.since === "string" && !Number.isNaN(Date.parse(q.since))) filters.since = q.since;
    if (typeof q.until === "string" && !Number.isNaN(Date.parse(q.until))) filters.until = q.until;
    if (typeof q.cursor === "string" && /^\d+$/.test(q.cursor)) filters.cursor = q.cursor;
    if (typeof q.limit === "string" && /^\d+$/.test(q.limit)) {
        const parsed = Number(q.limit);
        if (parsed > 0) filters.limit = Math.min(parsed, 1000);
    }
    return filters;
}

function csvField(value: unknown): string {
    const s = value === undefined || value === null ? "" : String(value);
    return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
    "sequence", "createdAt", "organizationId", "actorUserId", "actorExternalSubject",
    "action", "targetType", "targetId", "details", "entryHash", "prevHash",
] as const;

function toCsv(entries: StoredAuditLogEntry[]): string {
    const rows = entries.map((e) =>
        [
            e.sequence ?? "", e.createdAt, e.organizationId ?? "", e.actorUserId ?? "", e.actorExternalSubject,
            e.action, e.targetType, e.targetId, e.details ? JSON.stringify(e.details) : "", e.entryHash ?? "", e.prevHash ?? "",
        ]
            .map(csvField)
            .join(",")
    );
    return [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

/**
 * GET /organizations/:organizationId/audit (store/audit-store.ts) — the
 * read side of the immutable audit trail every IAM/case mutation writes
 * into. Gated behind its own `audit:read` action, not folded into any
 * existing `iam:list*`/`iam:manage*` permission: an institution's
 * compliance/security role typically needs to *read* the audit trail
 * without also holding any of the permissions that would let it *act* on
 * IAM or case data — the same separation-of-duties reasoning routes/
 * users.ts's own doc comment applies to policy attachment. The builtin
 * OrganizationAdmin policy's `actions: ["*"]` already covers this new
 * action automatically — no change needed there.
 *
 * P1 item 4 (immutable audit ingestion, search, export, and legal hold)
 * adds: optional search/filter/pagination params on this same route
 * (omitting them preserves the original full-unpaginated-history
 * behavior); an /export CSV variant; a /verify-chain tamper-evidence
 * check; and legal-hold place/list/release, gated on a new
 * `audit:manageLegalHold` action for place/release (listing stays under
 * `audit:read` — transparency: anyone who can read the trail can see
 * whether it's under hold).
 *
 * P2 item 2 (SIEM export and institutional alert mapping) adds
 * /audit/siem-export: a machine-consumption feed for an external SIEM
 * connector to poll, gated on its own `audit:exportSiem` action rather than
 * folded into `audit:read` — bulk/automated export to a system outside this
 * server's own trust boundary is a materially different capability than a
 * human paging through the trail in the admin console, and an organization
 * may want to grant one without the other. Deliberately a *pull* API, not a
 * push/webhook: this codebase has no existing outbound-to-arbitrary-host
 * integration anywhere (metrics, health, and every audit surface above are
 * all pull), and a pull model reuses the exact OIDC/tenant/authorization
 * machinery already built instead of inventing webhook-secret management,
 * retry/backoff, and a new egress surface for a delivery mechanism this
 * server would then own. The connector manages its own `since` cursor
 * between polls (the last `sequence` it saw) — this server tracks no
 * per-connector export state, matching routes/cases.ts's `?since=`
 * change-feed contract exactly.
 */
export function registerAuditRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/audit", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "audit:read", `organization:${organizationId}`);
        reply.send(await deps.auditStore.listByOrganization(organizationId, parseAuditFilters(request.query)));
    });

    fastify.get("/organizations/:organizationId/audit/export", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "audit:read", `organization:${organizationId}`);
        const entries = await deps.auditStore.listByOrganization(organizationId, parseAuditFilters(request.query));
        reply
            .header("Content-Type", "text/csv; charset=utf-8")
            .header("Content-Disposition", `attachment; filename="audit-${organizationId}-${Date.now()}.csv"`)
            .send(toCsv(entries));
    });

    fastify.get("/organizations/:organizationId/audit/siem-export", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "audit:exportSiem", `organization:${organizationId}`);
        const { since, limit } = parseSiemExportQuery(request.query);
        const entries = await deps.auditStore.listForExport(organizationId, since, limit);
        reply.send({
            events: entries.map((e) => ({
                id: e.id,
                sequence: e.sequence,
                severity: classifyAuditSeverity(e.action),
                organizationId: e.organizationId,
                actorUserId: e.actorUserId,
                actorExternalSubject: e.actorExternalSubject,
                action: e.action,
                targetType: e.targetType,
                targetId: e.targetId,
                details: e.details,
                createdAt: e.createdAt,
            })),
            nextSince: entries.length > 0 ? entries[entries.length - 1].sequence : since,
        });
    });

    fastify.get("/organizations/:organizationId/audit/verify-chain", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "audit:read", `organization:${organizationId}`);
        reply.send(await deps.auditStore.verifyChain(organizationId));
    });

    fastify.post("/organizations/:organizationId/audit/legal-holds", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "audit:manageLegalHold", `organization:${organizationId}`);
        const body = placeLegalHoldBodySchema.parse(request.body);
        const hold = await deps.auditLegalHoldStore.place(organizationId, body.reason, caller.id, actorFrom(caller));
        reply.code(201).send(hold);
    });

    fastify.get("/organizations/:organizationId/audit/legal-holds", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "audit:read", `organization:${organizationId}`);
        reply.send(await deps.auditLegalHoldStore.listByOrganization(organizationId));
    });

    fastify.post(
        "/organizations/:organizationId/audit/legal-holds/:holdId/release",
        { preHandler: deps.authPreHandler },
        async (request, reply) => {
            const { organizationId, holdId } = legalHoldParamsSchema.parse(request.params);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "audit:manageLegalHold", `organization:${organizationId}`);
            const body = releaseLegalHoldBodySchema.parse(request.body);

            const existing = await deps.auditLegalHoldStore.getById(organizationId, holdId);
            if (!existing) return reply.code(404).send({ error: "not_found" });
            if (existing.status !== "active") return reply.code(400).send({ error: "not_active", message: "This hold has already been released." });

            const released = await deps.auditLegalHoldStore.release(organizationId, holdId, body.releaseReason, caller.id, actorFrom(caller));
            if (!released) return reply.code(400).send({ error: "not_active", message: "This hold has already been released." });
            reply.send(released);
        }
    );
}
