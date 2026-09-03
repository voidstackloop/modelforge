# Clinical AI evaluation

Two complementary pieces, deliberately kept separate: an **offline** harness
(this file's original scope, below) that gates a candidate model/prompt against
a fixed synthetic suite before it serves any traffic, and an **online**
production quality monitor (`server/src/eval-harness/production-monitor.ts`)
that observes how an already-deployed model is actually behaving, from data
the gateway itself already records. Neither implements live shadow traffic,
canary routing, or automatic promotion/rollback — see each section's own
"not implemented" note for why.

## Offline harness (promotion gate)

The clinical evaluation harness is an offline promotion gate for candidate
models. It uses versioned, explicitly synthetic fixtures only; it does not read
tenant schemas, patient cases, imaging objects, audit rows, or production
prompts.

Run it against an authenticated llama.cpp or vLLM OpenAI-compatible endpoint:

```bash
npm --prefix server run eval:clinical -- \
  --base-url http://127.0.0.1:8080/v1 \
  --api-key "$MODELFORGE_INFERENCE_API_KEY" \
  --model llama3.1 \
  --version 3.1 \
  --suite src/eval-harness/fixtures/clinical-synthetic-v1.json \
  --output clinical-eval-report.json
```

Add `--baseline previous-report.json` to reject a candidate whose pass rate
regresses by more than two percentage points or whose unsafe-output rate is
worse than the baseline. Exit code `0` means every configured absolute and
regression gate passed; `2` means the model ran but failed promotion; `1` means
the harness itself failed.

The report contains aggregate metrics, per-case pass/failure reasons, latency,
and output hashes. It deliberately does not retain raw model responses. Gates
cover overall pass rate, structured-format compliance, abstention accuracy,
evidence recall, unsafe-output rate, optional p95 latency, and baseline
regression. This is engineering evidence, not clinical validation or regulatory
certification. Institutions must replace/extend the synthetic suite with an
approved validation protocol before using any model in a real clinical role.

The harness does not implement live shadow traffic, canary routing, or automatic
promotion. A human or CI system may consume the exit code/report, but changing a
model's catalog validation state remains an explicit administrative action.

## Online production quality monitor

`GET /organizations/:organizationId/ai-provider-models/:modelId/quality-monitor`
(optional `?since=<ISO timestamp>`) reports aggregate metrics for one provider
model computed from real production `AiOutput` rows already recorded by the
gateway — no golden answers, no synthetic cases: output volume, abstention
rate (of all outputs), and reviewed/acceptance/rejection/correction/escalation
rates (of *reviewed* outputs only, so a review backlog can never masquerade as
a quality change — see `production-monitor.ts`'s own doc comment). Gated by
the same `aiGateway:viewAuditTrail` permission as every other model-level
catalog read; only aggregate rates cross this route, never patient-identifying
data.

`GET .../quality-drift?splitAt=<ISO>&baselineSince=<ISO?>` compares two
disjoint time windows for the same model (`baselineSince` to `splitAt`, and
`splitAt` onward) and flags a real behavioral shift — abstention rate up,
acceptance rate down, rejection/escalation rate up — beyond configurable
thresholds (`DEFAULT_DRIFT_THRESHOLDS` in `production-monitor.ts`). Reports
`sufficientData: false` (never a false alarm or false reassurance) when either
window has fewer than `minimumOutputCount` (default 20) outputs.

**Not implemented**: this only observes and reports — it never changes what
traffic a model receives. No shadow/canary routing, no automatic rollback, no
alerting integration (Slack/PagerDuty/email) — a caller (human, cron, or an
external monitoring system) is expected to poll this route and act on what it
returns. No statistical significance testing beyond the raw count floor above
(a real deployment wanting p-values/confidence intervals on the rate deltas
would need to add that on top of this). See
[docs/CLINICAL_AI_GATEWAY.md](CLINICAL_AI_GATEWAY.md)'s "Remaining work" for
the still-open shadow/canary/rollback piece this deliberately does not cover.
