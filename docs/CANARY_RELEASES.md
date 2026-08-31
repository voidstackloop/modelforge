# Canary promotion gate

ModelForge's first Phase 5/P2 operations primitive is a deployment-platform-neutral promotion gate. It does not deploy or shift traffic itself. A Kubernetes, Nomad, VM, or managed-container pipeline deploys the candidate, points this probe at its private canary URL, and promotes only when the process exits successfully.

The gate checks:

- `GET /health/live` on every attempt;
- database-aware `GET /health/ready`;
- `GET /metrics`, including Prometheus content validation;
- a configurable number of consecutive successful attempts at completion;
- readiness p95 against a configurable latency ceiling.

It prints one JSON report to stdout and exits `0` only when promotion is allowed, `1` when the canary fails its gate, and `2` for invalid configuration. The report never contains `CANARY_METRICS_TOKEN`.

```bash
npm --prefix server run build
CANARY_BASE_URL=https://candidate.internal.example \
CANARY_METRICS_TOKEN="$METRICS_TOKEN" \
npm --prefix server run ops:canary
```

Configuration:

| Variable | Default | Meaning |
|---|---:|---|
| `CANARY_BASE_URL` | required | Candidate origin. HTTPS is mandatory except explicit loopback development targets. URL credentials, queries, and fragments are refused. |
| `CANARY_ATTEMPTS` | `5` | Total probe attempts. |
| `CANARY_REQUIRED_CONSECUTIVE` | `3` | Successful attempts required at the end of the run. |
| `CANARY_INTERVAL_MS` | `2000` | Delay between attempts. |
| `CANARY_TIMEOUT_MS` | `5000` | Per-request timeout. |
| `CANARY_READY_P95_LIMIT_MS` | `1000` | Maximum readiness p95 for promotion. |
| `CANARY_REQUIRE_METRICS` | enabled | Set to `0` only when the deployment intentionally does not expose metrics to the probe network. |
| `CANARY_METRICS_TOKEN` | unset | Optional bearer token for `/metrics`; never logged. |

Pair this gate with the authenticated capacity gate in `docs/CAPACITY_TESTING.md` and the fail-closed rollout decision in `docs/ROLLOUT_AUTOMATION.md`.

This is not yet a complete canary release system. Deployment-specific traffic shifting and rollback actuation, post-shift observation, rollback verification, and platform templates remain follow-up work.
