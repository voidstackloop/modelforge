import type { FastifyReply, FastifyRequest, FastifyInstance } from "fastify";
import type { ImagingStudy } from "@modelforge/contracts";
import { z } from "zod";
import { hashViewerToken } from "./imaging-viewer-sessions.js";
import type { RouteDeps } from "./deps.js";
import { schemaNameForTenant } from "../tenant-context.js";

/**
 * DICOMweb retrieval (WADO-RS-shaped) and search (QIDO-RS-shaped),
 * authenticated by a viewer-session bearer token — never OIDC directly,
 * and never a query-string token (item 8: "never expose... PHI in query
 * strings and logs" — a query string is exactly what ends up in access
 * logs and browser history; the token is a header only).
 *
 * Scoped simplification, disclosed: real WADO-RS returns
 * multipart/related; this returns a single-part `application/dicom`
 * response body instead. Every DICOMweb-conformant client this codebase
 * actually needs to interoperate with (the embedded OHIF viewer
 * integration) is configured against this server's own endpoint shape, not
 * a third party's, so the simplification does not break interoperability
 * for the one consumer that matters here — see docs/IMAGING.md.
 */
const viewerParamsSchema = z.object({ organizationId: z.string().uuid(), instanceId: z.string().min(1) });
const dicomwebStudyParamsSchema = z.object({ organizationId: z.string().uuid(), studyInstanceUid: z.string().min(1) });
const dicomwebSeriesParamsSchema = dicomwebStudyParamsSchema.extend({ seriesInstanceUid: z.string().min(1) });
const dicomwebInstanceParamsSchema = dicomwebSeriesParamsSchema.extend({ sopInstanceUid: z.string().min(1) });

async function requireViewerSession(deps: RouteDeps, request: FastifyRequest, reply: FastifyReply, organizationId: string) {
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        reply.code(401).send({ error: "missing_bearer_token" });
        return null;
    }
    const token = header.slice("Bearer ".length).trim();
    const organization = await deps.tenantDirectory.resolve(organizationId);
    if (!organization) {
        reply.code(404).send({ error: "not_found" });
        return null;
    }
    const schemaName = organization.tenantSchema ?? schemaNameForTenant(organizationId);
    const repo = deps.imagingStore.forTenant({ organizationId, schemaName, issuer: "viewer-session", subject: token.slice(0, 8) });
    const session = await repo.findActiveViewerSessionByTokenHash(hashViewerToken(token));
    if (!session) {
        reply.code(401).send({ error: "invalid_or_expired_session" });
        return null;
    }
    return { repo, session };
}

function instanceInScope(session: { scope: { studyId: string; seriesIds?: string[]; instanceIds?: string[] } }, seriesId: string, instanceId: string): boolean {
    if (session.scope.instanceIds && session.scope.instanceIds.length > 0) return session.scope.instanceIds.includes(instanceId);
    if (session.scope.seriesIds && session.scope.seriesIds.length > 0) return session.scope.seriesIds.includes(seriesId);
    return true; // scoped to the whole study
}

const dicomValue = (vr: string, value: unknown) => ({ vr, Value: Array.isArray(value) ? value : [value] });

function studyDicomJson(study: ImagingStudy) {
    return {
        "0020000D": dicomValue("UI", study.studyInstanceUid),
        "00100020": dicomValue("LO", study.patientIdentifier.value),
        "00100021": dicomValue("LO", study.patientIdentifier.issuer),
        "00080020": dicomValue("DA", study.studyDate?.replaceAll("-", "") ?? ""),
        "00080050": dicomValue("SH", study.accessionNumber ?? ""),
        "00081030": dicomValue("LO", study.description ?? ""),
        "00080061": dicomValue("CS", study.modalities),
        "00201206": dicomValue("IS", String(study.numberOfSeries)),
        "00201208": dicomValue("IS", String(study.numberOfInstances)),
    };
}

function seriesDicomJson(studyUid: string, series: { seriesInstanceUid: string; modality: string; seriesNumber?: string; description?: string; numberOfInstances: number }) {
    return {
        "0020000D": dicomValue("UI", studyUid),
        "0020000E": dicomValue("UI", series.seriesInstanceUid),
        "00080060": dicomValue("CS", series.modality),
        "00200011": dicomValue("IS", series.seriesNumber ?? ""),
        "0008103E": dicomValue("LO", series.description ?? ""),
        "00201209": dicomValue("IS", String(series.numberOfInstances)),
    };
}

function instanceDicomJson(studyUid: string, seriesUid: string, instance: { sopInstanceUid: string; sopClassUid: string; instanceNumber?: string; rows?: number; columns?: number; numberOfFrames?: number }) {
    return {
        "0020000D": dicomValue("UI", studyUid),
        "0020000E": dicomValue("UI", seriesUid),
        "00080018": dicomValue("UI", instance.sopInstanceUid),
        "00080016": dicomValue("UI", instance.sopClassUid),
        "00200013": dicomValue("IS", instance.instanceNumber ?? ""),
        ...(instance.rows ? { "00280010": dicomValue("US", instance.rows) } : {}),
        ...(instance.columns ? { "00280011": dicomValue("US", instance.columns) } : {}),
        ...(instance.numberOfFrames ? { "00280008": dicomValue("IS", String(instance.numberOfFrames)) } : {}),
    };
}

export function registerImagingDicomwebRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    // OHIF-compatible QIDO-RS/WADO-RS surface. All results are constrained
    // to the one study in the viewer session even if query filters are
    // omitted or adversarially broadened.
    fastify.get("/organizations/:organizationId/imaging/dicomweb/studies", async (request, reply) => {
        const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
        const authed = await requireViewerSession(deps, request, reply, organizationId);
        if (!authed) return;
        const study = await authed.repo.getStudy(authed.session.scope.studyId);
        if (!study) return reply.send([]);
        const requestedUid = (request.query as { StudyInstanceUID?: string }).StudyInstanceUID;
        reply.header("Content-Type", "application/dicom+json").header("Cache-Control", "no-store");
        reply.send(!requestedUid || requestedUid === study.study.studyInstanceUid ? [studyDicomJson(study.study)] : []);
    });

    fastify.get("/organizations/:organizationId/imaging/dicomweb/studies/:studyInstanceUid/series", async (request, reply) => {
        const { organizationId, studyInstanceUid } = dicomwebStudyParamsSchema.parse(request.params);
        const authed = await requireViewerSession(deps, request, reply, organizationId);
        if (!authed) return;
        const study = await authed.repo.getStudy(authed.session.scope.studyId);
        if (!study || study.study.studyInstanceUid !== studyInstanceUid) return reply.code(404).send({ error: "not_found" });
        const all = await authed.repo.listSeriesForStudy(study.study.id);
        const scoped = authed.session.scope.seriesIds?.length ? all.filter((series) => authed.session.scope.seriesIds!.includes(series.id)) : all;
        reply.header("Content-Type", "application/dicom+json").header("Cache-Control", "no-store");
        reply.send(scoped.map((series) => seriesDicomJson(studyInstanceUid, series)));
    });

    const sendMetadata = async (request: FastifyRequest, reply: FastifyReply, params: { organizationId: string; studyInstanceUid: string; seriesInstanceUid?: string }) => {
        const authed = await requireViewerSession(deps, request, reply, params.organizationId);
        if (!authed) return;
        const study = await authed.repo.getStudy(authed.session.scope.studyId);
        if (!study || study.study.studyInstanceUid !== params.studyInstanceUid) return reply.code(404).send({ error: "not_found" });
        let series = await authed.repo.listSeriesForStudy(study.study.id);
        if (params.seriesInstanceUid) series = series.filter((item) => item.seriesInstanceUid === params.seriesInstanceUid);
        if (authed.session.scope.seriesIds?.length) series = series.filter((item) => authed.session.scope.seriesIds!.includes(item.id));
        const metadata = [];
        for (const item of series) {
            const instances = await authed.repo.listInstancesForSeries(item.id);
            for (const instance of instances) if (instanceInScope(authed.session, item.id, instance.id)) metadata.push(instanceDicomJson(params.studyInstanceUid, item.seriesInstanceUid, instance));
        }
        reply.header("Content-Type", "application/dicom+json").header("Cache-Control", "no-store");
        reply.send(metadata);
    };

    fastify.get("/organizations/:organizationId/imaging/dicomweb/studies/:studyInstanceUid/metadata", async (request, reply) => {
        return sendMetadata(request, reply, dicomwebStudyParamsSchema.parse(request.params));
    });
    fastify.get("/organizations/:organizationId/imaging/dicomweb/studies/:studyInstanceUid/series/:seriesInstanceUid/metadata", async (request, reply) => {
        return sendMetadata(request, reply, dicomwebSeriesParamsSchema.parse(request.params));
    });

    fastify.get("/organizations/:organizationId/imaging/dicomweb/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid", async (request, reply) => {
        const params = dicomwebInstanceParamsSchema.parse(request.params);
        const authed = await requireViewerSession(deps, request, reply, params.organizationId);
        if (!authed) return;
        const study = await authed.repo.getStudy(authed.session.scope.studyId);
        if (!study || study.study.studyInstanceUid !== params.studyInstanceUid) return reply.code(404).send({ error: "not_found" });
        const series = (await authed.repo.listSeriesForStudy(study.study.id)).find((item) => item.seriesInstanceUid === params.seriesInstanceUid);
        if (!series) return reply.code(404).send({ error: "not_found" });
        const instance = (await authed.repo.listInstancesForSeries(series.id)).find((item) => item.sopInstanceUid === params.sopInstanceUid);
        if (!instance || !instanceInScope(authed.session, series.id, instance.id)) return reply.code(404).send({ error: "not_found" });
        const result = await deps.createDicomwebAdapter(params.organizationId).retrieveInstance(instance.objectStorageKey);
        reply.header("Content-Type", result.contentType).header("Cache-Control", "no-store").send(result.data);
    });

    // WADO-URI compatibility used by the bundled OHIF configuration. It
    // retrieves the complete Part 10 instance, avoiding a fake/partial
    // WADO-RS frame implementation (which would require real codec-aware
    // pixel extraction and multipart framing).
    fastify.get("/organizations/:organizationId/imaging/dicomweb/wado", async (request, reply) => {
        const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
        const query = z.object({
            requestType: z.string().optional(),
            studyUID: z.string().min(1),
            seriesUID: z.string().min(1),
            objectUID: z.string().min(1),
        }).passthrough().parse(request.query);
        const authed = await requireViewerSession(deps, request, reply, organizationId);
        if (!authed) return;
        const study = await authed.repo.getStudy(authed.session.scope.studyId);
        if (!study || study.study.studyInstanceUid !== query.studyUID) return reply.code(404).send({ error: "not_found" });
        const series = (await authed.repo.listSeriesForStudy(study.study.id)).find((item) => item.seriesInstanceUid === query.seriesUID);
        if (!series) return reply.code(404).send({ error: "not_found" });
        const instance = (await authed.repo.listInstancesForSeries(series.id)).find((item) => item.sopInstanceUid === query.objectUID);
        if (!instance || !instanceInScope(authed.session, series.id, instance.id)) return reply.code(404).send({ error: "not_found" });
        const result = await deps.createDicomwebAdapter(organizationId).retrieveInstance(instance.objectStorageKey);
        reply.header("Content-Type", "application/dicom").header("Cache-Control", "no-store").send(result.data);
    });

    fastify.get("/organizations/:organizationId/imaging/wado/instances/:instanceId", async (request, reply) => {
        const { organizationId, instanceId } = viewerParamsSchema.parse(request.params);
        const authed = await requireViewerSession(deps, request, reply, organizationId);
        if (!authed) return;
        const { repo, session } = authed;

        const instance = await repo.getInstance(instanceId);
        // Identical response for "no such instance" and "exists but out of
        // this session's scope" — item 7.
        if (!instance || instance.seriesId === undefined) return reply.code(404).send({ error: "not_found" });
        const series = await repo.getSeries(instance.seriesId);
        if (!series || series.studyId !== session.scope.studyId || !instanceInScope(session, instance.seriesId, instanceId)) {
            return reply.code(404).send({ error: "not_found" });
        }
        if (!session.grantedActions.includes("view")) return reply.code(403).send({ error: "forbidden" });

        // Authorize first, sign second. Every check above has already run by
        // the time a CDN URL can be minted, and the signature is bound to
        // this one object for 60 seconds (imaging/content-delivery.ts).
        // Without CloudFront configured this returns null and the bytes
        // stream through the origin exactly as before — the default.
        const delivered = deps.imagingContentDelivery.signObjectUrl(instance.objectStorageKey);
        if (delivered) {
            reply.header("Cache-Control", "no-store");
            // 307, not 302: preserves the method and, more importantly,
            // signals "this location is temporary" to every intermediary, so
            // a proxy never treats the signed URL as a durable mapping.
            return reply.code(307).header("Location", delivered.url).send();
        }

        const adapter = deps.createDicomwebAdapter(organizationId);
        const { data, contentType } = await adapter.retrieveInstance(instance.objectStorageKey);
        reply.header("Content-Type", contentType);
        reply.header("Cache-Control", "no-store"); // never cached — this response is authorized per-session, not a stable public resource
        reply.send(data);
    });

    fastify.get("/organizations/:organizationId/imaging/wado/instances/:instanceId/thumbnail", async (request, reply) => {
        const { organizationId, instanceId } = viewerParamsSchema.parse(request.params);
        const authed = await requireViewerSession(deps, request, reply, organizationId);
        if (!authed) return;
        const { repo, session } = authed;

        const instance = await repo.getInstance(instanceId);
        if (!instance) return reply.code(404).send({ error: "not_found" });
        const series = await repo.getSeries(instance.seriesId);
        if (!series || series.studyId !== session.scope.studyId || !instanceInScope(session, instance.seriesId, instanceId)) {
            return reply.code(404).send({ error: "not_found" });
        }
        const artifacts = await repo.listDerivedArtifactsForSource("thumbnail", instanceId);
        if (artifacts.length === 0) return reply.code(404).send({ error: "not_found", message: "No thumbnail available for this instance." });

        const adapter = deps.createDicomwebAdapter(organizationId);
        const { data } = await adapter.retrieveInstance(artifacts[0].objectStorageKey);
        reply.header("Content-Type", "image/png");
        reply.header("Cache-Control", "no-store");
        reply.send(data);
    });
}
