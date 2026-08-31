import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { imagingBackgroundQueue } from "../imaging/background-queue.js";
import { deidentifyStudy } from "../imaging/deidentification.js";
import type { RouteDeps } from "./deps.js";
import { organizationDeidentificationArtifactParamsSchema, organizationDeidentificationJobParamsSchema, organizationStudyParamsSchema } from "./params.js";
import { requireOrgUser, requirePermission } from "./guards.js";

const requestSchema = z.object({
    profile: z.enum(["basic", "clean-pixel-data", "retain-longitudinal-full-dates", "retain-safe-private"]),
    purpose: z.enum(["research", "teaching", "external-export"]),
}).strict();
const reviewSchema = z.object({ decision: z.enum(["approved", "rejected"]) }).strict();

const resourceName = (organizationId: string, studyId: string) => `organization:${organizationId}/imagingStudy:${studyId}`;

export function registerImagingDeidentificationRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations/:organizationId/imaging/studies/:studyId/deidentification", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "imagingDeidentification:request", resourceName(organizationId, studyId));
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        if (!(await repo.getStudy(studyId))) return reply.code(404).send({ error: "not_found" });
        const body = requestSchema.parse(request.body);
        const job = await repo.createDeidentificationJob({
            sourceStudyId: studyId,
            profile: body.profile,
            purpose: body.purpose,
            burnedInTextSuspected: false,
            recognizableFeaturesFlagged: false,
            reviewStatus: "pending-review",
            requestedByUserId: caller.id,
        });
        imagingBackgroundQueue.enqueue(async () => {
            const result = await deidentifyStudy({ repo, objectStore: deps.imagingObjectStore, organizationId }, job);
            await repo.updateDeidentificationJob(job.id, {
                burnedInTextSuspected: result.burnedInTextSuspected,
                recognizableFeaturesFlagged: result.recognizableFeaturesFlagged,
                resultArtifactId: result.artifactIds[0],
                reviewStatus: result.reviewRequired ? "pending-review" : "auto-approved",
            });
        });
        reply.code(202).send(job);
    });

    fastify.get("/organizations/:organizationId/imaging/deidentification/:jobId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, jobId } = organizationDeidentificationJobParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const job = await repo.getDeidentificationJob(jobId);
        if (!job) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "imagingDeidentification:request", resourceName(organizationId, job.sourceStudyId));
        const candidates = await repo.listDerivedArtifactsForSource("deidentified-instance", undefined, job.sourceStudyId);
        const artifacts = candidates
            .filter((artifact) => artifact.objectStorageKey.includes(`/derived/deidentified/${job.id}/`))
            .map(({ objectStorageKey: _internal, ...artifact }) => artifact);
        reply.send({ job, artifacts });
    });

    fastify.get("/organizations/:organizationId/imaging/deidentification/:jobId/artifacts/:artifactId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, jobId, artifactId } = organizationDeidentificationArtifactParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const job = await repo.getDeidentificationJob(jobId);
        if (!job) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "imagingDeidentification:review", resourceName(organizationId, job.sourceStudyId));
        const artifact = await repo.getDerivedArtifact(artifactId);
        if (!artifact || artifact.sourceStudyId !== job.sourceStudyId || !artifact.objectStorageKey.includes(`/derived/deidentified/${job.id}/`)) {
            return reply.code(404).send({ error: "not_found" });
        }
        const bytes = await deps.imagingObjectStore.get(artifact.objectStorageKey);
        reply.header("Content-Type", "application/dicom").header("Cache-Control", "no-store").send(bytes);
    });

    fastify.post("/organizations/:organizationId/imaging/deidentification/:jobId/review", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, jobId } = organizationDeidentificationJobParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const job = await repo.getDeidentificationJob(jobId);
        if (!job) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "imagingDeidentification:review", resourceName(organizationId, job.sourceStudyId));
        if (job.requestedByUserId === caller.id) return reply.code(409).send({ error: "separation_of_duties", message: "The requester cannot review their own de-identification job." });
        if (!job.resultArtifactId) return reply.code(409).send({ error: "not_ready", message: "De-identification artifacts are not ready for review." });
        const body = reviewSchema.parse(request.body);
        reply.send(await repo.updateDeidentificationJob(job.id, { reviewStatus: body.decision, reviewedByUserId: caller.id, reviewedAt: new Date().toISOString() }));
    });
}
