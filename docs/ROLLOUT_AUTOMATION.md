# Canary rollout and rollback decisions

ModelForge's rollout decision tool turns recent canary and capacity JSON reports into a small, platform-neutral traffic action. It does not execute shell commands or call a deployment control plane. A Kubernetes, Nomad, VM, or managed-container adapter applies the emitted `traffic.toPercent` only after checking the process exit code and JSON action.

The decision fails closed. It emits `rollback` when required evidence is missing, malformed, stale, from too far in the future, associated with another origin, or reports a failed gate. It emits `promote` only when every required gate passes. Later stages can additionally require the post-shift observation report described in `docs/POST_SHIFT_OBSERVATION.md`.

```bash
npm --prefix server run build

RELEASE_CANDIDATE_ID=server-2026.08.30-abc123 \
RELEASE_EXPECTED_ORIGIN=https://candidate.internal.example \
RELEASE_CANARY_REPORT_FILE=artifacts/canary.json \
RELEASE_CAPACITY_REPORT_FILE=artifacts/capacity.json \
RELEASE_CURRENT_TRAFFIC_PERCENT=10 \
RELEASE_NEXT_TRAFFIC_PERCENT=25 \
RELEASE_ROLLBACK_TRAFFIC_PERCENT=0 \
npm --prefix server run ops:rollout
```

Exit code `0` means promote, `1` means rollback, and `2` means the rollout configuration itself is invalid. Missing or unreadable evidence produces rollback, not a configuration error.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `RELEASE_CANDIDATE_ID` | required | Non-secret release identifier copied into the decision artifact. |
| `RELEASE_EXPECTED_ORIGIN` | required | Exact candidate origin expected in both reports. HTTPS is required except for loopback. |
| `RELEASE_CANARY_REPORT_FILE` | required | JSON report emitted by `ops:canary`. |
| `RELEASE_CAPACITY_REPORT_FILE` | unset | JSON report emitted by `ops:capacity`; required unless capacity evidence is disabled. |
| `RELEASE_REQUIRE_CAPACITY` | `1` | Set to `0` only for a deliberately canary-only stage. |
| `RELEASE_OBSERVATION_REPORT_FILE` | unset | JSON report emitted by `ops:observe`. |
| `RELEASE_REQUIRE_OBSERVATION` | `0` | Set to `1` when the current traffic stage must be observed before advancing. |
| `RELEASE_CURRENT_TRAFFIC_PERCENT` | `0` | Candidate traffic before the decision. |
| `RELEASE_NEXT_TRAFFIC_PERCENT` | `10` | Candidate traffic after successful promotion; must increase. |
| `RELEASE_ROLLBACK_TRAFFIC_PERCENT` | `0` | Candidate traffic after failure; cannot exceed the current stage. |
| `RELEASE_MAX_EVIDENCE_AGE_MS` | `900000` | Oldest accepted report, bounded to 1 second–24 hours. |
| `RELEASE_MAX_FUTURE_SKEW_MS` | `60000` | Clock-skew tolerance, bounded to 0–5 minutes. |

## Adapter contract

Deployment-specific automation should capture stdout, inspect `action`, verify the expected `candidateId`, and atomically set candidate traffic to `traffic.toPercent`. A rollback result should also stop later promotion stages and preserve logs and evidence for incident review. Do not interpolate the JSON into a shell command; pass the numeric percentage through the deployment platform's typed API or validated CLI argument.

The report includes only the candidate identifier, normalized origin, traffic percentages, aggregate evidence acceptance, and fixed reason categories. It never copies raw gate reports, tokens, request bodies, response bodies, query strings, or exception details.

This is rollback **decisioning**, not a complete deployment controller. A production adapter, gradual traffic-shifting template, post-shift observation loop, rollback verification, and repeated operational drill remain required.
