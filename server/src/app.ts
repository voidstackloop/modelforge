import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { JWTVerifyGetKey } from "jose";
import { ZodError } from "zod";
import { timingSafeEqual } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { createAuthPreHandler, type TrustedIssuer } from "./auth/auth-plugin.js";
import { httpRequestDuration, metricsRegistry, updateCacheGauges } from "./metrics.js";
import type { CacheStats } from "./cache/cache.js";
import { registerAccessReviewRoutes } from "./routes/access-reviews.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerBreakGlassRoutes } from "./routes/break-glass.js";
import { AuthzError } from "./routes/guards.js";
import { registerAuthzRoutes } from "./routes/authz.js";
import { registerCaseRoutes } from "./routes/cases.js";
import { registerCaseMigrationRoutes } from "./routes/case-migrations.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerMcpRegistryRoutes } from "./routes/mcp-registry.js";
import { registerComputeControlRoutes } from "./routes/compute-control.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerPolicyRoutes } from "./routes/policies.js";
import { registerImagingDicomwebRoutes } from "./routes/imaging-dicomweb.js";
import { registerImagingIngestionRoutes } from "./routes/imaging-ingestion.js";
import { registerImagingReportRoutes } from "./routes/imaging-reports.js";
import { registerImagingShareRoutes } from "./routes/imaging-share.js";
import { registerImagingStudyRoutes } from "./routes/imaging-studies.js";
import { registerImagingViewerSessionRoutes } from "./routes/imaging-viewer-sessions.js";
import { registerImagingIntegrationRoutes } from "./routes/imaging-integrations.js";
import { registerImagingDeidentificationRoutes } from "./routes/imaging-deidentification.js";
import { registerAiGatewayRoutes } from "./routes/ai-gateway.js";
import { registerPolicyVersionRoutes } from "./routes/policy-versions.js";
import { registerScimRoutes } from "./routes/scim.js";
import { registerScimTokenRoutes } from "./routes/scim-tokens.js";
import { registerServicePrincipalRoutes } from "./routes/service-principals.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerTenantBackupRoutes } from "./routes/tenant-backup.js";
import { registerUserRoutes } from "./routes/users.js";
import type { AccessGovernanceStore } from "./store/access-governance-store.js";
import type { AuditLegalHoldStore } from "./store/audit-legal-hold-store.js";
import { InMemoryAuditLegalHoldStore } from "./store/audit-legal-hold-store.js";
import type { AuditStore } from "./store/audit-store.js";
import type { CaseStore } from "./store/case-store.js";
import type { CaseMigrationStore } from "./store/case-migration-store.js";
import { InMemoryAccessGovernanceStore } from "./store/in-memory-access-governance-store.js";
import { InMemoryCaseMigrationStore } from "./store/in-memory-case-migration-store.js";
import type { IamStore } from "./store/iam-store.js";
import type { IdempotencyStore } from "./store/idempotency-store.js";
import type { McpRegistryStore } from "./store/mcp-registry-store.js";
import { InMemoryMcpRegistryStore } from "./store/mcp-registry-store.js";
import type { ComputeControlStore } from "./store/compute-control-store.js";
import { InMemoryComputeControlStore } from "./store/compute-control-store.js";
import { ComputeControlPlane } from "./compute/control-plane.js";
import { createComputePolicySignatureVerifier } from "./compute/policy-signature.js";
import { InMemoryPrincipalStore } from "./store/in-memory-principal-store.js";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import type { DicomwebAdapter } from "./imaging/dicomweb-adapter.js";
import { LocalDicomwebAdapter } from "./imaging/dicomweb-adapter.js";
import type { ImagingContentDelivery } from "./imaging/content-delivery.js";
import { OriginStreamContentDelivery } from "./imaging/content-delivery.js";
import type { ImagingObjectStore } from "./imaging/object-store.js";
import { LocalFilesystemImagingObjectStore } from "./imaging/object-store.js";
import type { ImagingStore } from "./store/imaging-store.js";
import { InMemoryImagingStore } from "./store/in-memory-imaging-store.js";
import type { AiProvider, AiProviderModel } from "@modelforge/contracts";
import type { AiGatewayStore } from "./store/ai-gateway-store.js";
import { InMemoryAiGatewayStore } from "./store/in-memory-ai-gateway-store.js";
import type { AiProviderRegistryStore } from "./store/ai-provider-registry-store.js";
import { InMemoryAiProviderRegistryStore } from "./store/in-memory-ai-provider-registry-store.js";
import { AiInferenceAdmission } from "./ai-gateway/admission.js";
import type { AiProviderClient } from "./ai-gateway/provider-client.js";
import { createRegistryProviderResolver } from "./ai-gateway/provider-client.js";
import type { PrincipalStore } from "./store/principal-store.js";
import type { ScimTokenStore } from "./store/scim-token-store.js";
import { InMemoryScimTokenStore } from "./store/scim-token-store.js";
import type { SessionStore } from "./store/session-store.js";
import { InMemorySessionStore } from "./store/in-memory-session-store.js";
import type { TenantBackupStore } from "./store/tenant-backup-store.js";
import { InMemoryTenantBackupStore } from "./store/tenant-backup-store.js";
import { StoreTenantDirectory, type TenantDirectory } from "./tenant-context.js";

/** See config.ts's AppConfig.breakGlass.grantDurationMs doc comment — a
 * placeholder default (4 hours), not a derived requirement. Used only when
 * BuildAppOptions.breakGlassGrantDurationMs is omitted (every test in this
 * package). */
const DEFAULT_BREAK_GLASS_GRANT_DURATION_MS = 14_400_000;

// Used only when BuildAppOptions.imagingObjectStore/imagingObjectStore-
// derived options are omitted — every test in this package, and any local/
// dev run that hasn't set IMAGING_ENCRYPTION_KEY (index.ts) explicitly. A
// fresh random key per process start means anything stored under a
// previous process's default key becomes unreadable after a restart —
// acceptable for a fallback default (a real deployment must configure a
// stable key), not acceptable to rely on beyond that. Lazily constructed
// (not at module load) so importing app.ts never touches the filesystem
// as a side effect.
let _defaultImagingObjectStore: LocalFilesystemImagingObjectStore | undefined;
function getDefaultImagingObjectStore(): LocalFilesystemImagingObjectStore {
    if (!_defaultImagingObjectStore) {
        _defaultImagingObjectStore = new LocalFilesystemImagingObjectStore(path.join(os.tmpdir(), "modelforge-imaging-dev"), randomBytes(32));
    }
    return _defaultImagingObjectStore;
}

export interface BuildAppOptions {
    store: IamStore;
    caseStore: CaseStore;
    caseMigrationStore?: CaseMigrationStore;
    idempotencyStore: IdempotencyStore;
    auditStore: AuditStore;
    auditLegalHoldStore?: AuditLegalHoldStore;
    tenantBackupStore?: TenantBackupStore;
    sessionStore?: SessionStore;
    principalStore?: PrincipalStore;
    accessGovernanceStore?: AccessGovernanceStore;
    scimTokenStore?: ScimTokenStore;
    mcpRegistryStore?: McpRegistryStore;
    computeControlStore?: ComputeControlStore;
    /** Ed25519 SPKI PEM used to verify organization-bound compute policy
     * payloads. Omission fails policy creation closed with HTTP 503. */
    computePolicyPublicKeyPem?: string;
    /** Defaults to the authorized TLS peer certificate fingerprint. A
     * trusted mTLS-terminating ingress may inject a resolver that reads its
     * authenticated certificate metadata; an arbitrary request header is
     * intentionally not accepted by default. */
    resolveComputeAgentCertificateFingerprint?: (request: FastifyRequest) => string | undefined;
    imagingStore?: ImagingStore;
    imagingObjectStore?: ImagingObjectStore;
    createDicomwebAdapter?: (organizationId: string) => DicomwebAdapter;
    imagingStorageMode?: "local-filesystem" | "s3";
    dicomwebMode?: "local" | "pacs-proxy";
    imagingContentDelivery?: ImagingContentDelivery;
    aiGatewayStore?: AiGatewayStore;
    aiProviderRegistryStore?: AiProviderRegistryStore;
    /** Fresh per buildApp() call when omitted — never a shared/module-level
     * singleton, so two apps built in the same test process (or two tests
     * in this package) never contend over each other's admission capacity.
     * index.ts constructs one long-lived instance for the real process. */
    aiAdmission?: AiInferenceAdmission;
    /** Defaults to the verified artifact/deployment registry. A model with
     * no active deployment fails closed instead of falling back to a
     * different runtime or model. */
    resolveAiProviderClient?: (provider: AiProvider, providerModel: AiProviderModel) => AiProviderClient | Promise<AiProviderClient>;
    /** See config.ts's AppConfig.breakGlass.grantDurationMs doc comment.
     * Defaults to 4 hours when omitted (every test in this package) — a
     * placeholder value, not a derived requirement. */
    breakGlassGrantDurationMs?: number;
    tenantDirectory?: TenantDirectory;
    /** A `jose` JWTVerifyGetKey — production passes a remote JWKS resolved
     * via auth/oidc-verifier.ts's resolveJwks(); tests pass a local one, so
     * building the app never itself makes a network call. See index.ts for
     * the production wiring and app.test.ts for the test wiring. */
    jwks: JWTVerifyGetKey;
    oidc: { issuer: string; audience: string };
    /** P2 item 3 (multiple-IdP compatibility), optional and empty by
     * default — every existing deployment and every test in this package
     * configures only the required `jwks`/`oidc` pair above and behaves
     * exactly as before. See auth/auth-plugin.ts's createAuthPreHandler doc
     * comment for the selection mechanism and its safety argument. */
    additionalOidcIssuers?: TrustedIssuer[];
    logger?: boolean;
    /** Backs GET /health. Omitted (the default in every test in this
     * package) means /health always reports `{ status: "ok" }` without
     * checking anything — appropriate for the in-memory store, which has
     * nothing external to be unreachable. index.ts supplies a real one when
     * DATABASE_URL is set, so an orchestrator's liveness/readiness probe
     * can actually detect "Postgres is unreachable" instead of routing
     * traffic to an instance that will 500 on every request. Returning
     * `false` (never throwing) reports degraded — see route below. */
    healthCheck?: () => Promise<boolean>;
    /** Backs the cache-stat gauges GET /metrics reports (see metrics.ts's
     * updateCacheGauges) — index.ts supplies `cachingStore.stats.bind(...)`
     * when caching is enabled. Omitted (every test in this package, and any
     * deployment running CACHE_DISABLE=1) means those gauges simply report
     * nothing, matching "no cache" rather than a stale snapshot. */
    cacheStats?: () => Promise<Record<string, CacheStats>>;
    /** METRICS_TOKEN, optional. When set, GET /metrics requires
     * `Authorization: Bearer <token>` to match exactly (constant-time) —
     * defense in depth for an operator who wants to gate it even though its
     * content is deliberately PHI-free/metadata-only (see metrics.ts) and
     * therefore safe to leave open by default, the same posture as /health.
     * The real boundary a production deployment should rely on is network-
     * level (don't route the public internet to /metrics at all) — this is
     * a second layer, not a replacement for that. */
    metricsToken?: string;
    /** Global per-IP request rate limiting (@fastify/rate-limit) — omitted
     * (every test in this package) disables it entirely, so `app.inject()`
     * calling the same endpoint many times in one test never trips a limit
     * that has nothing to do with what the test is checking. index.ts
     * supplies real values from config.ts's RATE_LIMIT_MAX/WINDOW_MS. */
    rateLimit?: { max: number; windowMs: number };
    /** Whether Fastify should trust `X-Forwarded-*` headers from the
     * immediate peer for `request.ip` — see config.ts's TRUST_PROXY doc
     * comment for the full reasoning. Defaults false (every test in this
     * package, and any caller that omits it): `app.inject()` has no real
     * socket/proxy hop anyway, and a real deployment not behind a trusted
     * reverse proxy must not trust caller-supplied forwarding headers. */
    trustProxy?: boolean;
    /** Exact origin (scheme+host+port) to allow via CORS — see
     * config.ts's AppConfig.adminConsoleOrigin doc comment. Omitted (every
     * test in this package, and any deployment not yet using a separate
     * browser-based admin console) means no CORS plugin is registered at
     * all: a browser blocks every cross-origin fetch() regardless of any
     * other header, which is the correct default for an API not meant to
     * be called directly from an arbitrary web page. */
    adminConsoleOrigin?: string;
}

/**
 * Builds (but does not start listening on) the Fastify app — kept separate
 * from index.ts's process bootstrap specifically so tests can build a real
 * app instance and drive it with Fastify's own `app.inject()`, exercising
 * actual route registration, auth, and error handling end to end without a
 * real network socket or a real IdP. See routes.test.ts.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
    const fastify = Fastify({
        logger: options.logger ?? false,
        // Bounds a slow/stalled request body (a slowloris-style client
        // trickling bytes to hold a connection open) and an idle keep-alive
        // socket — Fastify/Node's own defaults leave requestTimeout
        // unbounded. Irrelevant to app.inject() in tests (it bypasses the
        // real socket layer), so this has no effect on this package's test
        // suite.
        requestTimeout: 30_000,
        keepAliveTimeout: 5_000,
        connectionTimeout: 10_000,
        // Fastify's own default — made explicit (not raised) since it's
        // never been reviewed against this service's actual payloads
        // (policy documents, patient-case envelopes) until now: both
        // comfortably fit well within 1 MiB.
        bodyLimit: 1_048_576,
        trustProxy: options.trustProxy ?? false,
    });

    // Baseline security headers (X-Content-Type-Options, Referrer-Policy,
    // etc.) for every response. contentSecurityPolicy is off — this
    // service never serves HTML/scripts, so CSP has nothing to protect
    // here and would just be a no-op header. crossOriginResourcePolicy is
    // relaxed to "cross-origin" — unlike a same-origin web app, this API is
    // meant to be called from other origins (other services, a future
    // browser-based admin console per docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md
    // §5), and helmet's "same-origin" default would have browsers block
    // exactly that, regardless of any CORS headers.
    fastify.register(helmet, {
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: "cross-origin" },
    });

    // Global HTTP-duration observability (metrics.ts's http_request_duration_seconds).
    // Added directly on the root `fastify` instance, not inside the nested
    // routes plugin below — same reasoning as helmet/rate-limit's own
    // comment just above this block: a hook added here is live before any
    // route (registered via the nested `fastify.register(...)` further
    // down) can possibly receive a request, regardless of avvio's async
    // plugin-loading order. /metrics and /health* are excluded so
    // orchestrator/scraper polling (frequent, near-zero-latency, and not a
    // "real" API call) never skews the distribution real traffic produces.
    const EXCLUDED_FROM_HTTP_METRICS = new Set(["/metrics", "/health", "/health/live", "/health/ready"]);
    fastify.addHook("onResponse", (request, reply, done) => {
        const route = request.routeOptions?.url;
        if (route && !EXCLUDED_FROM_HTTP_METRICS.has(route)) {
            httpRequestDuration.observe(
                { method: request.method, route, status_code: String(reply.statusCode) },
                reply.elapsedTime / 1000
            );
        }
        done();
    });

    if (options.rateLimit) {
        const HEALTH_PATHS = new Set(["/health", "/health/live", "/health/ready"]);
        fastify.register(rateLimit, {
            max: options.rateLimit.max,
            timeWindow: options.rateLimit.windowMs,
            // /health is polled frequently by orchestrators (liveness/
            // readiness probes) and checks nothing per-caller-sensitive —
            // it shouldn't compete with real traffic for the same budget,
            // and a probe getting rate-limited would falsely read as this
            // instance being unhealthy.
            allowList: (request) => HEALTH_PATHS.has(request.url.split("?", 1)[0] ?? request.url),
        });
    }

    if (options.adminConsoleOrigin) {
        // credentials: false — auth here is a manually-attached
        // Authorization header, never an ambient cookie, so there is
        // nothing for Access-Control-Allow-Credentials to protect and
        // enabling it would only widen what a misconfigured origin could
        // do. See config.ts's adminConsoleOrigin doc comment for why this
        // is opt-in (unset = no CORS plugin at all) rather than a default
        // wildcard/allow-list.
        //
        // methods must be explicit: @fastify/cors's own default is
        // 'GET,HEAD,POST' only (verified directly against the installed
        // @fastify/cors@11 package, not assumed) — every PUT/PATCH/DELETE
        // route the admin console calls (quota, break-glass policy, user/
        // group/policy/service-principal updates, policy/invitation
        // deletes) would otherwise fail preflight from a real browser. This
        // was caught by an actual browser session against a real server,
        // not by any existing test — app.inject()-based integration tests
        // bypass CORS entirely, and admin-console unit tests mock fetch
        // directly, so neither exercises a real preflight.
        fastify.register(cors, { origin: options.adminConsoleOrigin, credentials: false, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });
    }

    // Routes are registered inside a nested plugin, not directly on
    // `fastify`, so that Fastify's boot sequencer (avvio) is what
    // guarantees ordering here, not source-line order: `fastify.register()`
    // above only *enqueues* helmet/rate-limit/cors — their actual plugin bodies
    // (which is where each attaches its global onRequest/onRoute hook) run
    // later, asynchronously. A route added with a plain `fastify.get(...)`
    // right after those `register()` calls would still be added
    // synchronously, before either plugin's hook exists yet, silently
    // never being rate-limited. Wrapping every route registration in its
    // own `fastify.register(async (instance) => ...)` puts it in the same
    // avvio queue as helmet/rate-limit, so avvio runs it strictly after
    // both have finished loading (and their hooks — which apply to the
    // whole encapsulation tree — are already attached).
    fastify.register(async (instance) => {
        const authPreHandler = createAuthPreHandler(options.oidc, options.jwks, options.additionalOidcIssuers ?? []);
        const aiProviderRegistryStore = options.aiProviderRegistryStore ?? new InMemoryAiProviderRegistryStore(options.auditStore);
        const computeControlStore = options.computeControlStore ?? new InMemoryComputeControlStore(options.auditStore);
        const deps = {
            store: options.store,
            caseStore: options.caseStore,
            caseMigrationStore: options.caseMigrationStore ?? new InMemoryCaseMigrationStore(options.auditStore),
            idempotencyStore: options.idempotencyStore,
            auditStore: options.auditStore,
            auditLegalHoldStore: options.auditLegalHoldStore ?? new InMemoryAuditLegalHoldStore(options.auditStore),
            tenantBackupStore: options.tenantBackupStore ?? new InMemoryTenantBackupStore(options.auditStore),
            sessionStore: options.sessionStore ?? new InMemorySessionStore(options.auditStore),
            principalStore: options.principalStore ?? new InMemoryPrincipalStore(options.auditStore),
            accessGovernanceStore: options.accessGovernanceStore ?? new InMemoryAccessGovernanceStore(options.auditStore),
            scimTokenStore: options.scimTokenStore ?? new InMemoryScimTokenStore(options.auditStore),
            mcpRegistryStore: options.mcpRegistryStore ?? new InMemoryMcpRegistryStore(options.auditStore),
            computeControlStore,
            computeControlPlane: new ComputeControlPlane(computeControlStore),
            verifyComputePolicySignature: createComputePolicySignatureVerifier(options.computePolicyPublicKeyPem),
            resolveComputeAgentCertificateFingerprint: options.resolveComputeAgentCertificateFingerprint ?? ((request: FastifyRequest) => {
                const socket = request.raw.socket as TLSSocket;
                if (!socket.authorized || typeof socket.getPeerCertificate !== "function") return undefined;
                return socket.getPeerCertificate()?.fingerprint256;
            }),
            imagingStore: options.imagingStore ?? new InMemoryImagingStore(options.auditStore),
            imagingObjectStore: options.imagingObjectStore ?? getDefaultImagingObjectStore(),
            createDicomwebAdapter:
                options.createDicomwebAdapter ??
                ((organizationId: string) => new LocalDicomwebAdapter(options.imagingObjectStore ?? getDefaultImagingObjectStore(), organizationId)),
            imagingStorageMode: options.imagingStorageMode ?? "local-filesystem",
            dicomwebMode: options.dicomwebMode ?? "local",
            // Safe default: no CDN, every byte streams through this
            // server's own authenticated WADO route.
            imagingContentDelivery: options.imagingContentDelivery ?? new OriginStreamContentDelivery(),
            aiGatewayStore: options.aiGatewayStore ?? new InMemoryAiGatewayStore(options.auditStore),
            aiProviderRegistryStore,
            aiAdmission: options.aiAdmission ?? new AiInferenceAdmission(),
            resolveAiProviderClient: options.resolveAiProviderClient ?? createRegistryProviderResolver(aiProviderRegistryStore),
            breakGlassGrantDurationMs: options.breakGlassGrantDurationMs ?? DEFAULT_BREAK_GLASS_GRANT_DURATION_MS,
            tenantDirectory: options.tenantDirectory ?? new StoreTenantDirectory(options.store),
            authPreHandler,
        };

        // Raw-binary content types for DICOM upload (routes/imaging-ingestion.ts).
        // Fastify only parses application/json and text/plain by default;
        // anything else is a 415 unless a parser is registered. This one
        // just hands back the raw Buffer — no JSON/text decoding applies to
        // pixel data. Registered on `instance`, not the root `fastify`, so
        // it's scoped to the same encapsulation as every route below (and
        // still runs after helmet/rate-limit per this block's own comment
        // on avvio ordering). The route itself sets a much higher bodyLimit
        // than this app's 1 MiB default (see buildApp's Fastify() options
        // above) via its own per-route `bodyLimit` — this parser has no
        // size opinion of its own.
        instance.addContentTypeParser(["application/dicom", "application/octet-stream"], { parseAs: "buffer" }, (_request, payload, done) => {
            done(null, payload);
        });

        instance.get("/health", async (_request, reply) => {
            if (!options.healthCheck) return { status: "ok" };
            const healthy = await options.healthCheck();
            if (!healthy) {
                reply.code(503);
                return { status: "degraded" };
            }
            return { status: "ok" };
        });

        // Split liveness/readiness contracts (named explicitly as a gap in
        // docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md's Phase 0 Operations
        // section) alongside the original /health above, kept working
        // unchanged for any existing consumer (this package's own
        // docker-compose.yml, an operator's already-deployed probe config).
        // /health/live never depends on Postgres: this process being able
        // to answer HTTP at all is what "alive" means for an orchestrator's
        // restart-on-failure decision — restarting a perfectly healthy
        // process because its *database* is briefly unreachable would only
        // add a thundering-herd reconnect storm on top of an existing
        // outage. /health/ready is exactly today's DB-aware /health
        // behavior under its own explicit name, for a load-balancer/
        // readiness probe that must stop routing traffic to an instance
        // that cannot currently serve a real request.
        instance.get("/health/live", async () => ({ status: "ok" }));
        instance.get("/health/ready", async (_request, reply) => {
            if (!options.healthCheck) return { status: "ok" };
            const healthy = await options.healthCheck();
            if (!healthy) {
                reply.code(503);
                return { status: "degraded" };
            }
            return { status: "ok" };
        });

        // See metrics.ts's own doc comment: every metric this endpoint
        // exposes is a bounded-label aggregate (route pattern, method,
        // status code, allow/deny, cache name) — never a patient, case,
        // session, user, or organization id — so this is safe to leave
        // unauthenticated by default, the same posture as /health above.
        // options.metricsToken is an optional second layer for an operator
        // who wants one; the real boundary a production deployment should
        // rely on is network-level (see BuildAppOptions.metricsToken's own
        // doc comment).
        instance.get("/metrics", async (request, reply) => {
            if (options.metricsToken) {
                const header = request.headers.authorization ?? "";
                const expected = `Bearer ${options.metricsToken}`;
                const headerBuffer = Buffer.from(header);
                const expectedBuffer = Buffer.from(expected);
                const matches =
                    headerBuffer.length === expectedBuffer.length && timingSafeEqual(headerBuffer, expectedBuffer);
                if (!matches) {
                    reply.code(401).send({ error: "unauthorized", message: "Missing or invalid metrics bearer token." });
                    return;
                }
            }
            if (options.cacheStats) updateCacheGauges(await options.cacheStats());
            reply.header("Content-Type", metricsRegistry.contentType);
            reply.send(await metricsRegistry.metrics());
        });

        registerMeRoutes(instance, deps);
        registerOrganizationRoutes(instance, deps);
        registerUserRoutes(instance, deps);
        registerInvitationRoutes(instance, deps);
        registerServicePrincipalRoutes(instance, deps);
        registerGroupRoutes(instance, deps);
        registerPolicyRoutes(instance, deps);
        registerAuthzRoutes(instance, deps);
        registerCaseRoutes(instance, deps);
        registerCaseMigrationRoutes(instance, deps);
        registerAuditRoutes(instance, deps);
        registerBreakGlassRoutes(instance, deps);
        registerAccessReviewRoutes(instance, deps);
        registerPolicyVersionRoutes(instance, deps);
        registerTenantBackupRoutes(instance, deps);
        registerSessionRoutes(instance, deps);
        registerScimTokenRoutes(instance, deps);
        registerMcpRegistryRoutes(instance, deps);
        registerComputeControlRoutes(instance, deps);
        registerImagingStudyRoutes(instance, deps);
        registerImagingReportRoutes(instance, deps);
        registerImagingShareRoutes(instance, deps);
        registerImagingViewerSessionRoutes(instance, deps);
        registerImagingIntegrationRoutes(instance, deps);
        registerImagingDeidentificationRoutes(instance, deps);
        registerImagingIngestionRoutes(instance, deps);
        registerAiGatewayRoutes(instance, deps);
        // DICOMweb routes are bearer-token (viewer-session) authenticated,
        // not OIDC — see that file's own requireViewerSession, the same
        // "not deps.authPreHandler" pattern routes/scim.ts already
        // established for a different non-OIDC bearer scheme.
        registerImagingDicomwebRoutes(instance, deps);
        // SCIM protocol routes are deliberately registered on `instance`
        // too (not a separate top-level fastify.register) — they still
        // need helmet/rate-limit's hooks (registered on the root `fastify`
        // above), just not authPreHandler (see routes/scim.ts's own
        // per-request bearer-token check, which is not OIDC-shaped).
        registerScimRoutes(instance, deps);
    });

    // Central error handling — the only place a thrown AuthzError or
    // ZodError becomes an HTTP response, so every route can just `throw`
    // (or let .parse() throw) rather than each handler repeating its own
    // try/catch translation.
    fastify.setErrorHandler((err, _request, reply) => {
        if (err instanceof AuthzError) {
            reply.code(err.statusCode).send({ error: "authorization_error", message: err.message });
            return;
        }
        if (err instanceof ZodError) {
            reply.code(400).send({ error: "invalid_request", message: "Request failed validation.", issues: err.issues });
            return;
        }
        // A framework/plugin error that already carries its own intended
        // 4xx status (Fastify's own malformed-body/oversized-payload
        // errors, @fastify/rate-limit's 429, ...) — surface it as-is
        // rather than masking a well-formed client error as a generic 500.
        // Deliberately not extended to 5xx: an error that already claims
        // statusCode 500+ (or has none) still falls through to the logged
        // internal_error branch below, since that's a genuine unexpected
        // failure worth alerting on, not a client mistake to just pass
        // through quietly.
        const maybeStatusCode = (err as { statusCode?: unknown } | null)?.statusCode;
        const statusCode = typeof maybeStatusCode === "number" ? maybeStatusCode : undefined;
        if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
            const message = err instanceof Error ? err.message : "Request failed.";
            reply.code(statusCode).send({ error: "request_error", message });
            return;
        }
        fastify.log.error(err);
        reply.code(500).send({ error: "internal_error", message: "Unexpected server error." });
    });

    return fastify;
}
