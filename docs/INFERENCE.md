# llama.cpp and vLLM inference

ModelForge has two primary inference paths. The Electron application runs
GGUF models in-process through `node-llama-cpp`; it can also supervise vLLM
on Linux/WSL. The multi-user server never imports Electron native code: it
uses authenticated OpenAI-compatible `llama-server` or vLLM deployments.

## Trust and identity

Every model is represented by an immutable artifact record containing its
source revision, SHA-256 digest, runtime, format, license decision,
capabilities, and configuration hash. A provider model becomes invokable
only when it has a verified, licensed artifact and an active deployment.
Changing weights, templates, tool parsers, quantization, or runtime settings
creates a new artifact/configuration identity.

Deployment credentials are references, never secret values:

- `env:NAME` reads a server environment variable.
- `file:/run/secrets/name` reads a mounted secret file.

Remote deployments use `tlsMode=required` and HTTPS. Plain HTTP is reserved
for an isolated private network such as the internal production Compose
network. A deployment must expose an OpenAI-compatible base URL ending in
`/v1` and return the configured `servedModelName` from `/v1/models`.
Every endpoint hostname must also appear in
`MODELFORGE_INFERENCE_HOST_ALLOWLIST`; redirects and URLs containing embedded
credentials, query parameters, or fragments are rejected.

vLLM API-key authentication does not protect every route. In particular,
non-OpenAI endpoints such as `/invocations` can remain unauthenticated while
serving inference. The development overlay therefore publishes inference
ports on `127.0.0.1` only, and the production overlay publishes no inference
ports at all. Never expose a vLLM container directly to an untrusted network;
use the internal service network or an authenticating reverse proxy that
denies every route ModelForge does not require.

Locally managed desktop vLLM and llama-server processes bind to loopback and
receive a fresh 256-bit API key for each process start. The key is passed in
the child environment, never in command-line arguments or logs.

## Runtime selection

- GGUF selects llama.cpp.
- Safetensors selects vLLM when a compatible CUDA/ROCm GPU and verified
  deployment are available.
- Explicit user/operator selection is allowed only when compatible with the
  selected artifact.
- Failover may use another healthy deployment only when artifact digest,
  configuration hash, served model, template, and parser are identical.
- There is no automatic cross-runtime or cross-model fallback.

MLX and the standalone ROCm llama-server integration remain available under
advanced runtime controls but are not primary automatic-placement targets.

## Development containers

Copy the inference environment template, replace its development credentials,
and place models in the configured directories. `VLLM_MODEL` must be a
container path below `/models`, such as `/models/approved-snapshot`; repository
IDs are rejected so the runtime cannot silently download mutable or unapproved
weights. The mounted snapshot must already contain its tokenizer and model
configuration as well as its safetensors files. Set `VLLM_MAX_MODEL_LEN` to a
context size that fits the approved workload and GPU allocation; it is part of
the deployment configuration identity and defaults to `4096` in Compose.

Inference services are disabled unless their profile is selected:

```bash
cp .env.inference.example .env.inference
docker compose --env-file .env.inference -f compose.dev.yml -f compose.inference.dev.yml --profile inference-llamacpp up -d
docker compose --env-file .env.inference -f compose.dev.yml -f compose.inference.dev.yml --profile inference-vllm-nvidia up -d
docker compose --env-file .env.inference -f compose.dev.yml -f compose.inference.dev.yml --profile inference-vllm-rocm up -d
```

Register the resulting endpoint and immutable artifact through the
`ai-provider-models/:modelId/artifacts` and
`ai-model-artifacts/:artifactId/deployments` administrative APIs, then call
the deployment verification route before enabling tenant use.

## Production containers

Production image variables must be immutable tags or digests. Model volumes
are mounted read-only and API keys come from Docker secret files. Inference
services publish no host ports; only the API joins their internal network.

```bash
docker compose --env-file .env.production -f compose.prod.yml -f compose.inference.prod.yml --profile inference-llamacpp config
docker compose --env-file .env.production -f compose.prod.yml -f compose.inference.prod.yml --profile inference-vllm-nvidia config
```

Prefetch and verify approved model snapshots before starting production. Both
development and production vLLM containers reject model references outside
their read-only `/models` mount and receive no Hugging Face credential. Do not
grant production runtime containers unrestricted network egress. Multi-node
vLLM remains operator-managed and connects through the same authenticated
HTTPS deployment contract.

## Evaluation and operations

The clinical evaluation CLI now targets any authenticated OpenAI-compatible
deployment:

```bash
MODELFORGE_INFERENCE_BASE_URL=https://inference.example/v1 \
MODELFORGE_INFERENCE_API_KEY=... \
npm --prefix server run eval:clinical -- --model approved-model --version 2026-08
```

Fake adapters cover deterministic behavior only. A model/runtime combination
is not validated until the live clinical suite runs against its exact
artifact and configuration. Prompts, outputs, credentials, and PHI must not
appear in runtime logs or metrics.
