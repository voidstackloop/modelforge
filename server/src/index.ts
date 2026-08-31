import { Pool } from "pg";
import { buildApp } from "./app.js";
import { resolveJwks } from "./auth/oidc-verifier.js";
import { createCacheFactory } from "./cache/create-cache.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { AccessGovernanceStore } from "./store/access-governance-store.js";
import { InMemoryAccessGovernanceStore } from "./store/in-memory-access-governance-store.js";
import { PostgresAccessGovernanceStore } from "./store/postgres-access-governance-store.js";
import type { AuditLegalHoldStore } from "./store/audit-legal-hold-store.js";
import { InMemoryAuditLegalHoldStore, PostgresAuditLegalHoldStore } from "./store/audit-legal-hold-store.js";
import type { AuditStore } from "./store/audit-store.js";
import { InMemoryAuditStore, PostgresAuditStore } from "./store/audit-store.js";
import { CachingIamStore } from "./store/caching-iam-store.js";
import type { CaseStore } from "./store/case-store.js";
import type { CaseMigrationStore } from "./store/case-migration-store.js";
import { InMemoryCaseMigrationStore } from "./store/in-memory-case-migration-store.js";
import { InMemoryCaseStore } from "./store/in-memory-case-store.js";
import type { IamStore } from "./store/iam-store.js";
import type { IdempotencyStore } from "./store/idempotency-store.js";
import { InMemoryIamStore } from "./store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "./store/in-memory-idempotency-store.js";
import { InMemoryPrincipalStore } from "./store/in-memory-principal-store.js";
import type { McpRegistryStore } from "./store/mcp-registry-store.js";
import { InMemoryMcpRegistryStore, PostgresMcpRegistryStore } from "./store/mcp-registry-store.js";
import { runMigrations } from "./store/migrate.js";
import { PostgresCaseStore } from "./store/postgres-case-store.js";
import { PostgresCaseMigrationStore } from "./store/postgres-case-migration-store.js";
import { PostgresIamStore } from "./store/postgres-iam-store.js";
import { PostgresIdempotencyStore } from "./store/postgres-idempotency-store.js";
import { PostgresPrincipalStore } from "./store/postgres-principal-store.js";
import type { ImagingStore } from "./store/imaging-store.js";
import { InMemoryImagingStore } from "./store/in-memory-imaging-store.js";
import { PostgresImagingStore } from "./store/postgres-imaging-store.js";
import type { PrincipalStore } from "./store/principal-store.js";
import type { ScimTokenStore } from "./store/scim-token-store.js";
import { InMemoryScimTokenStore, PostgresScimTokenStore } from "./store/scim-token-store.js";
import type { SessionStore } from "./store/session-store.js";
import { InMemorySessionStore } from "./store/in-memory-session-store.js";
import { PostgresSessionStore } from "./store/postgres-session-store.js";
import type { TenantBackupStore } from "./store/tenant-backup-store.js";
import { InMemoryTenantBackupStore, PostgresTenantBackupStore } from "./store/tenant-backup-store.js";
import { PostgresTenantDirectory, StoreTenantDirectory, type TenantDirectory } from "./tenant-context.js";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { LocalFilesystemImagingObjectStore, S3ImagingObjectStore, type ImagingObjectStore } from "./imaging/object-store.js";
import { LocalDicomwebAdapter, ProxyDicomwebAdapter } from "./imaging/dicomweb-adapter.js";
import { CloudFrontContentDelivery, OriginStreamContentDelivery } from "./imaging/content-delivery.js";
import { InMemoryAiGatewayStore } from "./store/in-memory-ai-gateway-store.js";
import { InMemoryAiProviderRegistryStore } from "./store/in-memory-ai-provider-registry-store.js";
import { PostgresAiGatewayStore } from "./store/postgres-ai-gateway-store.js";
import { PostgresAiProviderRegistryStore } from "./store/postgres-ai-provider-registry-store.js";
import type { AiGatewayStore } from "./store/ai-gateway-store.js";
import type { AiProviderRegistryStore } from "./store/ai-provider-registry-store.js";
import { AiInferenceAdmission } from "./ai-gateway/admission.js";
import type { ComputeControlStore } from "./store/compute-control-store.js";
import { InMemoryComputeControlStore } from "./store/compute-control-store.js";
import { PostgresComputeControlStore } from "./store/postgres-compute-control-store.js";

/** How long GET /health waits on its own DB probe before reporting
 * degraded — independent of the pool's own connectionTimeoutMillis/
 * statement_timeout, so a health probe never hangs as long as a real
 * request is allowed to. */
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

/** How often cache stats are logged (see logCacheStatsPeriodically below).
 * Deliberately not configurable via env — this is operational visibility,
 * not a behavior-affecting setting, and 5 minutes is frequent enough to
 * catch a developing problem (a climbing redisErrors count, sustained
 * degraded state) without flooding logs. */
const CACHE_STATS_LOG_INTERVAL_MS = 300_000;

interface BuiltStores {
    store: IamStore;
    caseStore: CaseStore;
    caseMigrationStore: CaseMigrationStore;
    idempotencyStore: IdempotencyStore;
    auditStore: AuditStore;
    auditLegalHoldStore: AuditLegalHoldStore;
    tenantBackupStore: TenantBackupStore;
    sessionStore: SessionStore;
    principalStore: PrincipalStore;
    accessGovernanceStore: AccessGovernanceStore;
    scimTokenStore: ScimTokenStore;
    imagingStore: ImagingStore;
    aiGatewayStore: AiGatewayStore;
    aiProviderRegistryStore: AiProviderRegistryStore;
    mcpRegistryStore: McpRegistryStore;
    computeControlStore: ComputeControlStore;
    tenantDirectory: TenantDirectory;
    closeCache: () => Promise<void>;
    /** undefined for the in-memory store (nothing to close, nothing to
     * health-check) — set only when DATABASE_URL configured a real Pool. */
    pool?: Pool;
    /** Set only when caching is enabled — see logCacheStatsPeriodically. */
    cachingStore?: CachingIamStore;
}

/**
 * Logs one structured line per sub-cache every CACHE_STATS_LOG_INTERVAL_MS
 * — hits/misses/loads/coalesced/evictions/expirations/invalidations/
 * redisErrors/degraded, per cache.ts's CacheStats doc comment. Never
 * includes a cached key or value (a subject identifier, a user id, a
 * policy document) — only aggregate counts, so this can't leak anything
 * sensitive into logs regardless of log retention/access policy. This is
 * this service's primary cache observability surface (alongside
 * CachingIamStore.stats(), the same method this calls, available to any
 * future diagnostic endpoint or ops tool that wants it on demand rather
 * than on a timer) — deliberately not a new HTTP endpoint: an admin-only
 * diagnostic route would need its own authorization gate to avoid
 * becoming a new unauthenticated information-disclosure surface, which is
 * more new surface than this service's cache layer alone warrants.
 */
function logCacheStatsPeriodically(store: CachingIamStore): () => void {
    const timer = setInterval(() => {
        void store.stats().then((stats) => {
            console.log(JSON.stringify({ event: "cache_stats", stats }));
        });
    }, CACHE_STATS_LOG_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

async function buildStores(config: AppConfig): Promise<BuiltStores> {
    let store: IamStore;
    let caseStore: CaseStore;
    let caseMigrationStore: CaseMigrationStore;
    let idempotencyStore: IdempotencyStore;
    let auditStore: AuditStore;
    let auditLegalHoldStore: AuditLegalHoldStore;
    let tenantBackupStore: TenantBackupStore;
    let sessionStore: SessionStore;
    let principalStore: PrincipalStore;
    let accessGovernanceStore: AccessGovernanceStore;
    let scimTokenStore: ScimTokenStore;
    let imagingStore: ImagingStore;
    let aiGatewayStore: AiGatewayStore;
    let aiProviderRegistryStore: AiProviderRegistryStore;
    let mcpRegistryStore: McpRegistryStore;
    let computeControlStore: ComputeControlStore;
    let tenantDirectory: TenantDirectory;
    let pool: Pool | undefined;

    if (!config.databaseUrl) {
        console.warn(
            "DATABASE_URL not set — running with in-memory stores. Every organization, user, group, policy, and " +
                "patient case will be lost on restart. See server/README.md before using this mode for anything but " +
                "local development."
        );
        // One shared InMemoryAuditStore, passed to both — see that class's
        // own doc comment for why: a GET /organizations/:id/audit read
        // needs IAM and case mutations merged into one chronological
        // trail, the same thing the Postgres mode gets for free from both
        // stores writing into the same `audit_log` table.
        const sharedAuditStore = new InMemoryAuditStore();
        auditStore = sharedAuditStore;
        auditLegalHoldStore = new InMemoryAuditLegalHoldStore(sharedAuditStore);
        tenantBackupStore = new InMemoryTenantBackupStore(sharedAuditStore);
        sessionStore = new InMemorySessionStore(sharedAuditStore);
        store = new InMemoryIamStore(sharedAuditStore);
        principalStore = new InMemoryPrincipalStore(sharedAuditStore);
        accessGovernanceStore = new InMemoryAccessGovernanceStore(sharedAuditStore);
        scimTokenStore = new InMemoryScimTokenStore(sharedAuditStore);
        imagingStore = new InMemoryImagingStore(sharedAuditStore);
        aiGatewayStore = new InMemoryAiGatewayStore(sharedAuditStore);
        aiProviderRegistryStore = new InMemoryAiProviderRegistryStore(sharedAuditStore);
        mcpRegistryStore = new InMemoryMcpRegistryStore(sharedAuditStore);
        computeControlStore = new InMemoryComputeControlStore(sharedAuditStore);
        tenantDirectory = new StoreTenantDirectory(store);
        caseStore = new InMemoryCaseStore(sharedAuditStore);
        caseMigrationStore = new InMemoryCaseMigrationStore(sharedAuditStore);
        idempotencyStore = new InMemoryIdempotencyStore();
    } else {
        // Migrations always run against config.databaseUrl (the migration-
        // owner role — needs CREATE SCHEMA / CREATE FUNCTION / ALTER
        // DEFAULT PRIVILEGES rights a restricted runtime role deliberately
        // lacks; see migrations/010_runtime_role_grants.sql). When
        // runtimeDatabaseUrl is also set, that migration connection is
        // separate and short-lived: opened here, used once, closed before
        // the application's own long-lived pool is built against the
        // (different, less-privileged) runtime URL instead. When
        // runtimeDatabaseUrl is unset — every environment before this
        // setting existed — there is no separate step: the one pool below
        // is used for both migrations and everything after.
        if (config.runtimeDatabaseUrl) {
            const migrationPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
            try {
                const { applied } = await runMigrations(migrationPool);
                if (applied.length > 0) {
                    console.log(`Applied ${applied.length} migration(s) via DATABASE_URL: ${applied.join(", ")}`);
                }
            } finally {
                await migrationPool.end();
            }
        }

        pool = new Pool({
            connectionString: config.runtimeDatabaseUrl ?? config.databaseUrl,
            max: config.dbPool.max,
            connectionTimeoutMillis: config.dbPool.connectionTimeoutMillis,
            idleTimeoutMillis: config.dbPool.idleTimeoutMillis,
            statement_timeout: config.dbPool.statementTimeoutMillis,
        });
        // pg.Pool is an EventEmitter that emits 'error' whenever a checked-
        // in idle client hits a backend/network fault (e.g. Postgres
        // restarts, a connection dropped by a firewall/LB idle timeout) —
        // without a listener, that's an unhandled 'error' event, which
        // Node treats as an uncaught exception and crashes the whole
        // process on what should be a recoverable, per-connection fault.
        pool.on("error", (err) => {
            console.error("Postgres pool error on an idle client (connection will be discarded and replaced):", err);
        });

        if (!config.runtimeDatabaseUrl) {
            const { applied } = await runMigrations(pool);
            if (applied.length > 0) {
                console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
            }
        }
        store = new PostgresIamStore(pool);
        principalStore = new PostgresPrincipalStore(pool);
        accessGovernanceStore = new PostgresAccessGovernanceStore(pool);
        tenantDirectory = new PostgresTenantDirectory(pool);
        caseStore = new PostgresCaseStore(pool);
        caseMigrationStore = new PostgresCaseMigrationStore(pool);
        idempotencyStore = new PostgresIdempotencyStore(pool);
        auditStore = new PostgresAuditStore(pool);
        auditLegalHoldStore = new PostgresAuditLegalHoldStore(pool);
        tenantBackupStore = new PostgresTenantBackupStore(pool);
        sessionStore = new PostgresSessionStore(pool);
        scimTokenStore = new PostgresScimTokenStore(pool);
        imagingStore = new PostgresImagingStore(pool);
        aiGatewayStore = new PostgresAiGatewayStore(pool);
        aiProviderRegistryStore = new PostgresAiProviderRegistryStore(pool);
        mcpRegistryStore = new PostgresMcpRegistryStore(pool);
        computeControlStore = new PostgresComputeControlStore(pool);
    }

    if (!config.cache.enabled) {
        return {
            store, caseStore, caseMigrationStore, idempotencyStore, auditStore, auditLegalHoldStore, tenantBackupStore, sessionStore,
            principalStore, accessGovernanceStore, scimTokenStore, imagingStore, aiGatewayStore, aiProviderRegistryStore, mcpRegistryStore, computeControlStore, tenantDirectory, closeCache: async () => {}, pool,
        };
    }

    if (config.cache.redisUrl) {
        console.log("Cache backend: Redis.");
    } else {
        console.log("REDIS_URL not set — caching in-memory, per-process only. See server/docker-compose.yml for a local Redis.");
    }
    const { factory, close } = createCacheFactory({ redisUrl: config.cache.redisUrl, ttlMs: config.cache.ttlMs });
    const cachingStore = new CachingIamStore(store, factory, { negativeCacheTtlMs: config.cache.negativeTtlMs });
    return {
        store: cachingStore, caseStore, caseMigrationStore, idempotencyStore, auditStore, auditLegalHoldStore, tenantBackupStore, sessionStore,
        principalStore, accessGovernanceStore, scimTokenStore, imagingStore, aiGatewayStore, aiProviderRegistryStore, mcpRegistryStore, computeControlStore, tenantDirectory, closeCache: close, pool, cachingStore,
    };
}

/** Builds GET /health's check when there's a real Postgres pool to check —
 * a lightweight `SELECT 1`, bounded by its own timeout so a degraded-but-
 * not-erroring network (a black hole, not a clean refusal) can't hang the
 * health probe itself. Redis is deliberately not checked here: this
 * service already degrades gracefully without it (see cache/redis-cache.ts)
 * — treating it as a liveness dependency would make an orchestrator kill a
 * perfectly-servable instance over a cache backend outage. */
function buildHealthCheck(pool: Pool | undefined): (() => Promise<boolean>) | undefined {
    if (!pool) return undefined;
    return async () => {
        try {
            await Promise.race([
                pool.query("SELECT 1"),
                new Promise((_resolve, reject) => setTimeout(() => reject(new Error("health check timed out")), HEALTH_CHECK_TIMEOUT_MS)),
            ]);
            return true;
        } catch (err) {
            console.error("Health check: Postgres unreachable:", err);
            return false;
        }
    };
}

async function main(): Promise<void> {
    const config = loadConfig();
    const jwks = await resolveJwks(config.oidc);
    // P2 item 3 (multiple-IdP compatibility) — resolved eagerly at startup,
    // same fail-loudly-if-unreachable posture as the primary issuer above,
    // rather than lazily on first use of a second IdP.
    const additionalOidcIssuers = await Promise.all(
        config.oidc.additionalIssuers.map(async (additional) => ({
            issuer: additional.issuer,
            audience: additional.audience,
            jwks: await resolveJwks(additional),
        }))
    );
    const {
        store, caseStore, caseMigrationStore, idempotencyStore, auditStore, auditLegalHoldStore, tenantBackupStore, sessionStore,
        principalStore, accessGovernanceStore, scimTokenStore, imagingStore, aiGatewayStore, aiProviderRegistryStore, mcpRegistryStore, computeControlStore, tenantDirectory, closeCache, pool, cachingStore,
    } = await buildStores(config);
    const stopCacheStatsLogging = cachingStore ? logCacheStatsPeriodically(cachingStore) : undefined;
    let imagingObjectStore: ImagingObjectStore;
    let imagingStorageMode: "local-filesystem" | "s3";
    if (config.imaging.s3) {
        const s3 = config.imaging.s3;
        imagingObjectStore = new S3ImagingObjectStore(s3.bucket, s3.kmsKeyId, s3.region, s3.keyPrefix);
        imagingStorageMode = "s3";
    } else {
        const key = config.imaging.encryptionKeyBase64 ? Buffer.from(config.imaging.encryptionKeyBase64, "base64") : randomBytes(32);
        if (!config.imaging.encryptionKeyBase64) console.warn("IMAGING_ENCRYPTION_KEY not set — local imaging objects will be unreadable after restart. Development mode only.");
        imagingObjectStore = new LocalFilesystemImagingObjectStore(config.imaging.localRoot ?? path.join(os.tmpdir(), "modelforge-imaging-dev"), key);
        imagingStorageMode = "local-filesystem";
    }
    const createDicomwebAdapter = config.imaging.pacs
        ? () => new ProxyDicomwebAdapter(config.imaging.pacs!.baseUrl, config.imaging.pacs!.authHeader)
        : (organizationId: string) => new LocalDicomwebAdapter(imagingObjectStore, organizationId);

    // CloudFront is opt-in and validated at startup (config.ts enforces
    // all-three-or-none plus "requires S3"). Without it, pixel data streams
    // through this process — see imaging/content-delivery.ts.
    const imagingContentDelivery = config.imaging.cloudFront
        ? new CloudFrontContentDelivery(
              config.imaging.cloudFront.domain,
              config.imaging.cloudFront.keyPairId,
              config.imaging.cloudFront.privateKeyPem
          )
        : new OriginStreamContentDelivery();

    const aiAdmission = new AiInferenceAdmission();

    const app = buildApp({
        store,
        caseStore,
        caseMigrationStore,
        idempotencyStore,
        auditStore,
        auditLegalHoldStore,
        tenantBackupStore,
        sessionStore,
        principalStore,
        accessGovernanceStore,
        scimTokenStore,
        imagingStore,
        imagingObjectStore,
        createDicomwebAdapter,
        imagingStorageMode,
        dicomwebMode: config.imaging.pacs ? "pacs-proxy" : "local",
        imagingContentDelivery,
        aiGatewayStore,
        aiProviderRegistryStore,
        mcpRegistryStore,
        computeControlStore,
        computePolicyPublicKeyPem: process.env.COMPUTE_POLICY_PUBLIC_KEY_PEM,
        aiAdmission,
        breakGlassGrantDurationMs: config.breakGlass.grantDurationMs,
        tenantDirectory,
        jwks,
        oidc: config.oidc,
        additionalOidcIssuers,
        logger: true,
        healthCheck: buildHealthCheck(pool),
        cacheStats: cachingStore ? () => cachingStore.stats() : undefined,
        metricsToken: config.metricsToken,
        rateLimit: config.rateLimit,
        trustProxy: config.trustProxy,
        adminConsoleOrigin: config.adminConsoleOrigin,
    });
    await app.listen({ port: config.port, host: "0.0.0.0" });

    // Crash-safety net for AiInferenceAdmission (server/src/ai-gateway/
    // admission.ts): reclaims any lease whose holder crashed mid-inference
    // without releasing it, across every tenant (the admission instance is
    // process-wide, not per-tenant). This is the only piece of
    // ClinicalAiGateway.runMaintenanceSweep() wired to a timer here —
    // per-tenant stale-consent expiry is deliberately NOT swept on a cross-
    // tenant schedule, since gateway.ts's own submitRequest already expires
    // a case's stale consents inline on every real request before
    // authorizing (the actual "revocation prevents new AI requests
    // immediately" requirement), making a separate background sweep across
    // every idle tenant a cleanup nicety rather than a safety gate.
    const aiAdmissionSweepTimer = setInterval(() => {
        const reclaimed = aiAdmission.sweepExpired();
        if (reclaimed.length > 0) console.warn(`AiInferenceAdmission: reclaimed ${reclaimed.length} expired lease(s) whose holder never released them: ${reclaimed.join(", ")}`);
    }, 60_000);
    aiAdmissionSweepTimer.unref?.();

    // Managed-node heartbeats arrive every 15s and leases renew every 30s.
    // A 10s sweep bounds stale-node detection and expired-lease recovery
    // without making correctness depend on exact timer alignment; the
    // database functions are idempotent and hold the cross-tenant RLS
    // privilege boundary for production runtime-role deployments.
    const computeSweepTimer = setInterval(() => {
        const now = new Date();
        void Promise.all([
            computeControlStore.sweepExpired(now.toISOString()),
            computeControlStore.markStaleNodes(new Date(now.getTime() - 45_000).toISOString()),
        ]).then(([leases, nodes]) => {
            if (leases.length > 0 || nodes.length > 0) {
                console.warn(JSON.stringify({ event: "compute_control_reclaimed", expiredLeaseCount: leases.length, offlineNodeCount: nodes.length }));
            }
        }).catch((error) => console.error("Compute control maintenance sweep failed:", error));
    }, 10_000);
    computeSweepTimer.unref?.();

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
        if (shuttingDown) return; // SIGTERM and SIGINT can both arrive; don't double-run
        shuttingDown = true;
        clearInterval(aiAdmissionSweepTimer);
        clearInterval(computeSweepTimer);
        stopCacheStatsLogging?.();
        await app.close();
        await closeCache();
        if (pool) await pool.end();
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
    console.error("Fatal error starting modelforge-medical-iam-server:", err);
    process.exitCode = 1;
});
