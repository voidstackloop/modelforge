import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWTVerifyGetKey } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { InMemoryAuditStore } from "../store/audit-store.js";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryComputeControlStore } from "../store/compute-control-store.js";
import { InMemoryIamStore } from "../store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "../store/in-memory-idempotency-store.js";

const ISSUER = "https://idp.example.test";
const AUDIENCE = "modelforge";
const KID = "compute-test";

describe("compute control routes", () => {
    let key: CryptoKey;
    let jwks: JWTVerifyGetKey;
    let app: FastifyInstance;
    let token: string;
    let organizationId: string;

    beforeAll(async () => {
        const pair = await generateKeyPair("RS256");
        key = pair.privateKey;
        const publicJwk = await exportJWK(pair.publicKey);
        publicJwk.kid = KID; publicJwk.alg = "RS256";
        jwks = createLocalJWKSet({ keys: [publicJwk] });
    });

    beforeEach(async () => {
        const audit = new InMemoryAuditStore();
        app = buildApp({
            store: new InMemoryIamStore(audit), caseStore: new InMemoryCaseStore(audit), idempotencyStore: new InMemoryIdempotencyStore(),
            auditStore: audit, computeControlStore: new InMemoryComputeControlStore(audit), jwks,
            oidc: { issuer: ISSUER, audience: AUDIENCE }, resolveComputeAgentCertificateFingerprint: () => "fp",
        });
        token = await new SignJWT({ sub: "idp|compute-admin", name: "Compute Admin" }).setProtectedHeader({ alg: "RS256", kid: KID }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime("1h").sign(key);
        const created = await app.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${token}` }, payload: { name: "Compute Org" } });
        organizationId = created.json().organization.id;
    });

    async function enrollAndPool(): Promise<{ nodeId: string; poolId: string }> {
        const nodeId = crypto.randomUUID();
        const enrolled = await app.inject({ method: "POST", url: `/organizations/${organizationId}/compute/nodes`, headers: { authorization: `Bearer ${token}` }, payload: {
            id: nodeId, name: "gpu-node", region: "eu-tr", labels: { role: "inference" }, operatingSystem: "linux", architecture: "x64", agentVersion: "1.0.0", certificateFingerprint: "fp",
            cpuThreads: 16, freeCpuThreads: 15, totalRamMB: 32_768, freeRamMB: 30_000, numaNodes: 1, supportedRuntimes: ["llamacpp"], warmModelIds: ["model-4b"], inventoryVersion: "1",
            devices: [{ id: "gpu-stable", nodeId, vendor: "nvidia", model: "GPU", totalVramMB: 16_384, freeVramMB: 15_000, sharingMode: "exclusive", maxConcurrency: 1, health: "healthy", supportedRuntimes: ["llamacpp"], throttled: false }],
        } });
        expect(enrolled.statusCode, enrolled.body).toBe(201);
        const pool = await app.inject({ method: "POST", url: `/organizations/${organizationId}/compute/pools`, headers: { authorization: `Bearer ${token}` }, payload: { name: "interactive", region: "eu-tr", labels: {}, nodeIds: [nodeId], status: "active", schedulingPolicy: "interactive-first" } });
        expect(pool.statusCode, pool.body).toBe(201);
        return { nodeId, poolId: pool.json().id };
    }

    it("enrolls, schedules, exposes, and acknowledges a fenced assignment", async () => {
        const { nodeId, poolId } = await enrollAndPool();
        const submitted = await app.inject({ method: "POST", url: `/organizations/${organizationId}/compute/requests`, headers: { authorization: `Bearer ${token}` }, payload: {
            poolId, workloadKind: "active-inference", priority: "interactive", profile: "interactive", checkpointable: false, restartable: false,
            requirements: { cpuThreads: 4, ramMB: 4_096, pinnedMemoryMB: 0, acceleratorCount: 1, acceleratorDeviceIds: [], acceleratorVendor: "nvidia", vramMBPerDevice: 4_096, sameNumaNode: false, sameVendor: true, exclusiveAccelerators: true, runtime: "llamacpp", modelId: "model-4b", allowCpuFallback: false },
        } });
        expect(submitted.statusCode).toBe(201);
        expect(submitted.json().decision.status).toBe("placed");
        const lease = submitted.json().lease;

        const assignments = await app.inject({ method: "GET", url: `/organizations/${organizationId}/compute/nodes/${nodeId}/assignments`, headers: { authorization: `Bearer ${token}` } });
        expect(assignments.statusCode).toBe(200);
        expect(assignments.json().assignments[0].lease.id).toBe(lease.id);

        const stale = await app.inject({ method: "POST", url: `/organizations/${organizationId}/compute/leases/${lease.id}/acknowledge`, headers: { authorization: `Bearer ${token}` }, payload: { fencingToken: "0" } });
        expect(stale.statusCode).toBe(409);
        const acknowledged = await app.inject({ method: "POST", url: `/organizations/${organizationId}/compute/leases/${lease.id}/acknowledge`, headers: { authorization: `Bearer ${token}` }, payload: { fencingToken: lease.fencingToken } });
        expect(acknowledged.statusCode).toBe(200);
        expect(acknowledged.json().state).toBe("running");
    });

    it("reads back a pool's quota after it's set, and 404s before one exists", async () => {
        const { poolId } = await enrollAndPool();
        const before = await app.inject({ method: "GET", url: `/organizations/${organizationId}/compute/pools/${poolId}/quota`, headers: { authorization: `Bearer ${token}` } });
        expect(before.statusCode).toBe(404);

        const put = await app.inject({ method: "PUT", url: `/organizations/${organizationId}/compute/pools/${poolId}/quota`, headers: { authorization: `Bearer ${token}` }, payload: {
            reservedCpuThreads: 4, reservedRamMB: 8_192, reservedAccelerators: 1, burstCpuThreads: 16, burstRamMB: 32_768, burstAccelerators: 2, weight: 3, borrowingEnabled: true,
        } });
        expect(put.statusCode, put.body).toBe(200);

        const after = await app.inject({ method: "GET", url: `/organizations/${organizationId}/compute/pools/${poolId}/quota`, headers: { authorization: `Bearer ${token}` } });
        expect(after.statusCode).toBe(200);
        expect(after.json()).toMatchObject({ poolId, weight: 3, reservedCpuThreads: 4, burstAccelerators: 2 });
    });

    it("does not expose another organization's inventory", async () => {
        await enrollAndPool();
        const otherToken = await new SignJWT({ sub: "idp|other" }).setProtectedHeader({ alg: "RS256", kid: KID }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime("1h").sign(key);
        const other = await app.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${otherToken}` }, payload: { name: "Other" } });
        const response = await app.inject({ method: "GET", url: `/organizations/${other.json().organization.id}/compute/nodes`, headers: { authorization: `Bearer ${otherToken}` } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([]);
    });
});
