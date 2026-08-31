export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

export interface AppConfig {
    port: number;
    oidc: {
        issuer: string;
        /** Required (see loadConfig's OIDC_AUDIENCE check) — without this,
         * verifyAccessToken has no way to distinguish a real access token
         * for this API from an ID token or an access token minted for a
         * completely different client of the same IdP: both are validly
         * signed by the same issuer and carry a `sub` claim, so signature
         * and issuer checks alone don't tell them apart. `aud` is the
         * portable, spec-defined (RFC 7519 §4.1.3) way to make that
         * distinction without coupling this generic OIDC relying party to
         * one provider's proprietary claim (e.g. Cognito's `token_use`). */
        audience: string;
        /** If unset, resolved via OIDC discovery against `issuer` at startup
         * — see auth/oidc-verifier.ts's resolveJwks(). */
        jwksUri?: string;
        /** OIDC_ADDITIONAL_ISSUERS, optional — JSON array of `{issuer,
         * audience, jwksUri?}`, empty by default. P2 item 3 (multiple-IdP
         * compatibility): lets an institution accept tokens from more than
         * one IdP at once (migrating between providers, or federating a
         * legacy on-prem provider alongside a new cloud one) without
         * changing anything about the required primary issuer/audience
         * above. See auth/auth-plugin.ts's createAuthPreHandler for how a
         * token is routed to the right issuer's keys, and why that routing
         * is never itself a security boundary. A JSON blob (not more
         * scalar env vars, this config's usual style) because this is a
         * genuinely variable-length list — an indexed
         * OIDC_ISSUER_2/OIDC_ISSUER_3/... scheme doesn't have a natural
         * stopping point and gets unwieldy past two or three entries. */
        additionalIssuers: { issuer: string; audience: string; jwksUri?: string }[];
    };
    /** If unset, index.ts falls back to the in-memory store — see
     * store/in-memory-iam-store.ts and server/README.md's "Known gaps."
     * Standard `postgres://user:password@host:port/database` connection
     * string, passed straight to `pg`'s Pool. Doubles as the migration
     * connection: index.ts always runs runMigrations() against
     * *this* URL, never against runtimeDatabaseUrl (see its own doc
     * comment) — DDL (CREATE SCHEMA, the SECURITY DEFINER provisioning
     * function, ALTER DEFAULT PRIVILEGES) needs owner-level privileges a
     * restricted runtime role deliberately doesn't have. */
    databaseUrl?: string;
    /** RUNTIME_DATABASE_URL, optional. When set, index.ts runs migrations
     * against `databaseUrl` (the migration-owner role) but then builds the
     * actual long-lived application Pool against *this* URL instead —
     * letting the server run day-to-day as a separate, less-privileged
     * role (see migrations/010_runtime_role_grants.sql: NO BYPASSRLS,
     * can't CREATE SCHEMA) while still allowing one operator-run process
     * to apply migrations first. When unset (the default — matches every
     * environment before this setting existed), `databaseUrl` is used for
     * both, exactly as before: one role/connection does everything. */
    runtimeDatabaseUrl?: string;
    /** ADMIN_CONSOLE_ORIGIN, optional. The exact origin (scheme+host+port,
     * e.g. https://admin.example-hospital.org) of a deployed admin-console
     * web app to allow via CORS (app.ts registers @fastify/cors only when
     * this is set) — this API has no CORS support at all otherwise, so a
     * browser blocks every cross-origin fetch() regardless of any other
     * header. Unset (the default) means CORS stays fully off: this service
     * is meant to be called by other services and, per
     * docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §5, a future browser-based
     * admin console — not by an arbitrary web page. Only one origin is
     * supported; a multi-environment deployment (e.g. staging + prod
     * consoles against one shared API) needs this generalized to a list,
     * not attempted here since no such deployment exists yet. */
    adminConsoleOrigin?: string;
    /** METRICS_TOKEN, optional — see app.ts's BuildAppOptions.metricsToken
     * doc comment. Unset (the default) leaves GET /metrics open, matching
     * /health's own posture: both are deliberately metadata-only/PHI-free
     * (see metrics.ts and docs/OBSERVABILITY.md). */
    metricsToken?: string;
    imaging: {
        localRoot?: string;
        encryptionKeyBase64?: string;
        s3?: { bucket: string; kmsKeyId: string; region: string; keyPrefix?: string };
        pacs?: { baseUrl: string; authHeader: string };
        /** CloudFront in front of the S3 imaging bucket — see
         * imaging/content-delivery.ts for the authorize-then-sign model and
         * why this is opt-in. Requires `s3` (there is nothing for a CDN to
         * front when objects live on local disk). */
        cloudFront?: { domain: string; keyPairId: string; privateKeyPem: string };
    };
    cache: {
        /** Wraps the IamStore in store/caching-iam-store.ts. On by default —
         * every authenticated request resolves the caller's user record and
         * effective policies at least once, so leaving this off means every
         * request round-trips to Postgres for both. Set CACHE_DISABLE=1 to
         * turn it off (e.g. to rule caching in/out while debugging a
         * permissions issue). */
        enabled: boolean;
        /** CACHE_TTL_MS — see cache/create-cache.ts's CacheFactoryOptions for
         * what this bounds. Validated at startup (see loadConfig) to be a
         * finite positive integer within CACHE_TTL_MS_MIN/MAX — an
         * unparseable or out-of-range value fails loudly rather than
         * silently degrading into `NaN`-driven behavior (every entry
         * either never expiring or expiring immediately, both of which
         * are authorization-safety-relevant, not just a performance
         * knob). */
        ttlMs: number;
        /** CACHE_NEGATIVE_TTL_MS — see
         * store/caching-iam-store.ts's findUserByExternalSubject doc
         * comment for what this bounds and why it's deliberately much
         * shorter than `ttlMs`. Validated the same way, and additionally
         * constrained to never exceed `ttlMs` (a "shorter" TTL that's
         * actually longer than the normal one would defeat its own
         * purpose). */
        negativeTtlMs: number;
        /** REDIS_URL — standard `redis://[:password@]host:port[/db]`. If
         * unset, the cache falls back to in-memory (per-process, lost on
         * restart) — see cache/create-cache.ts. */
        redisUrl?: string;
    };
    /** Bounds on the Postgres connection pool index.ts builds when
     * DATABASE_URL is set — irrelevant (and unused) with the in-memory
     * store. Defaults are conservative, not tuned for any specific
     * deployment size; a busier deployment should raise POOL_MAX. */
    dbPool: {
        /** POOL_MAX, default 10. Caps concurrent Postgres connections this
         * process holds — without a cap, a burst of slow/blocked queries
         * (e.g. lock contention on the `SELECT ... FOR UPDATE` in
         * postgres-case-store.ts) can each open a new connection until
         * Postgres itself refuses more. */
        max: number;
        /** POOL_CONNECTION_TIMEOUT_MS, default 10000. How long to wait for
         * a new connection to Postgres before failing that acquisition —
         * without this, an unreachable/overloaded Postgres leaves a
         * request hanging indefinitely instead of failing fast. */
        connectionTimeoutMillis: number;
        /** POOL_IDLE_TIMEOUT_MS, default 30000. How long an idle pooled
         * connection is kept open before `pg` closes it — bounds how long
         * this process holds a Postgres connection open doing nothing. */
        idleTimeoutMillis: number;
        /** POOL_STATEMENT_TIMEOUT_MS, default 30000. Passed to `pg` as
         * `statement_timeout` (enforced Postgres-side per statement) —
         * without it, one slow/blocked query holds its connection (and,
         * transitively, whatever request is awaiting it) open forever
         * rather than failing with a bounded, diagnosable error. */
        statementTimeoutMillis: number;
    };
    /** Global request rate limiting (app.ts, via @fastify/rate-limit) —
     * without it, a caller with a valid token (or the unauthenticated
     * POST /organizations bootstrap route) can call any endpoint,
     * including /authz/check and /organizations, at an unbounded rate.
     * Generous defaults: this exists to bound abuse/runaway-client load,
     * not to throttle normal traffic. */
    rateLimit: {
        /** RATE_LIMIT_MAX, default 300 requests per windowMs, per client IP. */
        max: number;
        /** RATE_LIMIT_WINDOW_MS, default 60000 (1 minute). */
        windowMs: number;
    };
    /** TRUST_PROXY, default false. Fastify's `request.ip` (what rate
     * limiting keys on) is the raw socket peer address unless this is set —
     * correct when this process is reachable directly, but wrong the moment
     * a reverse proxy/load balancer sits in front of it (the documented
     * deployment topology, per server/README.md): every request would then
     * report the proxy's own address, collapsing per-IP rate limiting into
     * one shared bucket for all traffic through that proxy. Setting this to
     * true makes Fastify trust `X-Forwarded-For` from the immediate peer —
     * only correct when that peer really is a trusted proxy terminating
     * client connections, never when this process is directly internet-
     * facing (a direct client could otherwise spoof the header to defeat
     * per-IP rate limiting entirely). Defaults false — the safe choice when
     * unset — rather than guessing at the deployment topology. */
    trustProxy: boolean;
    breakGlass: {
        /** BREAK_GLASS_GRANT_DURATION_MS, default 4 hours. How long a
         * self-service break-glass grant lasts once invoked (see
         * domain/types.ts's BreakGlassGrant and routes/break-glass.ts).
         * This default is a placeholder, not a derived requirement —
         * docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md §19 explicitly lists
         * "Break-glass conditions, time limits" as a decision needing
         * explicit clinical/product ownership. Confirm the real value with
         * that ownership before relying on this in production. */
        grantDurationMs: number;
    };
}

// CACHE_TTL_MS bounds: below 1s, caching stops meaningfully reducing store
// load (most authorization checks in a request burst wouldn't even land
// inside one window) while still paying the cache's own bookkeeping cost;
// above 1h, a revoked grant could remain servable from a stale cache entry
// for an hour after invalidation should it ever slip past this service's
// write-time invalidation (e.g. a bug, or a Redis-backed cache an
// operator restored from a stale snapshot) — this is an authorization
// cache, so that ceiling is a deliberate, conservative safety bound, not
// just a performance guideline.
const CACHE_TTL_MS_MIN = 1_000;
const CACHE_TTL_MS_MAX = 3_600_000;
const CACHE_TTL_MS_DEFAULT = 30_000;
const CACHE_NEGATIVE_TTL_MS_MIN = 100;
const CACHE_NEGATIVE_TTL_MS_DEFAULT = 5_000;

/**
 * Parses a required-shape env var as a finite integer within [min, max],
 * or throws ConfigError — used for every numeric cache setting below so a
 * malformed value (unparseable, negative, `NaN`/`Infinity` from a typo'd
 * or empty-but-set env var, or simply out of the range that makes sense)
 * fails startup loudly instead of silently becoming a cache that never
 * expires (`NaN` comparisons in TtlCache/RedisCache's TTL math are always
 * false, so a stale value would never be treated as expired) or expires
 * every entry immediately (a `0`/negative TTL). Both are the kind of
 * silent degradation this service can't afford for an authorization
 * cache — see server/README.md's "Caching" section.
 */
function parseBoundedIntEnv(name: string, raw: string | undefined, bounds: { default: number; min: number; max: number }): number {
    if (raw === undefined || raw.trim() === "") return bounds.default;
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
        throw new ConfigError(`${name} must be a whole number between ${bounds.min} and ${bounds.max} (got "${raw}").`);
    }
    return value;
}

/** Loopback hostnames treated as "local development," never a real
 * deployment target — same three forms app/src/shared-backend-auth.ts's
 * isAllowedRemoteUrl accepts as the one exception to its own HTTPS
 * requirement, kept consistent across both processes. */
function isLoopbackHost(hostname: string): boolean {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Refuses to start against a non-HTTPS URL for anything security-relevant,
 * unless it's an explicit loopback address (local development/testing).
 * Shared by OIDC_ISSUER (a plaintext issuer makes JWKS/discovery tamperable
 * in transit — a direct path to accepting forged tokens) and
 * ADMIN_CONSOLE_ORIGIN (a plaintext origin in a CORS allow-list means the
 * browser's same-origin protection for that origin can itself be defeated
 * in transit). Mirrors isAllowedRemoteUrl's exact policy on the client side
 * (app/src/shared-backend-auth.ts) for the same reason: HTTPS always
 * allowed, HTTP allowed only for a loopback host.
 */
function assertSecureUrl(envVarName: string, value: string, purpose: string): void {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new ConfigError(`${envVarName} ("${value}") is not a valid URL.`);
    }
    if (url.protocol === "https:") return;
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
    throw new ConfigError(
        `${envVarName} ("${value}") must be an HTTPS URL (${purpose}). ` +
            `An explicit http://localhost, http://127.0.0.1, or http://[::1] address is allowed for local development only.`
    );
}

/**
 * Refuses to start against a non-loopback Postgres that explicitly disables
 * SSL (`sslmode=disable`/`sslmode=allow` in the connection string) — this
 * pool carries every patient case, policy, and audit-relevant record this
 * service stores. An unset sslmode is left alone (many managed Postgres
 * providers and every local/loopback setup work correctly without the
 * connection string spelling it out — this only rejects an explicit,
 * unambiguous opt-out of transport security against a real network
 * destination).
 */
function assertSecureDatabaseUrl(envVarName: string, databaseUrl: string | undefined): void {
    if (!databaseUrl) return;
    let url: URL;
    try {
        url = new URL(databaseUrl);
    } catch {
        throw new ConfigError(`${envVarName} is not a valid connection string.`);
    }
    if (isLoopbackHost(url.hostname)) return;
    const sslmode = url.searchParams.get("sslmode");
    if (sslmode === "disable" || sslmode === "allow") {
        throw new ConfigError(
            `${envVarName} explicitly sets sslmode=${sslmode} against a non-loopback host ("${url.hostname}") — refusing to send ` +
                "patient-case and IAM data over an unencrypted connection to a real network destination. Remove sslmode " +
                "(most providers negotiate TLS by default) or set it to require/verify-full."
        );
    }
}

/**
 * Parses and validates OIDC_ADDITIONAL_ISSUERS (see AppConfig.oidc.
 * additionalIssuers's doc comment) — fails loudly on malformed JSON, a
 * non-array, a missing/empty issuer or audience, a non-HTTPS issuer (same
 * bar as the primary OIDC_ISSUER — an institution federating a second IdP
 * gets no weaker a transport-security guarantee for it), or an issuer that
 * duplicates the primary or another entry in this same list (the security
 * model has exactly one JWKS/audience per issuer string — the first entry
 * for a given issuer silently winning at request time, per auth/auth-
 * plugin.ts's createAuthPreHandler, would make a duplicate a config
 * authoring mistake worth catching at startup rather than a live surprise).
 */
function parseAdditionalIssuers(raw: string | undefined, primaryIssuer: string): AppConfig["oidc"]["additionalIssuers"] {
    if (raw === undefined || raw.trim() === "") return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ConfigError("OIDC_ADDITIONAL_ISSUERS is not valid JSON. Expected a JSON array of {issuer, audience, jwksUri?} objects.");
    }
    if (!Array.isArray(parsed)) {
        throw new ConfigError("OIDC_ADDITIONAL_ISSUERS must be a JSON array of {issuer, audience, jwksUri?} objects.");
    }
    const seenIssuers = new Set([primaryIssuer]);
    const result: AppConfig["oidc"]["additionalIssuers"] = [];
    for (const [index, entry] of parsed.entries()) {
        if (typeof entry !== "object" || entry === null) {
            throw new ConfigError(`OIDC_ADDITIONAL_ISSUERS[${index}] must be an object with "issuer" and "audience" fields.`);
        }
        const { issuer, audience, jwksUri } = entry as Record<string, unknown>;
        if (typeof issuer !== "string" || issuer.length === 0) {
            throw new ConfigError(`OIDC_ADDITIONAL_ISSUERS[${index}].issuer must be a non-empty string.`);
        }
        if (typeof audience !== "string" || audience.length === 0) {
            throw new ConfigError(`OIDC_ADDITIONAL_ISSUERS[${index}].audience must be a non-empty string.`);
        }
        if (jwksUri !== undefined && (typeof jwksUri !== "string" || jwksUri.length === 0)) {
            throw new ConfigError(`OIDC_ADDITIONAL_ISSUERS[${index}].jwksUri must be a non-empty string when present.`);
        }
        assertSecureUrl(`OIDC_ADDITIONAL_ISSUERS[${index}].issuer`, issuer, "a plaintext issuer makes JWKS/discovery tamperable in transit");
        if (seenIssuers.has(issuer)) {
            throw new ConfigError(
                `OIDC_ADDITIONAL_ISSUERS[${index}].issuer ("${issuer}") duplicates the primary OIDC_ISSUER or an earlier entry in this list — each issuer needs exactly one audience/JWKS configuration.`
            );
        }
        seenIssuers.add(issuer);
        result.push({ issuer, audience, jwksUri });
    }
    return result;
}

function buildCacheConfig(env: NodeJS.ProcessEnv): AppConfig["cache"] {
    const ttlMs = parseBoundedIntEnv("CACHE_TTL_MS", env.CACHE_TTL_MS, {
        default: CACHE_TTL_MS_DEFAULT,
        min: CACHE_TTL_MS_MIN,
        max: CACHE_TTL_MS_MAX,
    });
    const negativeTtlMs = parseBoundedIntEnv("CACHE_NEGATIVE_TTL_MS", env.CACHE_NEGATIVE_TTL_MS, {
        // Clamped to ttlMs, not a bare constant — if an operator sets
        // CACHE_TTL_MS below the usual 5s negative-cache default (allowed;
        // the floor is 1s), the *default* negative TTL must still satisfy
        // "at most ttlMs" without needing CACHE_NEGATIVE_TTL_MS set
        // explicitly just to avoid a startup error.
        default: Math.min(CACHE_NEGATIVE_TTL_MS_DEFAULT, ttlMs),
        min: CACHE_NEGATIVE_TTL_MS_MIN,
        max: ttlMs,
    });
    return {
        enabled: env.CACHE_DISABLE !== "1",
        ttlMs,
        negativeTtlMs,
        redisUrl: env.REDIS_URL,
    };
}

/**
 * Loads configuration from environment variables. Fails loudly at startup
 * (never falls back to an unauthenticated or partially-configured mode) if
 * OIDC_ISSUER or OIDC_AUDIENCE is missing — this service has no identity of
 * its own to fall back to, per oidc-verifier.ts's doc comment, and without
 * an audience it can't distinguish a token meant for this API from an ID
 * token or another client's access token from the same IdP (see
 * AppConfig.oidc.audience's doc comment). Every numeric cache setting is
 * validated the same way, for the same reason — see parseBoundedIntEnv's
 * doc comment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const issuer = env.OIDC_ISSUER;
    if (!issuer) {
        throw new ConfigError(
            "OIDC_ISSUER is required. This service delegates authentication entirely to an external OIDC provider " +
                "(Cognito, Keycloak, or any spec-compliant IdP) — see server/README.md for the environment variables " +
                "a deployment must set."
        );
    }
    const audience = env.OIDC_AUDIENCE;
    if (!audience) {
        throw new ConfigError(
            "OIDC_AUDIENCE is required. Without it, a validly-signed ID token (or an access token minted for a " +
                "different client of the same IdP) would be accepted as a bearer token for this API — see " +
                "server/README.md for the environment variables a deployment must set."
        );
    }
    assertSecureUrl("OIDC_ISSUER", issuer, "a plaintext issuer makes JWKS/discovery tamperable in transit");
    assertSecureDatabaseUrl("DATABASE_URL", env.DATABASE_URL);
    assertSecureDatabaseUrl("RUNTIME_DATABASE_URL", env.RUNTIME_DATABASE_URL);
    if (env.RUNTIME_DATABASE_URL && !env.DATABASE_URL) {
        throw new ConfigError(
            "RUNTIME_DATABASE_URL is set without DATABASE_URL. DATABASE_URL is where migrations run (the migration-" +
                "owner role) — RUNTIME_DATABASE_URL only redirects the application's own connection afterward, so it " +
                "never makes sense on its own."
        );
    }
    if (env.ADMIN_CONSOLE_ORIGIN) {
        assertSecureUrl(
            "ADMIN_CONSOLE_ORIGIN",
            env.ADMIN_CONSOLE_ORIGIN,
            "a plaintext origin in a CORS allow-list can itself be spoofed/tampered with in transit"
        );
    }
    const s3Values = [env.IMAGING_S3_BUCKET, env.IMAGING_S3_KMS_KEY_ID, env.IMAGING_S3_REGION];
    if (s3Values.some(Boolean) && !s3Values.every(Boolean)) {
        throw new ConfigError("IMAGING_S3_BUCKET, IMAGING_S3_KMS_KEY_ID, and IMAGING_S3_REGION must be configured together.");
    }
    if (env.IMAGING_PACS_BASE_URL) {
        assertSecureUrl("IMAGING_PACS_BASE_URL", env.IMAGING_PACS_BASE_URL, "DICOMweb traffic can contain PHI and must use TLS");
        if (!env.IMAGING_PACS_AUTH_HEADER) throw new ConfigError("IMAGING_PACS_AUTH_HEADER is required when IMAGING_PACS_BASE_URL is configured.");
    }
    if (env.IMAGING_ENCRYPTION_KEY) {
        const decoded = Buffer.from(env.IMAGING_ENCRYPTION_KEY, "base64");
        if (decoded.length !== 32) throw new ConfigError("IMAGING_ENCRYPTION_KEY must be base64 for exactly 32 bytes.");
    }
    const cloudFrontValues = [env.IMAGING_CLOUDFRONT_DOMAIN, env.IMAGING_CLOUDFRONT_KEY_PAIR_ID, env.IMAGING_CLOUDFRONT_PRIVATE_KEY];
    if (cloudFrontValues.some(Boolean)) {
        if (!cloudFrontValues.every(Boolean)) {
            throw new ConfigError(
                "IMAGING_CLOUDFRONT_DOMAIN, IMAGING_CLOUDFRONT_KEY_PAIR_ID, and IMAGING_CLOUDFRONT_PRIVATE_KEY must be configured together."
            );
        }
        // A CDN in front of nothing is a silent misconfiguration that would
        // otherwise degrade to origin streaming without anyone noticing the
        // CloudFront settings were inert.
        if (!env.IMAGING_S3_BUCKET) {
            throw new ConfigError("IMAGING_CLOUDFRONT_* requires S3 imaging storage (IMAGING_S3_BUCKET); there is no bucket for CloudFront to front.");
        }
        // base64-wrapped PEM is the supported shape: a raw multi-line PEM
        // does not survive most env-var transports intact.
        if (!Buffer.from(env.IMAGING_CLOUDFRONT_PRIVATE_KEY!, "base64").toString("utf8").includes("PRIVATE KEY")) {
            throw new ConfigError("IMAGING_CLOUDFRONT_PRIVATE_KEY must be a base64-encoded PEM private key.");
        }
    }

    return {
        port: parseBoundedIntEnv("PORT", env.PORT, { default: 4000, min: 1, max: 65_535 }),
        oidc: {
            issuer,
            audience,
            jwksUri: env.OIDC_JWKS_URI,
            additionalIssuers: parseAdditionalIssuers(env.OIDC_ADDITIONAL_ISSUERS, issuer),
        },
        databaseUrl: env.DATABASE_URL,
        runtimeDatabaseUrl: env.RUNTIME_DATABASE_URL,
        adminConsoleOrigin: env.ADMIN_CONSOLE_ORIGIN,
        metricsToken: env.METRICS_TOKEN,
        imaging: {
            localRoot: env.IMAGING_LOCAL_ROOT,
            encryptionKeyBase64: env.IMAGING_ENCRYPTION_KEY,
            s3: env.IMAGING_S3_BUCKET ? {
                bucket: env.IMAGING_S3_BUCKET,
                kmsKeyId: env.IMAGING_S3_KMS_KEY_ID!,
                region: env.IMAGING_S3_REGION!,
                keyPrefix: env.IMAGING_S3_KEY_PREFIX,
            } : undefined,
            pacs: env.IMAGING_PACS_BASE_URL ? { baseUrl: env.IMAGING_PACS_BASE_URL, authHeader: env.IMAGING_PACS_AUTH_HEADER! } : undefined,
            cloudFront: env.IMAGING_CLOUDFRONT_DOMAIN
                ? {
                      domain: env.IMAGING_CLOUDFRONT_DOMAIN,
                      keyPairId: env.IMAGING_CLOUDFRONT_KEY_PAIR_ID!,
                      privateKeyPem: Buffer.from(env.IMAGING_CLOUDFRONT_PRIVATE_KEY!, "base64").toString("utf8"),
                  }
                : undefined,
        },
        cache: buildCacheConfig(env),
        dbPool: {
            max: parseBoundedIntEnv("POOL_MAX", env.POOL_MAX, { default: 10, min: 1, max: 1_000 }),
            connectionTimeoutMillis: parseBoundedIntEnv("POOL_CONNECTION_TIMEOUT_MS", env.POOL_CONNECTION_TIMEOUT_MS, {
                default: 10_000,
                min: 1,
                max: 600_000,
            }),
            idleTimeoutMillis: parseBoundedIntEnv("POOL_IDLE_TIMEOUT_MS", env.POOL_IDLE_TIMEOUT_MS, { default: 30_000, min: 1, max: 600_000 }),
            statementTimeoutMillis: parseBoundedIntEnv("POOL_STATEMENT_TIMEOUT_MS", env.POOL_STATEMENT_TIMEOUT_MS, {
                default: 30_000,
                min: 1,
                max: 600_000,
            }),
        },
        rateLimit: {
            max: parseBoundedIntEnv("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, { default: 300, min: 1, max: 1_000_000 }),
            windowMs: parseBoundedIntEnv("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS, { default: 60_000, min: 1, max: 3_600_000 }),
        },
        trustProxy: env.TRUST_PROXY === "1",
        breakGlass: {
            grantDurationMs: parseBoundedIntEnv("BREAK_GLASS_GRANT_DURATION_MS", env.BREAK_GLASS_GRANT_DURATION_MS, {
                default: 14_400_000, // 4 hours — placeholder, see AppConfig.breakGlass.grantDurationMs's doc comment
                min: 300_000, // 5 minutes
                max: 86_400_000, // 24 hours
            }),
        },
    };
}
