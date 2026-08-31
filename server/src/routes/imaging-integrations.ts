import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./deps.js";
import { organizationParamsSchema } from "./params.js";
import { requireOrgUser, requirePermission } from "./guards.js";

/** Operator-triggered, live adapter verification. S3/local storage performs
 * a PHI-free write/read/delete round trip. PACS intentionally performs only
 * QIDO-RS: STOW would mutate an external clinical system and WADO needs a
 * known safe instance scope, so both remain explicitly `not-run`. */
export function registerImagingIntegrationRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations/:organizationId/imaging/integrations/verify", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "imagingStudy:ingest", `organization:${organizationId}`);

        const [storage, pacs, cdnSigning] = await Promise.all([
            deps.imagingObjectStore.verifyReadWrite(),
            deps.createDicomwebAdapter(organizationId).verifyConnectivity(),
            deps.imagingContentDelivery.healthCheck(),
        ]);
        const verified = storage.write && storage.read && storage.delete && pacs.qido && cdnSigning;
        reply.code(verified ? 200 : 503).send({
            verified,
            checkedAt: new Date().toISOString(),
            storage: { mode: deps.imagingStorageMode, ...storage },
            pacs: { mode: deps.dicomwebMode, ...pacs },
            // "signing" only proves this server can mint a valid signature;
            // that CloudFront accepts it needs a real distribution and is
            // documented as an unverified path in docs/IMAGING.md.
            contentDelivery: { mode: deps.imagingContentDelivery.mode, signing: cdnSigning, edgeDelivery: "not-run" },
        });
    });
}
