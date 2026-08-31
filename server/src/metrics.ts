import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { CacheStats } from "./cache/cache.js";

/**
 * PHI-safe, metadata-only Prometheus metrics (docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md
 * §4 trust boundary 7: "Operations/SIEM: expose metadata-only observability
 * by default"). Every label used here is a bounded, closed-vocabulary value
 * (a Fastify route *pattern* like `/organizations/:organizationId/cases/:caseId`,
 * an HTTP method, a status code, an authorization effect, a cache name) —
 * never a patient id, case id, session id, organization id, or any other
 * caller- or tenant-identifying value. That is a deliberate, load-bearing
 * property of this module, not an oversight: an unbounded label (e.g. a raw
 * request URL) would both blow up Prometheus's cardinality and turn this
 * endpoint into a tenant/resource enumeration surface. Keep it that way when
 * adding new metrics here.
 *
 * This module owns its own Registry rather than using prom-client's global
 * default register, so building more than one app instance in the same
 * process (every test file in this package does exactly that) never hits
 * prom-client's "a metric with this name has already been registered"
 * error. index.ts's production process still only ever builds one.
 */
export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

/**
 * Buckets tuned around the roadmap's own §17 provisional latency
 * objectives (authz decision p95 <= 100ms; case read/write p95 <=
 * 300ms/500ms) rather than prom-client's generic defaults, so a p95/p99
 * `histogram_quantile` query actually lands inside a bucket boundary near
 * each target instead of only ever reporting "somewhere in a wide bucket."
 */
const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10];

export const httpRequestDuration = new Histogram({
    name: "modelforge_http_request_duration_seconds",
    help: "HTTP request duration in seconds, by method/route-pattern/status. Excludes /metrics and /health* themselves (see app.ts) so orchestrator/scraper polling never skews the distribution.",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: LATENCY_BUCKETS_SECONDS,
    registers: [metricsRegistry],
});

export const authzDecisionDuration = new Histogram({
    name: "modelforge_authz_decision_duration_seconds",
    help: "Duration of one requirePermission/isPermissionAllowed call (routes/guards.ts): resolving the caller's effective policies plus boundary and evaluating them. Maps to the roadmap's 'Authorization decision latency' objective.",
    labelNames: ["effect"] as const,
    buckets: LATENCY_BUCKETS_SECONDS,
    registers: [metricsRegistry],
});

export const auditWriteDuration = new Histogram({
    name: "modelforge_audit_write_duration_seconds",
    help: "Duration of PostgresAuditStore.record() — the transactional audit-outbox write every case/IAM mutation depends on.",
    buckets: LATENCY_BUCKETS_SECONDS,
    registers: [metricsRegistry],
});

export const auditWriteTotal = new Counter({
    name: "modelforge_audit_write_total",
    help: "Count of audit-log write attempts by outcome (success/failure). A sustained failure rate here means mutations are being rejected before commit (audit-store.ts writes audit in the same transaction as the mutation it describes) — see the roadmap's 'zero acknowledged mutation loss' objective.",
    labelNames: ["outcome"] as const,
    registers: [metricsRegistry],
});

export const computeSchedulingDecisionDuration = new Histogram({
    name: "modelforge_compute_scheduling_decision_duration_seconds",
    help: "Control-plane scheduling duration, excluding model startup and execution.",
    labelNames: ["result"] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [metricsRegistry],
});

export const computeSchedulingDecisions = new Counter({
    name: "modelforge_compute_scheduling_decisions_total",
    help: "PHI-free count of scheduler outcomes. Organization, node, request, and model ids are intentionally not labels.",
    labelNames: ["result"] as const,
    registers: [metricsRegistry],
});

const CACHE_STAT_FIELDS = [
    "hits",
    "misses",
    "size",
    "loads",
    "coalesced",
    "loadTimeMsTotal",
    "evictions",
    "expirations",
    "invalidations",
    "redisErrors",
] as const;

const authorizationCacheStat = new Gauge({
    name: "modelforge_authorization_cache_stat",
    help: "Cumulative CachingIamStore sub-cache counters (store/cache/cache.ts's CacheStats), snapshotted at scrape time — hits/misses/size/loads/coalesced/loadTimeMsTotal/evictions/expirations/invalidations/redisErrors, by cache name and stat. A Gauge (not a Counter) because the value is set from an already-cumulative counter tracked elsewhere, not incremented here; see updateCacheGauges. `size` is the only field here that isn't itself cumulative (it's a current point-in-time count), but shares this metric rather than getting its own for simplicity — a consumer graphing rate() on the wrong stat name would get a confusing but harmless flat/zero series, not a wrong answer.",
    labelNames: ["cache", "stat"] as const,
    registers: [metricsRegistry],
});

const authorizationCacheDegraded = new Gauge({
    name: "modelforge_authorization_cache_degraded",
    help: "1 if this sub-cache's Redis backend is currently considered degraded (store/cache/redis-cache.ts), 0 otherwise. A cache running degraded serves from a per-process fallback only — other server instances will not see its invalidations until Redis recovers, which is exactly the 'Redis failure can leave stale grants on other instances' risk the roadmap names; this metric is the fastest possible operator signal for it (the authorization-epoch check itself is what keeps that condition safe, not this metric).",
    labelNames: ["cache"] as const,
    registers: [metricsRegistry],
});

/**
 * Populates the two cache gauges above from a fresh CachingIamStore.stats()
 * snapshot — called once per /metrics scrape (see app.ts), not on a timer,
 * so this never does background work when nothing is scraping. Safe to call
 * with `undefined` (the in-memory-store / no-caching case): the gauges then
 * simply report nothing, matching "no cache" rather than a stale value.
 */
export function updateCacheGauges(stats: Record<string, CacheStats> | undefined): void {
    if (!stats) return;
    for (const [cacheName, cacheStats] of Object.entries(stats)) {
        for (const field of CACHE_STAT_FIELDS) {
            authorizationCacheStat.set({ cache: cacheName, stat: field }, cacheStats[field]);
        }
        authorizationCacheDegraded.set({ cache: cacheName }, cacheStats.degraded ? 1 : 0);
    }
}

/** Millisecond-precision monotonic timer helper — `process.hrtime.bigint()`
 * rather than `Date.now()`, since these durations feed p95/p99 histograms
 * where wall-clock adjustments (NTP step, DST — irrelevant on a server, but
 * still a real footgun) must never produce a negative or inflated sample. */
export function startTimer(): () => number {
    const start = process.hrtime.bigint();
    return () => Number(process.hrtime.bigint() - start) / 1e9;
}
