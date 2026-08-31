# Post-shift observation gate

After a deployment adapter shifts real traffic to a candidate, `ops:observe` performs a bounded read-only observation window before the next rollout stage. Each sample checks liveness, database-aware readiness, an optional-token authenticated `GET` or `HEAD` workload, and Prometheus exposition. The gate fails on availability or p95 regression and stops early when consecutive unhealthy samples reach the configured limit.

```bash
npm --prefix server run build
OBSERVATION_BASE_URL=https://candidate.internal.example \
OBSERVATION_WORKLOAD_PATH=/organizations/synthetic/cases?limit=1 \
OBSERVATION_WORKLOAD_TOKEN="$SYNTHETIC_OBSERVATION_TOKEN" \
OBSERVATION_METRICS_TOKEN="$METRICS_TOKEN" \
npm --prefix server run ops:observe > artifacts/observation.json
```

Exit code `0` means the observed stage passed, `1` means rollback is required, and `2` means configuration is invalid.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `OBSERVATION_BASE_URL` | required | Candidate origin; remote plaintext HTTP is rejected. |
| `OBSERVATION_WORKLOAD_PATH` | required | Same-origin read-only workload path. Query parameters are sent but omitted from the report. |
| `OBSERVATION_WORKLOAD_METHOD` | `GET` | `GET` or `HEAD`; mutating observation traffic is prohibited. |
| `OBSERVATION_SAMPLES` | `20` | Samples, bounded to 1–600. |
| `OBSERVATION_INTERVAL_MS` | `15000` | Delay between samples, bounded to 0–5 minutes. |
| `OBSERVATION_TIMEOUT_MS` | `5000` | Per-request timeout. |
| `OBSERVATION_CONSECUTIVE_FAILURE_LIMIT` | `2` | Consecutive unhealthy samples that stop the window early. |
| `OBSERVATION_MIN_SUCCESS_RATE` | `0.99` | Minimum fraction of fully healthy samples. |
| `OBSERVATION_READY_P95_LIMIT_MS` | `1000` | Readiness latency ceiling. |
| `OBSERVATION_WORKLOAD_P95_LIMIT_MS` | `500` | Authenticated workload latency ceiling. |
| `OBSERVATION_REQUIRE_METRICS` | enabled | Set to `0` only if the probe network intentionally cannot scrape metrics. |
| `OBSERVATION_WORKLOAD_TOKEN` | unset | Least-privilege synthetic read principal token. |
| `OBSERVATION_METRICS_TOKEN` | unset | Optional metrics bearer token. |

The report excludes tokens, response bodies, query strings, and exception messages. Use synthetic identifiers and never place PHI in the path or query even though the report strips the query.

For stage 25% → 50%, feed the resulting report into `ops:rollout` with `RELEASE_REQUIRE_OBSERVATION=1` and `RELEASE_OBSERVATION_REPORT_FILE=artifacts/observation.json`. Missing, stale, wrong-origin, or failed observation evidence then produces the same rollback decision as a failed pre-shift gate.

This observes one candidate origin and one representative read endpoint. Distributed traffic measurement, institution-ratified burn-rate thresholds, long soak tests, deployment-platform traffic actuation, and rollback verification remain separate work.
