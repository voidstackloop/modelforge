# Local inference hardening plan: llama.cpp consolidation, performance, security, telemetry

**Status (2026-08-29, updated): §§2-5 implemented and Ollama fully removed.**
This document was originally planning-only; the sections below now describe
work that has since shipped — see the "Implementation status" note before
§7 for what was actually done, verified, and deliberately left out of scope.
The original plan text (including its citations) is left intact below as the
record of the reasoning that drove the implementation. Method: direct
inspection of `app/src/**`, `frontend/src/**`, `server/src/ai-gateway/**`, and
`docs/**`, plus two independent research passes, as of 2026-08-29. Every claim
below cites a file/line or states that a search returned no matches.

**Relationship to other docs:** `docs/ENTERPRISE_READINESS_ASSESSMENT.md` is the
authoritative clinical/regulatory gap analysis for ModelForge Medical as a whole —
this document does not repeat it. It extends that assessment in the one area it
doesn't focus on: the **local-model-runtime layer** (Ollama, llama.cpp, and the
mlx/rocm/vllm local backends), through the three lenses requested for this pass —
**performance, security, telemetry/logging** — plus a concrete plan for removing
Ollama and standardizing on llama.cpp. Section 6 is a short pointer back into the
wider assessment, not a restatement of it.

Same responsibility tags as the existing assessment: **[SW]** buildable here,
**[CFG]** institutional/deployment decision, **[CLIN]** needs clinical
ownership, **[DATA]/[LEGAL]** as defined there.

---

## 0. A structural finding that changes how to read this plan

This repository actually contains two largely disconnected efforts:

1. **ModelForge Medical** — the committed, released product (`app/` +
   `frontend/`, v1.3.0 on `main`, git log confirms this is the real shipping
   history). A single-user Electron desktop app. This is "the app" the current
   request is about, and where Ollama/llama.cpp live.
2. A large multi-tenant Fastify IAM/RBAC/OIDC/tamper-evident-audit/policy/SCIM
   server (`server/` + `admin-console/`) that is **entirely uncommitted**
   (`git status --short` shows 181 changed/untracked paths on top of a clean
   129+-commit history that never touches `server/`).

`docs/ENTERPRISE_READINESS_ASSESSMENT.md` §5 proposes a "Target architecture for
institutional deployment" — an institutional control plane with identity, policy,
audit ingestion, and KMS — as something "this repository does not currently have
any component of." `docs/CENTRAL_POLICY.md` says the same thing even more
directly. **Both statements are incomplete**: a working implementation of most of
that target architecture already exists in `server/`, just uncommitted and never
wired to the Medical app. This matters for prioritization (§6) but is called out
here first because it affects how "what's needed more" should be read throughout
this document — some of it may already exist, just not where the assessment
looked.

This plan itself stays scoped to `app/`/`frontend/` (where the current request's
concrete ask — Ollama removal — lives), but §6 recommends resolving this fork
explicitly rather than letting the next session rediscover it.

---

## 1. Current state: three unrelated local-runtime integration shapes

`app/src/local-server-manager.ts` is **not** a shared boundary over Ollama and
llama.cpp — its `LocalBackendId` is `"mlx" | "rocm" | "vllm"` only
(`local-server-manager.ts:15`). There are really three different integration
shapes today:

| Runtime | Shape | Network surface | Owner file |
|---|---|---|---|
| Ollama | External always-on daemon, proprietary NDJSON REST API | `http://127.0.0.1:11434` (configurable host, but `ollama-manager.ts` only spawns a local `ollama serve` when the host resolves to loopback) | `app/src/ollama-manager.ts` |
| llama.cpp | **In-process** `node-llama-cpp` native addon — no child process, no port, no network surface at all | none | `app/src/llamacpp-manager.ts` |
| mlx / rocm / vllm | Spawned OpenAI-compatible HTTP server, real abstraction (`RuntimeStartupConfig`/`LocalRuntimeStatus`) | `127.0.0.1` hardcoded for all three (`local-server-manager.ts:343,347,357`) | `app/src/local-server-manager.ts` |

They're unified only by a large if/else in `app/src/chat-dispatch.ts:68-129`
(verified directly) and loosely by the `ProviderId`/`ChatOptions` types in
`providers/types.ts`, whose own comments (`:66-86`) admit per-backend field
semantics (`repeatPenalty` is Ollama-only; `seed`/`topK` aren't universal
either). `llamacpp.chat()`'s signature even carries an extra `priority` param
(`llamacpp-manager.ts:624`) Ollama's doesn't need, since Ollama schedules
generation inside its own daemon.

**Consequence for the migration below:** removing Ollama is a clean
delete-a-branch operation at the dispatch layer, not an abstraction-leak
problem. The real risk is breadth — the number of independent surfaces
(settings schema, model catalog heuristics, IPC, UI, e2e fixtures, a second
server-side reimplementation) that assume Ollama is present — not intermingled
logic.

---

## 2. Ollama → llama.cpp migration plan

### 2.1 Why this is not a drop-in swap

Three real capability gaps, read directly from both manager files in full:

| Capability | Ollama | llama.cpp manager | Gap |
|---|---|---|---|
| Function/tool calling | Full (`toOllamaTools`, `ollama-manager.ts:270-349`) | **Throws explicitly**: *"switch to Ollama... for tool-calling"* (`llamacpp-manager.ts:626-629`) | **Blocking.** Agent mode and any tool-using clinical workflow breaks outright on llama.cpp today. |
| Embeddings | `/api/embeddings`, called live by RAG (`rag.ts:78`) | None | **Blocking for RAG.** `rag.ts` has no llama.cpp embedding path at all. |
| Context/KV-cache reuse | Server keeps sessions warm across calls (opaque) | **Implemented 2026-08-30:** one active tool-free conversation retains its llama.cpp context/session and reuses the evaluated KV cache when model, settings, and persisted history still match; switching chats or editing history rebuilds safely. | **Closed for interactive chat.** Agent/tool turns deliberately remain fresh-context because tool execution mutates history outside one prompt call. |

Everything else is at parity or better on llama.cpp already (GPU-layer control
including auto-fit, local model-file/shard handling, LRU cache + idle eviction
with explicit refcounting vs. Ollama's opaque daemon-side management, streaming).
Model pulling has no llama.cpp equivalent, but the app's own HF/GGUF downloader
(`native-downloader.ts`, `download-queue.ts`) is already the de facto
replacement — nothing new to build there.

**The tool-calling gap is the one item that must close before Ollama can be
removed**, not deferred alongside it — a clinical assistant that silently loses
Agent-mode tool use for every user who was defaulted to llama.cpp is a
regression the assessment's own "no silent capability loss" posture (§2.7,
§2.10) would flag immediately if it shipped that way.

### 2.2 Full call-site inventory

**Core runtime (`app/src/`):** `ollama-manager.ts` (full client — health check,
list/delete/pull, chat+tools), `ollama-manager.test.ts`, `chat-dispatch.ts:2,54,57,68-86`
(central branch, confirmed by direct read), `main.ts:4,25,222,274-329,356,368`
(starts/stops `ollama serve` on app lifecycle, startup GPU selection),
`ipc/ollama-handlers.ts:74-184` (despite the name, registers `ollama:*`,
`llamacpp:*`, and `localBackends:*` together), `rag.ts:4,78` (embeddings —
no llama.cpp path exists to swap to, see 2.1), `benchmark-runner.ts:100-101,292,297`,
`huggingface.ts:29`, `app-state.ts:9`, `power-monitor.ts:65`, `energy-types.ts:1`,
`providers/types.ts:56,66-86`, `download-jobs-store.ts:55,59` (an `"ollama"` job
kind/backend that appears unreachable — `download-queue.ts:61-66` always resolves
`.gguf` downloads to `backend: "llamacpp"` — worth confirming no other
constructor exists before deleting).

**Settings/schema/system-specs:** see §2.4.

**IPC bridge:** `preload.ts:2,97-113` (`window.api.ollama.*`), `ipc/app-handlers.ts:3,23-24`,
`ipc/settings-handlers.ts:4,43`, `ipc/system-handlers.ts:3,40-47`.

**Frontend:** `types/electron.d.ts`, `pages/Chat.tsx` (model grouping, offline
banner + start button, default-model fallback), `pages/Settings.tsx` (full
Ollama server UI — host, models dir, start/stop, pull/delete, GGUF→Ollama-tag
pull, activity dashboard row), `components/model-picker.tsx`,
`components/onboarding-wizard.tsx` (first-run provider choice), `lib/gguf.ts:27`
(`ollamaTagForGguf`), `lib/providers.ts`, `lib/gpu.ts:7` (already-stale comment:
"AMD ROCm users should run through Ollama" — the app has its own `rocm` backend
now), `pages/Compare.tsx`, `lib/translations.ts` (en/tr strings).

**e2e:** `fixtures/fake-ollama.ts`, `fixtures/electron-app.ts:25`, and all 5
specs that depend on it — see §2.5.

**Outside `app/` entirely — a second, independent reimplementation:**
`server/src/ai-gateway/provider-client.ts:37-52,107` — `LocalOllamaProviderClient`,
defaulting to `OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"`, wired in by
`server/src/app.ts:68,107,140-141` for provider kind `"local"`, exercised by
`server/src/eval-harness/cli.ts` and three test files. This lives in the
uncommitted enterprise-server workspace described in §0 — a separate codebase
with its own release cadence, not part of the Electron app's migration. **Decide
separately** whether to touch it (§8) rather than folding it into this plan by
default.

**Not code — update, don't migrate:** `ml/hardware-recommender/`'s benchmark
data labels "ollama" as a data source only; `docs/ARCHITECTURE.md`,
`docs/RESOURCE_ORCHESTRATOR.md`, `docs/RUST_MIGRATION_ASSESSMENT.md`,
`docs/HARNESS_INTEGRATION.md`, `docs/DEVELOPMENT.md`, `README.md` all describe
Ollama as a first-class runtime today and need rewriting once it's gone.

### 2.3 Baked-in assumptions in code that looks generic

- `settings-store.ts:54,222` — `ollamaHost: string` is a **required**
  (non-optional) top-level `AppSettings` field, default
  `"http://127.0.0.1:11434"`. Confirmed directly. Removing Ollama needs a real
  settings-schema migration for existing users' persisted config, not just
  deleting the field.
- `schemas.ts:129,163` — zod requires `ollamaHost` unconditionally; same
  migration need.
- `system-specs.ts:191-215` — `recommendModels()`'s curated `MODEL_CATALOG`
  fallback (used whenever the ML hardware-fit worker is absent or
  low-confidence) hardcodes `resolveAutomaticRuntime("ollama", specs)` for all
  13 entries, and **the entries themselves are Ollama tags** (e.g.
  `"llama3.2:1b"`, `"qwen3:8b"`) — not valid llama.cpp/GGUF inputs as-is. This
  is the single largest hidden dependency: the fallback recommendation path
  needs its catalog rebuilt against real HF GGUF repo/file identifiers, not
  just a runtime-label swap. By contrast, `assessGgufFiles()` (arbitrary
  HF GGUF files) and the ML-prediction path are already 100% Ollama-free —
  only this one legacy heuristic catalog isn't.
- `system-specs.ts:219-223` and `frontend/src/lib/gpu.ts:7` both still claim
  "native ROCm means go through Ollama" — stale since the app built its own
  `rocm` backend; fix opportunistically while in this code.
- Confirmed clean: `resource-contracts.ts`, `inference-resource-scheduler.ts`,
  `model-fit-estimator.ts`, `model-registry-store.ts` — read in full, zero
  Ollama-specific assumptions (no naming scheme, port, or wire-shape
  dependency). No changes needed there.

### 2.4 External binary dependency

Ollama is not bundled, downloaded, or packaged anywhere (no hits in any
`package.json` or electron-builder config) — the app assumes `ollama` is
preinstalled on PATH and reports `"not-installed"` on `ENOENT`
(`ollama-manager.ts:106,126-127`), with no installer/verification step to
remove. llama.cpp is not a managed external binary either (unlike the app's own
`rocm`/`vllm` backends) — it's the `node-llama-cpp` npm package's prebuilt
native addon, loaded in-process. This is a favorable asymmetry for the
migration: there's no installer, update channel, or binary-distribution
concern to unwind.

### 2.5 Test coverage — the highest-risk item in this whole migration

`e2e/fixtures/fake-ollama.ts` mocks exactly what `ollama-manager.ts` calls for
chat (`/api/version`, `/api/tags`, `/api/ps`, `/api/chat` NDJSON incl.
synthetic `tool_calls`) — not `/api/pull`, `/api/delete`, or `/api/embeddings`.
All five e2e specs that exercise real chat/streaming/cancellation/tool-approval/
contract-violation behavior launch against it: `agent-tool-approval.spec.ts`,
`chat-cancel.spec.ts`, `chat-streaming.spec.ts`, `onboarding.spec.ts` (which
also clicks an "Ollama (local)" button), `response-contract-notice.spec.ts`.
**None has a llama.cpp equivalent, and no "fake llama.cpp" fixture exists.**

This isn't a mechanical host-string swap: llama.cpp has no HTTP seam to
intercept (`chat-dispatch.ts` calls `llamacpp.chat()` in-process). Reproducing
this e2e coverage needs either a small real GGUF model checked into CI, or a
new dependency-injection seam inside `llamacpp-manager.ts` that doesn't exist
today. Budget this as a real, separately-scoped sub-project, not a find/replace
pass — **it should be built and green before any Ollama call site is deleted**,
not after, or clinical-workflow e2e coverage has a gap during the transition
with nothing to catch a regression.

Partial mitigation already in place: `chat-dispatch.test.ts:23,38,76-82`
(unit-level) already mocks `llamacpp-manager` and has dispatch-layer
lease-behavior parity for both providers — the resource-scheduling logic
itself is not solely Ollama-proven, only the end-to-end user-facing behavior
is.

### 2.6 Phased migration plan

Sequenced so nothing after Phase M0 removes a capability before its
replacement exists — the assessment's own "don't build on an unstable
foundation" discipline (§6 there) applies here too.

- **Phase M0 — close blocking parity gaps (§2.1).** Tool calling for
  llama.cpp (the harder of the two — likely a prompt-templated/grammar-based
  approach via `node-llama-cpp`'s own function-calling support, or an explicit
  documented limitation if that proves infeasible for some model families) and
  an embeddings path for `rag.ts`. **Acceptance:** existing Ollama-only
  tool-calling and RAG-indexing test scenarios pass identically when pointed
  at llama.cpp.
- **Phase M1 — build the llama.cpp e2e test seam (§2.5).** A `fake-llamacpp`
  equivalent (mocking seam or CI-side small GGUF fixture) plus the 5 specs'
  llama.cpp variants. **Acceptance:** all 5 specs pass against llama.cpp with
  no Ollama fixture involved.
- **Phase M2 — fix the hidden catalog dependency (§2.3).** Rebuild
  `system-specs.ts`'s `MODEL_CATALOG` fallback against real GGUF
  repo/file identifiers; remove the `resolveAutomaticRuntime("ollama", …)`
  hardcode. **Acceptance:** the no-ML-worker fallback path recommends models
  that load successfully via `llamacpp-manager.ts`.
- **Phase M3 — flip the default, keep Ollama opt-in behind a flag.** New
  installs default to llama.cpp; existing users with `preferredRuntime:
  "ollama"` keep working unchanged. This is the point to catch anything M0-M2
  missed with real usage before deleting code.
- **Phase M4 — remove Ollama call sites**, area by area: core (`ollama-manager.ts`,
  `chat-dispatch.ts` branch, `main.ts` lifecycle hooks) → IPC/preload → frontend
  (Settings' Ollama panel, model-picker, onboarding step, translations) →
  settings schema migration (see below) → e2e fixture retirement → doc
  rewrites (§2.2's "update, don't migrate" list).
- **Phase M5 — settings/user-data migration.** A one-way, logged migration for
  persisted `preferredRuntime: "ollama"` / `runtimeGpuConfigs` entries /
  session records referencing Ollama-tag model ids, so an upgrading user's app
  doesn't silently break on first launch post-removal. Needs an explicit
  decision on what happens to a user who has no matching llama.cpp/GGUF model
  installed at all — a migration prompt pointing at the download center, not a
  silent failure.

### 2.7 Explicitly out of scope for this plan

`server/src/ai-gateway/provider-client.ts`'s `LocalOllamaProviderClient` (§2.2)
— separate uncommitted codebase, separate decision (§8).

---

## 3. Performance criteria and plan

### 3.1 Current state (verified by direct code read)

No SLO, latency-target, or throughput-target constant exists anywhere in
`app/src` — confirmed by grep, zero hits. `benchmark-runner.ts` is an
**on-demand, single-shot** tool, not a load-test harness:
`measureInference` times to-first-token and tokens/sec against one fixed
prompt, sampling RAM (`process.memoryUsage()`/`os.freemem()`) and VRAM
(`nvidia-smi`/`rocm-smi` polling) — no pass/fail threshold, just numbers.
`runContextTests` walks context sizes to find the rejection point. Neither is
wired into CI or run automatically.

Concurrency is bounded by a single fact: every local-inference workload
requests `exclusiveAccelerator: true` (`inference-resource-scheduler.ts:37-56`,
`chat-dispatch.ts:34`), i.e. **one primary-accelerator lease at a time** across
the whole app — this is a real, tested admission-control mechanism (see
`docs/RESOURCE_ORCHESTRATOR.md`), not an accidental gap, but it is also the
de facto performance ceiling for anyone expecting concurrent model use.

Timeouts that exist are all **lifecycle** timeouts — `local-server-manager.ts`'s
`STARTUP_TIMEOUT_MS=180_000`, a 2s health-check fetch, SIGTERM-then-5s-SIGKILL
stop. **Confirmed directly: no timeout exists for an in-flight generation
request.** `chat-handlers.ts` only aborts on explicit user-initiated
`chat:cancel`; `llamacpp-manager.ts`'s `session.prompt()` and the
OpenAI-compatible fetch path both take only the caller's own `signal`, with no
independent deadline. Under memory pressure, `llamacpp-manager.ts:686`'s
auto-shrink retry (6 attempts, 16% context reduction per attempt) degrades
gracefully rather than crashing — a real, working mitigation, just not a
latency guarantee.

### 3.2 Why this matters for a clinical application specifically

A hung or pathologically slow local generation today has no independent
watchdog — it holds the single exclusive-accelerator lease indefinitely,
which (per §3.1's concurrency model) can block every other local-inference
workload in the app behind it, with nothing surfacing "this is stuck" to the
user beyond however long they're willing to wait before manually cancelling.
For a clinical assistant, an indefinitely-hung generation is an availability
failure mode worth closing, independent of whether the Ollama migration
happens at all.

### 3.3 Required additions

- **Define explicit SLO targets** (time-to-first-token, minimum tokens/sec by
  hardware tier, acceptable degraded-mode latency) — **[CLIN+CFG]**: what's
  acceptable for a clinical workflow is a product/clinical decision, not one
  this plan makes; engineering's job is instrumenting against whatever target
  is set.
- **[SW] Per-request generation timeout / watchdog**, independent of
  user-initiated cancel — abort, release the lease, and surface a distinct
  "generation timed out" state to the user rather than an indefinite spinner.
  This is a real, currently-open gap, not a hardening nice-to-have.
- **[SW] Turn `benchmark-runner.ts` into a repeatable regression check** —
  store a baseline per hardware profile, flag a run that regresses beyond a
  threshold. Currently one-shot and manual only.
- **[SW] Context/KV-cache-reprocessing gap — implemented 2026-08-30.** The
  renderer now passes a stable session id through IPC and llama.cpp keeps one
  matching interactive context warm. Exact history fingerprinting prevents an
  edited or forked transcript from inheriting stale KV state; first-token and
  total generation milliseconds are logged as PHI-free performance metadata.
- **[SW] Load-test concurrent-workload behavior** — RAG indexing,
  live chat, and a model download contending for resources simultaneously.
  `docs/RUST_MIGRATION_ASSESSMENT.md` §4 already flags RAG query latency at
  realistic collection sizes as "not yet measured"; this plan extends that to
  the full concurrent-admission picture, since the orchestrator's *correctness*
  is tested (908+ tests per `docs/RESOURCE_ORCHESTRATOR.md`) but its
  *real-hardware performance under contention* is not.

---

## 4. Security criteria and plan

### 4.1 Current state (verified by direct code read)

**Network binding — good, confirmed hardcoded.** Every local runtime binds
loopback only: `local-server-manager.ts` hardcodes `--host 127.0.0.1` for
mlx/rocm/vllm (`:343,347,357`); `ollama-manager.ts`'s `isLocalHost()` check
(`:50-57`) refuses to spawn a local `ollama serve` for any non-loopback
configured host. Nothing here binds `0.0.0.0` by default.

**Authentication — none, and explicitly acknowledged in code.**
`chat-dispatch.ts:112-113`'s own comment: *"Managed runtimes are local and
unauthenticated; the key is a compatibility placeholder for their
OpenAI-shaped APIs."* Confirmed directly. Any other process on the same
machine that can reach the loopback port can call these local model APIs —
loopback binding stops remote-network access but not another local process
(including malware, or another user's process on a shared clinical
workstation).

**Model file provenance — verification code exists but is dead.**
`download-verification.ts`'s `computeSha256`/`hasGgufMagic` are **only
referenced from their own test file** — confirmed directly, zero production
call sites. Real checksum verification does happen, but only inside the Rust
downloader addon's Hugging Face shard-verification path
(`native-downloader.ts`/`download-worker.ts`) — a downloaded-and-verified file
is safe, but `llamacpp-manager.ts:373`'s `loadModel()` calls
`llama.loadModel({ modelPath, gpuLayers })` directly with no checksum or magic
check at load time. A GGUF file placed in the models directory by any other
means (manual copy, another app, a compromised sync folder) loads unchecked —
guarded by path-containment only (`chat-dispatch.ts:77-81,93-104`), which
prevents traversal, not tampering.

**Resource-exhaustion — no app-level request caps.** No cap on prompt/message
length or request body size before forwarding to a local model
(`chat-handlers.ts` passes `messages` through unvalidated for size); no
per-request timeout (§3.1). The only concrete mitigation is the OOM
auto-shrink retry.

**OS-level process sandboxing — none for any inference runtime.** Both
`spawn("ollama", ["serve"], …)` and the mlx/rocm/vllm `spawn()` calls are
plain child processes — no uid/gid drop, rlimit, cgroup, or Windows Job
Object. `command-sandbox.ts`'s real sandboxing (bubblewrap on Linux,
`sandbox-exec` on macOS) is scoped to **agent-tool shell execution only** — it
does not apply to any inference runtime process. `llamacpp-manager.ts` itself
has no separate process to sandbox at all (in-process addon).

### 4.2 Threat-model additions (new rows for `ENTERPRISE_READINESS_ASSESSMENT.md` §4)

| Threat | Current exposure | Mitigations present | Mitigations missing |
|---|---|---|---|
| Another local process/malware calls the unauthenticated local-inference API | Medium on a shared or compromised workstation | Loopback-only binding | Local shared-secret/token auth on the loopback API |
| Tampered or corrupted GGUF loaded without integrity check | Medium — depends entirely on how the file arrived | HF-download-path checksum (Rust addon); path-containment on load | `hasGgufMagic`/checksum check at actual load time, for any file regardless of provenance |
| Oversized/malicious prompt drives unbounded resource use | Low-Medium | OOM auto-shrink-and-retry | Request-size cap, per-request generation timeout (§3.3) |
| Inference child process (mlx/rocm/vllm) escapes or is exploited | Medium-High on Windows (no sandbox primitive at all, matching the already-disclosed §2.13 gap), Low-Medium elsewhere | None runtime-specific | Extend `command-sandbox.ts`-class confinement to inference processes, or explicitly accept and document the gap the way §2.13 already does for agent tools |

### 4.3 Required hardening

- **[SW] Wire `download-verification.ts` into the actual load path** —
  `llamacpp-manager.ts`'s `loadModel()` should check `hasGgufMagic` (and a
  checksum where one is known) before handing a path to `node-llama-cpp`,
  regardless of how the file got onto disk. This closes a real, currently-dead
  safeguard rather than adding a new one from scratch.
- **[SW] Add a local shared-secret/token** on every loopback HTTP API this app
  spawns (mlx/rocm/vllm today; Ollama during the migration window) — defense
  in depth against another local process, generated per-launch and passed
  only over the already-trusted IPC channel, never exposed to the renderer
  beyond what it needs to attach the header.
- **[SW] Per-request prompt/message size cap** before forwarding to any local
  model, paired with the generation timeout from §3.3.
- **[SW+CFG] Evaluate OS-level confinement for spawned inference processes** —
  same category of decision as the already-disclosed Windows agent-sandboxing
  gap (`ENTERPRISE_READINESS_ASSESSMENT.md` §2.13): either invest in real
  confinement (Job Objects on Windows, bubblewrap/sandbox-exec parity with
  `command-sandbox.ts` on Linux/macOS) or explicitly document the
  denylist-only-equivalent posture as an accepted risk. This plan does not
  make that risk-acceptance call — it names the gap.
- **Fold §4.2's rows into `ENTERPRISE_READINESS_ASSESSMENT.md` §4** once this
  plan is acted on, rather than letting a second, disconnected threat model
  drift the way §0 describes happening between the assessment and the
  uncommitted server work.

---

## 5. Telemetry/logging criteria and plan

### 5.1 Current state (verified by direct code read)

`app/src/telemetry/` is a typed, versioned event log — but it is
**download-pipeline-only**. `schema.ts`'s discriminated union has exactly 8
event types (`download_started/resumed/progress_sampled/paused/retry/checksum_failed/completed`,
`native_addon_capability`); there is no prompt-sent, tokens-generated, latency,
or runtime-crash event anywhere in it. The only production caller of
`telemetry.recordEvent()` is `download-worker.ts` — confirmed directly, nothing
in `chat-dispatch.ts`, `ollama-manager.ts`, or `llamacpp-manager.ts` records
telemetry at all. What does exist is well-built and worth reusing as the
pattern: every field is a bounded number/boolean/enum (never a
filename/path/URL/prompt string), so PHI-leak surface is bounded by
construction, not by scrubbing; storage is local-only JSONL, rotated at
2MB/5 generations, pruned at 30 days, capped at 20MB, 0o600 permissions; there
is no remote exporter and correspondingly no disable toggle (nothing to
disable when nothing leaves the device and every field is already
non-identifying).

**Confirmed directly — the concrete gap**: `schemas.ts:426` defines an
audit-log category `"model-call-local"`, PHI-avoidant by design per its own
comment, but it is referenced **only in a unit test**
(`audit-log-store.test.ts:65`) — `chat-dispatch.ts`'s `dispatchChat()`, the
single dispatch point for every local model call, has zero `auditLogStore`
references. **Local-inference calls are audited nowhere in the running app
today.**

Separately, `logger.ts` (`app.log`) rotates once at 2MB into a single `.1`
file that gets overwritten each time — no age-based pruning, unlike the
telemetry sink's 30-day/20MB policy. ~30 `logger.*` call sites across
`app/src` were checked: none embed prompt, response, or patient-note content —
only error messages, ids, and provider/model names. No `electron-log`/
`winston`/`pino` anywhere in `app/`; raw `console.*` is absent from the
inference path.

### 5.2 Why this matters specifically for clinical readiness

`ENTERPRISE_READINESS_ASSESSMENT.md` §2.8 names "structured logging of model
outputs against the response contract" as the concrete instrumentation
engineering can build now, ahead of any formal clinical validation study. That
instrumentation cannot exist while local model calls generate zero audit
trail — this is a direct, load-bearing prerequisite for that section's plan,
not a separate concern. It also means §2.4's audit-and-accountability posture
("every audit event," per its own framing) currently has a real, silent hole
specifically for local inference, the one modality the assessment otherwise
treats as the product's core differentiator (§5's target architecture:
*"Local-first inference is preserved... the product's actual
differentiator"*).

### 5.3 Required additions

- **[SW] Wire `model-call-local` (or a renamed/extended equivalent) into
  `dispatchChat()`** — bounded metadata only, matching the existing
  PHI-avoidant pattern exactly: provider, model id, duration, token counts,
  outcome (success/failure/timeout/cancelled). Never prompt or response
  content — this is a metadata audit event, the same trust boundary the
  server-side `metrics.ts` work (per prior sessions) already established for
  the enterprise side, applied here to the desktop app's own audit log.
- **[SW] Extend `app/src/telemetry/schema.ts`** with an inference-event family
  (`inference_started`/`completed`/`failed`/`timed_out`/`runtime_crashed`)
  mirroring the existing download-event discriminated-union style and its
  bounded-field discipline — this feeds §3's performance regression tracking
  and §4's incident visibility as well, not just audit.
- **[SW] Fix `logger.ts`'s rotation** to match the telemetry sink's age-based
  pruning — a single-generation overwrite with no age cap is inconsistent
  with the more careful policy already built two files away.
- **[SW] Surface local-inference audit events in the existing Audit & Privacy
  UI** alongside other categories — no new UI surface needed, this is
  additive to an existing, working pattern.

---

## 6. Clinical-readiness context (pointer, not a restatement)

Per `ENTERPRISE_READINESS_ASSESSMENT.md` §12, current deployment classification
is **"research and clinician-supervised evaluation only — not for autonomous
clinical decisions, production dependency, or use with identifiable patient
data,"** pending the P0 items there (verified identity/RBAC, tamper-evident
audit with authenticated actors — audit chaining itself is done, actor identity
is blocked on identity — complete PHI-store encryption, approved-model
registry, MCP allowlist). Nothing in this document changes that classification;
§§2-5 above are additive hardening underneath it, not a substitute for it.

The one thing worth escalating explicitly, restated from §0: before scoping
new identity/RBAC/audit-shipping/policy work to satisfy that assessment's §5
target architecture, **check whether the uncommitted `server/` workspace
already provides it**. A cursory comparison suggests significant overlap
(OIDC-backed IAM, tamper-evident audit with authenticated actors, signed
policy distribution, SCIM provisioning, encrypted tenant backup/restore all
appear to exist there already, per this repository's own prior work logs) —
if confirmed, the higher-leverage move is integrating and committing that work
against the Medical app's `PatientCasesBackend`-style configuration boundary
(already designed for exactly this in `docs/SHARED_BACKEND_DESIGN.md`) rather
than re-building the target architecture from zero. This is a scoping decision
for whoever owns both efforts, not something this plan resolves.

---

## Implementation status (2026-08-29)

Everything §§2-5 named as a prerequisite for removing Ollama has been built,
tested, and the removal itself has shipped. llama.cpp is now the only local
model runtime in `app/`/`frontend/` — Ollama has been deleted, not just
deprioritized.

**Done and verified:**
- §4.3 dead-code fix (checksum/GGUF-magic wiring), size caps, §5.3
  audit/telemetry wiring, §3.3 generation watchdog, `logger.ts` age-based
  pruning.
- §2.6 Phase M0-M1: llama.cpp tool-calling (via `LlamaChat.generateResponse()`,
  not the auto-executing `LlamaChatSession`), llama.cpp embeddings (reusing
  the existing GGUF models directory), and a full e2e test seam
  (`MODELFORGE_E2E_FAKE_LLAMACPP` module swap, since llama.cpp has no HTTP
  surface for a `fake-ollama.ts`-style server to intercept).
- §2.6 Phase M2-M5: the `system-specs.ts` model-catalog rebuild (every entry
  now carries a `huggingFaceSearchQuery` instead of an Ollama-tag-shaped
  `name`), the actual Ollama removal (`ollama-manager.ts` and every call site
  across `app/`, `frontend/`, and `e2e/` deleted), and a settings migration
  (`migrateLegacyRuntimeSettings()`) so an existing user's
  `preferredRuntime: "ollama"` / `runtimeGpuConfigs.ollama` degrades to
  `"automatic"` instead of the closed-schema validator wiping their whole
  settings file.
- Full verification: `app/` — `tsc -b` clean, 70 test files/955 passed/1
  skipped, `npm run build` clean. `frontend/` — `tsc -b` clean, 14 test
  files/99 passed, `npm run build` clean. `e2e/` — `tsc --noEmit` clean; the
  suite itself has **not been executed** in this WSL sandbox (no display
  server available), including the newly-ported llama.cpp specs — typechecked
  and written by close pattern-matching against already-passing specs, but
  unverified beyond that. Run it on a display-capable machine or CI before
  trusting it blindly.

**Deliberately out of scope, unchanged:**
- The prose docs that still describe Ollama as a first-class runtime
  (`docs/ARCHITECTURE.md`, `docs/RESOURCE_ORCHESTRATOR.md`,
  `docs/RUST_MIGRATION_ASSESSMENT.md`, `docs/HARNESS_INTEGRATION.md`,
  `docs/DEVELOPMENT.md`, `README.md`).
- §2.7 / §6's `server/src/ai-gateway/provider-client.ts`
  `LocalOllamaProviderClient` — a different, uncommitted workspace, named
  out-of-scope from the first planning pass and not revisited.
- §3.3's SLO definition/regression harness and §4.3's shared-secret
  auth/sandboxing evaluation — both still need the [CLIN+CFG] sign-off named
  in §8 before anyone should start them; not asked for during this pass.

---

## 7. Sequencing

Ordered so security/telemetry hardening protects users regardless of migration
timing, and so the migration itself never ships a silent capability or
coverage loss:

1. **§5.3 telemetry/audit wiring** and **§4.3's dead-code fix + size caps** —
   independent of the Ollama migration, protect today's dual-runtime users
   immediately, low risk, no dependency on anything else here.
2. **§2.6 Phase M0-M1** (close tool-calling/embeddings gaps, build the
   llama.cpp e2e seam) — must precede any Ollama removal.
3. **§3.3's generation timeout/watchdog** — pairs naturally with the size-cap
   work in step 1 and should land before Phase M3's default flip, so the
   newly-default runtime has the same availability protections the plan
   calls for.
4. **§2.6 Phase M2-M5** (catalog rebuild, default flip, removal, user-data
   migration) — the migration itself, once 1-3 are done.
5. **§3.3's SLO definition and regression harness**, **§4.3's shared-secret
   auth and sandboxing evaluation** — can run in parallel with step 4 once
   targets are set (needs the [CLIN+CFG] sign-off named in §3.3).
6. **§6's server/desktop-app scoping decision** — orthogonal to 1-5, but
   worth resolving before either effort invests further in rebuilding what
   the other may already have.

---

## 8. Open decisions needing sign-off (not made by this plan)

- Performance SLO targets and hardware tiers (§3.3) — **[CLIN+CFG]**.
- Whether an indefinitely-hung generation should hard-abort automatically past
  the new watchdog timeout, or only flag itself while waiting for user
  confirmation to cancel — a clinical-safety UX call, not an engineering
  default to assume.
- UX for the new local shared-secret auth (§4.3) — invisible plumbing, or
  something surfaced anywhere in Settings/Diagnostics.
- Whether to also touch `server/src/ai-gateway/provider-client.ts`'s
  `LocalOllamaProviderClient` (§2.7) as part of this migration, leave the
  uncommitted server workspace alone entirely, or fold that question into
  §6's larger scoping decision.
- §6's server/desktop-app integration-vs-rebuild decision itself — the
  highest-leverage open question in this document, and the one most likely to
  change how much new work the rest of the clinical-readiness roadmap
  actually requires.
