# Clinical AI evaluation harness

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
