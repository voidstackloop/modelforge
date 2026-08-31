# Resource Orchestrator

Status: **admission/leasing core, cross-workload integration, sustained-
pressure throttling, OS-reserve budget modes, and model-fit-aware admission
are implemented and tested.** The Runtime Manager UI covers 4 of the 5
sections asked for (Overview, Runtimes, Workloads, Models, Resource
settings); a History section (peak-usage/incident tracking over time) and
deep per-vendor hardware detection (physical-vs-logical cores, swap,
thermal/battery) are not — see "What's not implemented" below.

## The one thing to understand before touching this code

**There are now two independent GPU/hardware subsystems that were never
unified, plus this orchestrator as a third.** `system-specs.ts` does GPU
*inventory* (what hardware exists, `assessGgufFiles`/`recommendModels`'
memory-fit math), `gpu-selection.ts`/`gpu-telemetry.ts` do GPU *placement and
live utilization* for the ROCm/vLLM runtime cards, and
`resource-orchestrator.ts` does cross-workload CPU/RAM/GPU *admission*. They
were built independently over time and were never merged into one hardware
model — `captureHardwareSnapshot()` in `resource-orchestrator.ts` is the only
bridge, wrapping `system-specs.ts`'s `getSpecs()` and re-shaping its GPU list
into the orchestrator's own `ResourceGpuSnapshot`. This is disclosed
architecture, not something this pass tried to consolidate — doing so would
touch a wide, already-tested surface for a refactor with no behavior change,
and was judged out of scope.

## Where the code lives

| Concern | Path |
|---|---|
| Shared contracts | [`app/src/resource-contracts.ts`](../app/src/resource-contracts.ts) |
| Admission/leasing core | [`app/src/resource-orchestrator.ts`](../app/src/resource-orchestrator.ts) |
| Sustained-pressure hysteresis | [`app/src/resource-pressure-monitor.ts`](../app/src/resource-pressure-monitor.ts) |
| OS-reserve budget modes | [`app/src/resource-budget.ts`](../app/src/resource-budget.ts) |
| Model-fit four-way verdict | [`app/src/model-fit-estimator.ts`](../app/src/model-fit-estimator.ts) |
| Legacy compatibility facade (model-load lease) | [`app/src/inference-resource-scheduler.ts`](../app/src/inference-resource-scheduler.ts) |
| IPC (read-only telemetry) | [`app/src/ipc/resource-handlers.ts`](../app/src/ipc/resource-handlers.ts) |
| Runtime Manager UI | [`frontend/src/pages/RuntimeManager.tsx`](../frontend/src/pages/RuntimeManager.tsx) (Workloads/Models/Resource settings tabs) |

## Core model

`WorkloadRequest` (kind + priority + CPU/RAM/accelerator requirements) goes
into `ResourceOrchestrator.acquire()`/`withLease()`, which resolves to a
`ResourceDecision`: `granted`, `granted-degraded`, `queued`,
`rejected-incompatible`, or `rejected-insufficient-resources`. Priority
(`RESOURCE_PRIORITY_RANK`) determines both queue order and — via
`resource-budget.ts`'s reserve and `resource-pressure-monitor.ts`'s
throttling — which workloads get squeezed first when the machine is
constrained:

```
active-inference (700) > user-interactive (600) > explicit-model-load (500)
  > scheduled-inference (400) > background-compute (300) > transfer (200) > maintenance (100)
```

Only one workload may hold the exclusive-accelerator admission slot at a
time (`requirements.exclusiveAccelerator`) — the "support one primary GPU
lease at a time" requirement for this first production version. A
degraded-to-CPU grant, a queued request, and a hard rejection are all
distinguished so a caller (and eventually a UI) can react appropriately
instead of treating every non-grant the same way.

## What's routed through it (and what isn't)

| Workload | Priority | Notes |
|---|---|---|
| Chat inference (llama.cpp/MLX/ROCm/vLLM) | `active-inference` / `scheduled-inference` | Generation itself is leased, not just the initial model load — see "The deadlock that had to be avoided" below. |
| Model load (llama.cpp, ROCm/vLLM/MLX server start) | `explicit-model-load` | llama.cpp's lease now carries a real RAM/VRAM estimate (`model-fit-estimator.ts`); the others still declare 0/0 (no equivalent estimator exists for HF-repo-id-resolved MLX/vLLM models). |
| RAG folder indexing | `background-compute` | |
| RAG live-query embedding | `user-interactive` | Deliberately separate from indexing so a live chat's own retrieval is never queued behind a background re-index. |
| OCR | `user-interactive` | Always user-triggered in this codebase; no scheduled OCR path exists to warrant `background-compute`. |
| Video-frame extraction (ffmpeg) | `user-interactive` | |
| Scheduled backups | `maintenance` | |
| Python workers (hardware-recommender, MLX/vLLM setup) | `user-interactive` | Leased per-request, not for the worker process's whole (mostly-idle) lifetime. |
| MCP stdio tool-server processes | `user-interactive` | Leased for the connection's lifetime (process-count bounding), not per tool call — a per-call lease would add admission latency to every step of an agent loop for no real benefit once the process is already running. |
| Downloads (Rust-managed) | — | **Not routed through the orchestrator.** Concurrency is already owned by a native Rust semaphore (`native-downloader.ts`); layering a second, JS-side scheduler on top was judged higher-risk than valuable for this pass — see "What's not implemented." |
| Cloud inference (OpenAI/Anthropic/Gemini/custom remote) | — | Correctly never leased — no local GPU/CPU/RAM reservation applies. |

### The deadlock that had to be avoided

`llama.cpp`'s `loadModel()` already held the exclusive-accelerator slot
during a cache-miss load, releasing it (via `withLease`'s own `finally`)
before returning. Adding a *second* lease around generation had to be
sequenced strictly **after** that release, never wrapping the load call
itself — an outer exclusive lease held while `loadModel()` tried to acquire
its own would wait forever on a slot only its own caller could release.
`llamacpp-manager.ts`'s `chat()` acquires the generation lease only after
`await loadModel(...)` has already returned (and thus already released any
lease it took); `chat-dispatch.ts` does the same for the authenticated
OpenAI-compatible local-server path (mlx/rocm/vllm), which likewise resolves
their own server-start lease before the generation lease is requested. This
sequential-never-nested rule is the one invariant to preserve if this code
is touched again.

## Sustained-pressure throttling (hysteresis)

`ResourcePressureMonitor` samples `os.freemem()/totalmem()` and classifies
`normal`/`warning`/`critical` with asymmetric hysteresis: escalating
requires 3 consecutive bad samples (a single noisy reading can't start
rejecting real work), de-escalating reacts to one sample crossing a
materially higher recovery threshold (being slow to notice recovery only
costs queued background work a few seconds; being slow to notice real
pressure risks the OOM this exists to prevent). Only the two lowest
priority tiers (`background-compute`, `transfer`, `maintenance`) are ever
gated by this — `warning` queues new admissions in that tier, `critical`
rejects them outright. Interactive and scheduled inference are never
affected, matching "never silently reduce clinical context."

RAM only, not VRAM/CPU — `system-specs.ts`'s GPU utilization probes
(nvidia-smi/rocm-smi) are too slow to poll every few seconds, and the
existing single-exclusive-accelerator slot already prevents concurrent
heavyweight GPU contention directly, which is the higher-value protection
for VRAM specifically.

## OS-reserve budget modes

`applyResourceBudgetMode()` (`resource-budget.ts`) reduces the hardware
snapshot's available RAM/CPU/VRAM *before* the orchestrator ever evaluates a
request against it — a ceiling every workload shares, layered on top of
(not instead of) per-lease accounting:

- **Balanced** (default) — reserves `max(15% of total RAM, 2GB)` and 1 CPU
  thread.
- **Performance** — `max(8%, 1GB)`, 1 thread.
- **Efficient** — `max(30%, 4GB)`, 2 threads.
- **Manual** — user-supplied `maxRamMB`/`maxVramMB`/`cpuThreadCeiling`, but
  never below a small fixed safety floor (`max(5%, 512MB)`, 1 thread) — a
  mistaken ceiling set to the machine's full RAM can't starve the OS
  outright.

Read fresh from `AppSettings` on every admission cycle (not cached at
construction), so changing the mode in the Runtime Manager's "Resource
settings" tab takes effect on the very next admission pass with no restart.
Persisted via the ordinary `settings:save` IPC channel — no new handler was
needed since it's already a generic partial-merge.

## Model-fit estimation (four-way verdict)

`estimateModelFit()` is a thin adapter over `system-specs.ts`'s existing
`assessGgufFiles()` — not a second, parallel estimator — mapping its
five-way `RecommendationOutcome` onto item 6's four-way language
(`comfortable` / `degraded` / `cpu-fallback` / `unsafe` / `unknown`) and
splitting its single `totalRequiredGB` into the RAM-vs-VRAM shares a lease
request actually needs. Wired into `llamacpp-manager.ts`'s `loadModel()` so
a load request now declares its real estimated footprint instead of a `0/0`
placeholder — before this, two large model loads could both be admitted
concurrently regardless of how much memory either actually needed, since
neither declared any. The same estimate is what the Runtime Manager's
**Models** tab shows per installed model — read-only observation of the
identical function that gates real admission, so the UI can never disagree
with what a load will actually do.

Known, disclosed limitation: `sizeBytes` comes from a single `stat()` of the
representative file — the first shard for a multi-part GGUF model — not the
sum of every shard, under-estimating total size for sharded models
specifically. The common single-file case is unaffected.

## IPC and the renderer boundary

`resource:getTelemetry` is the only channel — read-only, no arguments, and
PHI-safe by construction (workload-kind enums, numeric capacity/budget, and
lease/queue bookkeeping only; `ResourceOrchestrator.getTelemetry()` already
strips `requestId` from active leases before returning them). There is
deliberately no channel for the renderer to acquire/release a lease
directly or override a budget — every real workload is scheduled from the
main-process call site that does the actual work, never in response to a
renderer-originated resource command. Sender-frame validation
(`ipc/trusted-sender.ts`) wraps `ipcMain.handle` globally before any handler
module registers a channel, so this one is protected by the same structural
mechanism (and the same generic test suite) as every other IPC channel in
the app — nothing channel-specific was needed or added.

## What's implemented

- Admission/leasing core: priority queueing, CPU/RAM/single-exclusive-
  accelerator budgeting, CPU-fallback degradation, abort/cancel, heartbeat +
  TTL-based lease reclamation on crash.
- Real per-message generation leasing for every local inference backend
  (not just initial model load), with a tested, deadlock-free sequencing
  rule.
- RAG indexing vs. live-query priority separation; OCR, media processing,
  backups, Python workers, and MCP tool-server processes all leased.
- Hysteresis-based sustained-RAM-pressure throttling of background-tier
  admission, with immediate re-evaluation on a pressure-level change (not
  just on the next unrelated event).
- Four OS-reserve budget modes, live-reloaded from settings, with a safety
  floor even in Manual mode.
- Model-fit four-way verdict wired into real llama.cpp admission decisions
  and surfaced read-only in the UI.
- Read-only, PHI-safe, sender-validated IPC telemetry channel.
- Runtime Manager: Workloads tab (active leases, queue, pressure banner),
  Models tab (per-model compatibility/loaded-state/why-explanation),
  Resource settings tab (mode picker + manual ceilings).
- 908+ resource-orchestrator-adjacent tests across
  `resource-orchestrator.test.ts`, `resource-pressure-monitor.test.ts`,
  `resource-budget.test.ts`, `model-fit-estimator.test.ts`,
  `inference-resource-scheduler.test.ts`, `chat-dispatch.test.ts`,
  `rag.test.ts`, `ocr.test.ts`, `media.test.ts`, `backup-scheduler.test.ts`,
  `python-runtime-manager.test.ts`, and `mcp-client.test.ts`.

## What's not implemented

Disclosed explicitly rather than silently left out:

- **History section** (peak consumption, tokens/sec, OOM/fallback
  incidents, predicted-vs-actual, PHI-free). This needs a persistent event
  log distinct from live telemetry — a genuinely separate piece of work,
  not a quick addition to what exists.
- **Adaptive tuning** (Phase D: correcting future estimates from measured
  peaks, thermal/battery-aware behavior). Depends on History existing first
  to have anything to learn from.
- **Deep per-vendor hardware detection improvements**: physical-vs-logical
  CPU core count (`system-specs.ts`'s `cpuCores` is `os.cpus().length`,
  i.e. logical/SMT threads), swap detection (absent entirely), and
  thermal/battery state as part of `SystemSpecs` (a separate
  `power-monitor.ts` tracks energy/activity but isn't part of the hardware
  snapshot this orchestrator consults). High effort, and hard to verify
  meaningfully without access to genuinely diverse hardware.
- **Downloads are not routed through the orchestrator.** Real concurrency
  is already owned by a native Rust semaphore
  (`native-downloader.ts`/`download-worker.ts`'s event-driven,
  pausable/resumable/cancellable job state machine); integrating it would
  mean correctly acquiring/releasing a lease across every one of that state
  machine's transitions (start, pause, resume, cancel, retry, complete,
  fail) without leaking one on an edge case — judged higher-risk than the
  value gained (mainly: downloads becoming visible in the Workloads tab and
  subject to pressure-based throttling) for this pass.
- **Preflight dialogs before an unsafe model launch** (Phase C). The
  estimator and verdict exist and are shown in the Models tab, but nothing
  intercepts a chat-send to a model already known to be `unsafe` before the
  message is sent — the user currently discovers this from the rejection
  error (which does carry the real reason, e.g. "Requested 5000MB RAM, but
  the system has 4000MB") or from checking the Models tab beforehand, not
  from a proactive dialog at send time.
- **Some of item 7's listed UI states** are covered incidentally by what
  exists (e.g. "Telemetry unavailable" — `GpuDevicesTable`'s own badge;
  "Insufficient RAM/VRAM" and "Waiting for another workload" — the
  Workloads tab's queue and rejection-reason text) but others were not
  built as distinct, named states: "Detecting hardware," "Missing/outdated
  driver," "Thermal throttling," "Model crashed and resources released,"
  and "Managed setting locked by organization policy" have no dedicated UI
  treatment for the resource-orchestrator surface specifically (some of
  these — e.g. policy-managed settings — already exist as a general
  mechanism in `policy-store.ts` for other settings, just not wired to
  `resourceBudgetMode` yet).

## A real bug found and fixed along the way

Wrapping `python-runtime-manager.ts`'s `request()` in a lease broke
`shutdown()`'s "reject every pending request immediately" guarantee for a
request still waiting on admission when `shutdown()` ran: since the request
only registered itself in the internal `pending` map *after* the lease was
granted, `shutdown()`'s `failAllPending()` never saw it, and the request
would go on to spawn a brand-new child process — the opposite of what
"shut down" should mean. Fixed with a per-generation `AbortController` that
`shutdown()` fires before checking for a child to clean up; a regression
test (`"rejects immediately even when shutdown() runs before the
resource-orchestrator has granted the lease yet"`) pins this down.

## Tests run

```
cd app && npm run build   # clean
cd app && npm test        # 913 passed, 1 skipped
cd frontend && npx tsc -b # clean
cd frontend && npm run build && npm test  # clean; 100 passed
```

The Models and Resource-settings tabs were also verified live in a browser
(mocked IPC responses) rather than only by unit test — mode selection
correctly reveals manual-ceiling fields, Save posts the expected payload,
and per-model compatibility rows render the right verdict/loaded-state/
reason for both a comfortable and a genuinely-too-large mocked model.
