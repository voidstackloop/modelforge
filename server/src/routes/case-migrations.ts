import { migrationBatchRequestSchema, startMigrationRequestSchema } from "@modelforge/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

const migrationParamsSchema = z.object({ organizationId: z.string().uuid(), migrationId: z.string().uuid() });

export function registerCaseMigrationRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    const resolve = async (request: FastifyRequest, organizationId: string) => {
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "patientCase:migrate", `organization:${organizationId}/patientCase:*`);
        const cases = deps.caseStore.forTenant(caller.tenantContext);
        return { caller, migration: deps.caseMigrationStore.forTenant(caller.tenantContext, cases) };
    };

    fastify.post("/organizations/:organizationId/case-migrations", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const { caller, migration } = await resolve(request, organizationId);
        const session = await migration.start(startMigrationRequestSchema.parse(request.body), actorFrom(caller));
        reply.code(201).send(session);
    });
    fastify.get("/organizations/:organizationId/case-migrations/:migrationId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, migrationId } = migrationParamsSchema.parse(request.params);
        const { migration } = await resolve(request, organizationId); const session = await migration.get(migrationId);
        if (!session) return reply.code(404).send({ error: "not_found" }); reply.send(session);
    });
    fastify.put("/organizations/:organizationId/case-migrations/:migrationId/batches", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, migrationId } = migrationParamsSchema.parse(request.params);
        const { caller, migration } = await resolve(request, organizationId);
        reply.send(await migration.upload(migrationId, migrationBatchRequestSchema.parse(request.body).items, actorFrom(caller)));
    });
    fastify.post("/organizations/:organizationId/case-migrations/:migrationId/validate", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, migrationId } = migrationParamsSchema.parse(request.params); const { caller, migration } = await resolve(request, organizationId);
        reply.send(await migration.validate(migrationId, actorFrom(caller)));
    });
    fastify.post("/organizations/:organizationId/case-migrations/:migrationId/activate", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, migrationId } = migrationParamsSchema.parse(request.params); const { caller, migration } = await resolve(request, organizationId);
        reply.send(await migration.activate(migrationId, actorFrom(caller)));
    });
    fastify.post("/organizations/:organizationId/case-migrations/:migrationId/rollback", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, migrationId } = migrationParamsSchema.parse(request.params); const { caller, migration } = await resolve(request, organizationId);
        reply.send(await migration.rollback(migrationId, actorFrom(caller)));
    });
}
