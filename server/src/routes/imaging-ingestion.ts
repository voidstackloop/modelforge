import { randomUUID } from "node:crypto";
import type { ImagingIngestionJob } from "@modelforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import { ingestOneInstance, generateAndStoreThumbnail, resolveAmbiguousIngestionJob, JobNotResolvableError, MAX_UPLOAD_SIZE_BYTES } from "../imaging/ingestion.js";
import { imagingBackgroundQueue } from "../imaging/background-queue.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema, organizationIngestionJobParamsSchema } from "./params.js";

/**
 * HTTP entry point for item 5's ingestion pipeline (imaging/ingestion.ts
 * already implements the pipeline itself and is unit-tested there; this
 * file only handles the transport concerns: auth, body framing, and
 * scheduling the async thumbnail step).
 *
 * Deliberately scoped to one DICOM instance per request, raw binary body —
 * not full multipart STOW-RS. See dicomweb-adapter.ts's own doc comment
 * for why: a real STOW-RS multipart/related parser is a meaningful chunk of
 * work in its own right (MIME multipart boundary parsing over
 * potentially-huge bodies) that adds no security-relevant behavior over
 * "authenticate, validate, ingest one file, repeat" — a caller with many
 * files (the upload UI, item 16, or a PACS forwarder) sends one request per
 * instance. ProxyDicomwebAdapter (talking to a real external PACS) builds
 * its own multipart envelope for the outbound STOW-RS call regardless.
 *
 * There is no per-study resource to check `imagingStudy:view` against yet
 * at upload time (the study may not exist, or may turn out to belong to a
 * different case than the caller expected) — authorization here is the
 * org-wide `imagingStudy:ingest` action, mirroring routes/scim-tokens.ts's
 * `organization:${organizationId}` resource-name pattern for actions that
 * are not scoped to one already-existing resource.
 */
const ingestionQuerySchema = z
    .object({
        fileName: z.string().min(1).max(1_000).optional(),
        expectedCaseId: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        departmentId: z.string().min(1).optional(),
    })
    .strict();

const resolveJobBodySchema = z
    .object({
        decision: z.enum(["attach", "reject"]),
        caseId: z.string().min(1).optional(),
    })
    .strict()
    .refine((v) => v.decision !== "attach" || v.caseId !== undefined, { message: "caseId is required when decision is \"attach\"", path: ["caseId"] });

export function registerImagingIngestionRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post(
        "/organizations/:organizationId/imaging/ingestion",
        {
            preHandler: deps.authPreHandler,
            // Overrides buildApp's global 1 MiB default (app.ts) — DICOM
            // instances routinely exceed it. Capped at MAX_UPLOAD_SIZE_BYTES
            // + a small envelope allowance, not left unbounded: Fastify
            // rejects anything over this with 413 before it is ever fully
            // buffered, which is the actual resource-exhaustion protection
            // (ingestOneInstance's own MAX_UPLOAD_SIZE_BYTES check is a
            // second, defense-in-depth line for the same bound).
            bodyLimit: MAX_UPLOAD_SIZE_BYTES + 65_536,
        },
        async (request, reply) => {
            const { organizationId } = organizationParamsSchema.parse(request.params);
            const caller = await requireOrgUser(deps, request, organizationId);
            await requirePermission(deps.store, caller, "imagingStudy:ingest", `organization:${organizationId}`);

            if (!Buffer.isBuffer(request.body)) {
                return reply.code(415).send({ error: "unsupported_media_type", message: "Body must be application/dicom or application/octet-stream." });
            }
            const query = ingestionQuerySchema.parse(request.query);
            const fileBytes = request.body;

            const repo = deps.imagingStore.forTenant(caller.tenantContext);
            const dicomweb = deps.createDicomwebAdapter(organizationId);
            const actor = actorFrom(caller);

            const result = await ingestOneInstance(
                { repo, objectStore: deps.imagingObjectStore, dicomweb, organizationId },
                {
                    fileName: query.fileName ?? "upload.dcm",
                    fileBytes,
                    uploadId: randomUUID(),
                    ownerUserId: caller.id,
                    expectedCaseId: query.expectedCaseId,
                    workspaceId: query.workspaceId,
                    departmentId: query.departmentId,
                },
                actor
            );

            // Thumbnailing is scheduled after the response is on its way,
            // never inline — see ingestion.ts's own doc comment (item 5's
            // "generate thumbnails asynchronously") and
            // background-queue.ts (item 19's bounded-concurrency /
            // background-priority requirement as it applies server-side).
            if (result.instanceId) {
                const instanceId = result.instanceId;
                imagingBackgroundQueue.enqueue(async () => {
                    await generateAndStoreThumbnail({ repo, objectStore: deps.imagingObjectStore, organizationId }, instanceId, fileBytes);
                });
            }

            reply.code(result.requiresReview ? 202 : 201).send({ job: result.job, studyId: result.studyId, requiresReview: result.requiresReview });
        }
    );

    fastify.get("/organizations/:organizationId/imaging/ingestion", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "imagingStudy:ingest", `organization:${organizationId}`);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const { status } = request.query as { status?: ImagingIngestionJob["status"] };
        const jobs = await repo.listIngestionJobs(status ? { status } : undefined);
        reply.send(jobs);
    });

    fastify.get("/organizations/:organizationId/imaging/ingestion/:jobId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, jobId } = organizationIngestionJobParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "imagingStudy:ingest", `organization:${organizationId}`);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const job = await repo.getIngestionJob(jobId);
        if (!job) return reply.code(404).send({ error: "not_found" });
        reply.send(job);
    });

    // Manual resolution for a job ingestOneInstance held as
    // "review-required"/"ambiguous-patient-match" — see ingestion.ts's own
    // doc comment on why the bytes are quarantined rather than published at
    // that point, and resolveAmbiguousIngestionJob for what each decision
    // does. "attach" requires imagingStudy:ingest — the same action already
    // covers "including resolving ambiguous patient matches" in the action
    // catalog's own description.
    fastify.post("/organizations/:organizationId/imaging/ingestion/:jobId/resolve", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, jobId } = organizationIngestionJobParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "imagingStudy:ingest", `organization:${organizationId}`);
        const body = resolveJobBodySchema.parse(request.body);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const dicomweb = deps.createDicomwebAdapter(organizationId);
        const actor = actorFrom(caller);

        try {
            const result = await resolveAmbiguousIngestionJob(
                { repo, objectStore: deps.imagingObjectStore, dicomweb, organizationId },
                { jobId, decision: body.decision, caseId: body.caseId, resolvingUserId: caller.id },
                actor
            );
            if (result.instanceId && body.decision === "attach") {
                // Unlike the direct-upload route, the raw bytes aren't in
                // hand here — this request only carries the reviewer's
                // decision. Re-fetch the just-published original from
                // object storage instead (the instance record's own
                // objectStorageKey — repo.getInstance returns the internal,
                // key-bearing shape, never sent to the client).
                const instanceId = result.instanceId;
                imagingBackgroundQueue.enqueue(async () => {
                    const instance = await repo.getInstance(instanceId);
                    if (!instance) return;
                    const stored = await deps.imagingObjectStore.get(instance.objectStorageKey);
                    await generateAndStoreThumbnail({ repo, objectStore: deps.imagingObjectStore, organizationId }, instanceId, stored);
                });
            }
            reply.code(result.requiresReview ? 202 : 200).send({ job: result.job, studyId: result.studyId, requiresReview: result.requiresReview });
        } catch (err) {
            if (err instanceof JobNotResolvableError) {
                return reply.code(409).send({ error: "not_resolvable", message: err.message });
            }
            throw err;
        }
    });
}
