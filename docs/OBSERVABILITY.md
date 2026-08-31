# Observability

Status: **P1 item 8** ("production observability and SLO dashboards") of
`docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md`'s backlog. This document describes
what is actually implemented, what still needs a real operator-provisioned
Prometheus/Grafana/alerting deployment, and how each metric maps to the
roadmap's §17 provisional production objectives.

## What this is

`server/src/metrics.ts` is a Prometheus client (`prom-client`) wrapping one
process-wide `Registry`, exposed at `GET /metrics` in standard Prometheus
exposition format. It is **deliberately metadata-only / PHI-free** — every
label is a bounded, closed-vocabulary value (an HTTP method, a Fastify
*route pattern* like `/organizations/:organizationId/cases/:caseId`, a
status code, an authorization effect, a cache name, an audit-write
outcome). No metric here ever carries a patient id, case id, session id,
user id, or organization id as a label or value — see trust boundary 7 in
`docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md` §4 ("Operations/SIEM: expose
metadata-only observability by default"). That is why `/metrics` is
unauthenticated by default, the same posture as `/health` — an optional
`METRICS_TOKEN` (see `server/.env.example`) adds a second layer for an
operator who wants one, but the real boundary a production deployment
should rely on is network-level (don't route the public internet to
`/metrics` at all).

### Metrics exposed

| Metric | Type | Labels | Maps to |
|---|---|---|---|
| `modelforge_http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | General request latency/error-rate visibility. Excludes `/metrics` and `/health*` (see below) |
| `modelforge_authz_decision_duration_seconds` | histogram | `effect` (`allow`/`deny`) | §17 "Authorization decision latency: p95 <= 100ms" |
| `modelforge_audit_write_duration_seconds` | histogram | — | Latency of `PostgresAuditStore.record()`, the transactional audit-outbox write |
| `modelforge_audit_write_total` | counter | `outcome` (`success`/`failure`) | §17 "Audit durability: zero acknowledged mutation loss" — a sustained `failure` rate means mutations are being rejected before commit |
| `modelforge_authorization_cache_stat` | gauge | `cache`, `stat` | Snapshot of `CachingIamStore.stats()` (hits/misses/size/loads/coalesced/loadTimeMsTotal/evictions/expirations/invalidations/redisErrors) at scrape time |
| `modelforge_authorization_cache_degraded` | gauge | `cache` | Fastest operator signal for "Redis failure can leave stale grants on other instances" (the highest-risk gap named in the roadmap's executive summary) — the authorization-epoch check (migration 004) is what actually keeps that condition *safe*; this metric is just visibility into it |
| `process_*`, `nodejs_*` | various | — | Node.js/process defaults from `prom-client`'s `collectDefaultMetrics()`: CPU, memory, event-loop lag, GC, file descriptors |

`/metrics` and `/health`/`/health/live`/`/health/ready` are excluded from
`http_request_duration_seconds` — orchestrator/scraper polling is frequent
and near-zero-latency by design, and including it would skew the
distribution real API traffic produces.

### Case/session read and write latency

There is no separate metric for this — §17's "Case read/write latency: p95
<= 300ms/500ms" objective is answered by filtering
`modelforge_http_request_duration_seconds` on `route=~"/organizations/:organizationId/(cases|sessions).*"`
and `method` (GET vs. POST/PATCH/DELETE), exactly as the bundled Grafana
dashboard's panels 5-6 do. A second, purpose-built metric would just be a
narrower view of the same underlying histogram.

### Liveness vs. readiness

`GET /health` (original, DB-aware) is unchanged for backward compatibility.
`GET /health/live` never depends on Postgres — it answers "can this process
serve HTTP at all," the correct signal for an orchestrator's
restart-on-failure decision (restarting a healthy process because its
*database* is briefly unreachable only adds a reconnect storm on top of an
existing outage). `GET /health/ready` is the DB-aware check under its own
explicit name, for a load-balancer/readiness probe that must stop routing
traffic to an instance that cannot currently serve a real request. This
was one of the gaps named explicitly in the roadmap's Phase 0 Operations
scope ("separate liveness/readiness contracts").

## Dashboard

`server/observability/grafana-dashboard.json` is an importable Grafana
dashboard (schema version 39, Grafana 10/11-compatible) wired directly to
the metrics above — 12 panels covering request rate/latency/errors by
route, authorization-decision latency against its 100ms objective,
case/session read and write latency against their 300ms/500ms objectives,
audit-write outcome rate and duration, authorization-cache hit ratio and
degraded state, and process CPU/memory/event-loop lag. Import it into a
Grafana instance pointed at a Prometheus scraping this service's
`/metrics`, and select (or create) a Prometheus datasource for the
`DS_PROMETHEUS` template variable.

## What this is not — real infra decisions this repo cannot make

- **No Prometheus, Grafana, or alerting deployment.** This ships the
  *instrumentation* and *dashboard definition*; standing up the actual
  Prometheus server (scrape config, retention, HA), a Grafana instance to
  import the dashboard into, and alert rules/routing (PagerDuty, Slack,
  whatever the institution uses) are operator/infrastructure decisions —
  the same category the roadmap's §19 already reserves for KMS/HSM
  product choice, PostgreSQL topology, and backup custody.
- **No SLO burn-rate alerting.** The dashboard shows the §17 objectives as
  threshold lines/colors on relevant panels; it does not define multi-window
  burn-rate alert rules. That requires an institution to first ratify the
  §17 objectives themselves (explicitly flagged in the roadmap as needing
  institutional ratification) before alerting on them is meaningful.
- **No distributed tracing.** This is metrics only — no OpenTelemetry spans
  connecting a request across services. Not attempted here: this is still a
  modular monolith (one Fastify process), where a single request's
  server-side path is already fully visible in one process's logs plus this
  metrics surface; tracing earns its cost once there's more than one
  service in the request path.
- **No SIEM/log-metrics correlation.** `docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md`
  §19 names "sanitized SIEM export" as a separate, later institutional
  integration (Phase 6) — out of scope here.
