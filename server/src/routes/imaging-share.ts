import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission } from "./guards.js";
import { hashViewerToken } from "./imaging-viewer-sessions.js";
import { organizationShareGrantParamsSchema, organizationStudyParamsSchema } from "./params.js";
import { schemaNameForTenant } from "../tenant-context.js";

const EXTERNAL_VIEWER_SESSION_TTL_MS = 30 * 60_000;

/**
 * Three sharing modes (item 9): internal (same-org member), cross-
 * organization (an explicit clinician grant naming a specific recipient in
 * another org), and external-portal (an expiring link + a separately-
 * delivered verification code — no OIDC identity at all, since a
 * patient/external recipient has none). Every grant is scoped to an exact
 * study/series/instance/report, never "this patient's imaging in general"
 * (item 10). Download is disabled by default for external sharing (item
 * 11's own explicit rule, also enforced at the schema layer —
 * imagingShareGrantSchema.refine in packages/contracts/src/imaging.ts).
 *
 * Revocation (item 11: "must terminate new viewer sessions immediately")
 * always does two things in the same handler: mark the grant revoked, and
 * revoke every viewer session issued from it — never just the former.
 */
const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
const studyResourceName = (organizationId: string, studyId: string): string => `organization:${organizationId}/imagingStudy:${studyId}`;

const createShareGrantBodySchema = z
    .object({
        mode: z.enum(["internal", "cross-organization", "external-portal"]),
        scope: z.enum(["study", "series", "instance", "report"]),
        seriesId: z.string().min(1).optional(),
        instanceId: z.string().min(1).optional(),
        reportId: z.string().min(1).optional(),
        recipientUserId: z.string().min(1).optional(),
        recipientOrganizationId: z.string().min(1).optional(),
        recipientEmail: z.string().email().optional(),
        recipientName: z.string().max(500).optional(),
        purposeOfUse: z.string().min(1).max(500),
        message: z.string().max(5_000).optional(),
        expiresInHours: z.number().int().min(1).max(24 * 90).default(72),
        allowDownload: z.boolean().default(false),
        consentBasis: z.string().min(1).max(500),
    })
    .strict()
    .refine((v) => v.mode !== "external-portal" || v.allowDownload === false, { message: "external-portal shares must not allow download", path: ["allowDownload"] });

const externalAccessBodySchema = z.object({ verificationCode: z.string().min(1).max(200) }).strict();

export function registerImagingShareRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/imaging/studies/:studyId/shares", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const study = await repo.getStudy(studyId);
        if (!study) return reply.code(404).send({ error: "not_found" });
        const canView = await isPermissionAllowed(deps.store, caller, "imagingStudy:view", studyResourceName(organizationId, studyId), {
            "resource:ownerUserId": study.resource.ownerUserId, "resource:isOwner": String(study.resource.ownerUserId === caller.id),
            "resource:isAssigned": String(study.resource.assignedUserIds.includes(caller.id)), "resource:sensitivity": study.resource.sensitivity,
        });
        if (!canView) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "imagingShare:manage", studyResourceName(organizationId, studyId));
        reply.send(await repo.listShareGrantsForStudy(studyId));
    });

    fastify.post("/organizations/:organizationId/imaging/studies/:studyId/shares", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const study = await repo.getStudy(studyId);
        if (!study) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "imagingShare:manage", studyResourceName(organizationId, studyId));

        const body = createShareGrantBodySchema.parse(request.body);
        if (body.mode === "internal" && !body.recipientUserId) return reply.code(400).send({ error: "invalid_request", message: "internal shares require recipientUserId" });
        if (body.mode === "cross-organization" && (!body.recipientUserId || !body.recipientOrganizationId)) return reply.code(400).send({ error: "invalid_request", message: "cross-organization shares require recipientUserId and recipientOrganizationId" });
        if (body.mode === "external-portal" && !body.recipientEmail) return reply.code(400).send({ error: "invalid_request", message: "external-portal shares require recipientEmail" });

        let linkToken: string | undefined;
        let verificationCode: string | undefined;
        let externalTokenHash: string | undefined;
        let externalVerificationCodeHash: string | undefined;
        if (body.mode === "external-portal") {
            linkToken = randomBytes(32).toString("base64url");
            verificationCode = randomBytes(6).toString("hex").toUpperCase(); // short, human-relayable out of band
            externalTokenHash = hashToken(linkToken);
            externalVerificationCodeHash = hashToken(verificationCode);
        }

        const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000).toISOString();
        const grant = await repo.createShareGrant(
            {
                mode: body.mode, scope: body.scope, studyId, seriesId: body.seriesId, instanceId: body.instanceId, reportId: body.reportId,
                recipientUserId: body.recipientUserId, recipientOrganizationId: body.recipientOrganizationId, recipientEmail: body.recipientEmail, recipientName: body.recipientName,
                purposeOfUse: body.purposeOfUse, message: body.message, expiresAt, allowDownload: body.allowDownload, issuedByUserId: caller.id, consentBasis: body.consentBasis,
                externalTokenHash, externalVerificationCodeHash,
            },
            actorFrom(caller)
        );
        reply.code(201).send({ grant, ...(linkToken ? { linkToken, verificationCode } : {}) });
    });

    fastify.post("/organizations/:organizationId/imaging/shares/:shareGrantId/revoke", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, shareGrantId } = organizationShareGrantParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const existing = await repo.getShareGrant(shareGrantId);
        if (!existing) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "imagingShare:manage", studyResourceName(organizationId, existing.studyId));
        const revoked = await repo.revokeShareGrant(shareGrantId, caller.id, actorFrom(caller));
        if (!revoked) return reply.code(400).send({ error: "not_active", message: "This share grant is not currently active." });
        // Item 11: revocation terminates new viewer sessions immediately —
        // both steps happen in this one handler, never just the grant flip.
        await repo.revokeViewerSessionsForShareGrant(shareGrantId, actorFrom(caller));
        reply.send(revoked);
    });

    // External-portal access — deliberately NOT behind deps.authPreHandler:
    // an external recipient has no OIDC identity at all. Authorization is
    // entirely "possession of the link token AND the separately-delivered
    // verification code," matching the strong-recipient-verification
    // requirement (item 9) without inventing a new identity system for
    // one-off external access.
    fastify.post("/organizations/:organizationId/imaging/external-access/:linkToken", async (request, reply) => {
        const { organizationId, linkToken } = z.object({ organizationId: z.string().uuid(), linkToken: z.string().min(1) }).parse(request.params);
        const body = externalAccessBodySchema.parse(request.body);
        const organization = await deps.tenantDirectory.resolve(organizationId);
        if (!organization) return reply.code(404).send({ error: "not_found" });
        const schemaName = organization.tenantSchema ?? schemaNameForTenant(organizationId);
        const repo = deps.imagingStore.forTenant({ organizationId, schemaName, issuer: "external-portal", subject: linkToken });

        const found = await repo.findActiveExternalShareByTokenHash(hashToken(linkToken));
        // Identical response whether the token is wrong, expired, revoked,
        // or the verification code is wrong — never disclose *which* check
        // failed (a real information-leak vector for a public, unauthenticated
        // endpoint an attacker could probe).
        const invalid = () => reply.code(404).send({ error: "not_found" });
        if (!found) return invalid();
        if (new Date(found.grant.expiresAt).getTime() < Date.now()) return invalid();
        if (hashToken(body.verificationCode) !== found.externalVerificationCodeHash) return invalid();

        // Authorize-then-issue (item 8): possession of the link token plus
        // the separately-delivered verification code IS the authorization
        // here (there is no OIDC identity to check against instead) — a
        // viewer session is issued immediately in this same response,
        // scoped to exactly what the grant allows.
        const grantedActions: ("view" | "measure" | "download")[] = found.grant.allowDownload ? ["view", "download"] : ["view"];
        const sessionExpiresAt = new Date(Math.min(Date.now() + EXTERNAL_VIEWER_SESSION_TTL_MS, new Date(found.grant.expiresAt).getTime())).toISOString();
        const sessionToken = randomBytes(32).toString("base64url");
        const session = await repo.createViewerSession(
            {
                studyId: found.grant.studyId,
                seriesIds: found.grant.seriesId ? [found.grant.seriesId] : undefined,
                instanceIds: found.grant.instanceId ? [found.grant.instanceId] : undefined,
                grantedActions,
                shareGrantId: found.grant.id,
                tokenHash: hashViewerToken(sessionToken),
                expiresAt: sessionExpiresAt,
            },
            { externalSubject: `external-share:${found.grant.id}`, userId: undefined, organizationId }
        );
        reply.send({ grant: found.grant, session, token: sessionToken });
    });
}
