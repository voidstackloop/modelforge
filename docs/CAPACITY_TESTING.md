# Authenticated capacity gate

ModelForge provides a bounded, deployment-neutral HTTP capacity gate for CI, staging, and private canary environments. It can exercise authenticated auth or case endpoints and fail a pipeline when success-rate, throughput, sample-count, or p95 latency targets are missed.

Build the server, then run the compiled gate:

```bash
npm --prefix server run build
LOAD_TARGET_URL=http://localhost:4000/health/ready npm --prefix server run ops:capacity
```

The command prints one JSON report to stdout. Exit code `0` means every threshold passed, `1` means the measured run failed its gate, and `2` means configuration was unsafe or invalid.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `LOAD_TARGET_URL` | required | Absolute endpoint URL. Query parameters are sent but excluded from the report. |
| `LOAD_METHOD` | `GET` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, or `DELETE`. |
| `LOAD_CONCURRENCY` | `10` | Parallel workers, bounded to 1–256. |
| `LOAD_DURATION_MS` | `30000` | Maximum run duration, bounded to 100 ms–30 minutes. |
| `LOAD_MAX_REQUESTS` | `10000` | Hard request cap, bounded to 1–1,000,000. |
| `LOAD_TIMEOUT_MS` | `5000` | Per-request timeout, bounded to 100 ms–5 minutes. |
| `LOAD_MIN_COMPLETED` | `1` | Minimum completed sample count. |
| `LOAD_MIN_SUCCESS_RATE` | `0.99` | Required fraction of HTTP 2xx responses. |
| `LOAD_MIN_RPS` | `1` | Required completed requests per second. |
| `LOAD_MAX_P95_MS` | `500` | Maximum nearest-rank p95 response-header latency. |
| `LOAD_BEARER_TOKEN` | unset | Synthetic principal bearer token. Never emitted in the report. |
| `LOAD_BODY_FILE` | unset | Request body file. Its content is never emitted in the report. |
| `LOAD_CONTENT_TYPE` | `application/json` | Body content type. |

## Safety controls

- Loopback is the only target allowed by default. A remote target requires HTTPS and `LOAD_ALLOW_REMOTE=1`.
- `POST`, `PUT`, `PATCH`, and `DELETE` additionally require `LOAD_ALLOW_WRITES=1`.
- URL credentials and fragments are rejected. Prefer a dedicated, least-privilege synthetic tenant and principal; never use real PHI.
- Both duration and request count are hard limits. Begin at low concurrency and coordinate larger runs with the service owner.
- The report contains only the target origin/path, aggregate status and error categories, timings, and thresholds. It excludes query strings, tokens, bodies, response bodies, and exception messages.

Example authenticated case-read gate:

```bash
LOAD_TARGET_URL=https://canary.internal.example/organizations/load-test/cases \
LOAD_ALLOW_REMOTE=1 \
LOAD_BEARER_TOKEN="$SYNTHETIC_LOAD_TOKEN" \
LOAD_CONCURRENCY=20 \
LOAD_DURATION_MS=60000 \
LOAD_MAX_REQUESTS=20000 \
LOAD_MIN_COMPLETED=1000 \
LOAD_MIN_SUCCESS_RATE=0.999 \
LOAD_MIN_RPS=50 \
LOAD_MAX_P95_MS=300 \
npm --prefix server run ops:capacity
```

Run separate gates for auth, representative case reads, and explicitly approved synthetic writes. This tool does not generate identities or cleanup data, coordinate distributed load, shift traffic, or replace soak, chaos, and failover exercises.
