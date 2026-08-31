# Rolling out the compute control plane

This sequences docs/COMPUTE_CONTROL_PLANE.md's own mechanism — contracts, scheduler, store, agent, admin console — into a safe path from zero fleet nodes to full regional production, using the generic promotion-gate tools this repo already has (docs/CANARY_RELEASES.md, docs/CAPACITY_TESTING.md, docs/ROLLOUT_AUTOMATION.md). Those tools are deployment-neutral HTTP gates; this document is what actually sequences them for *this* system. Written directly against the current code, not aspirationally — two phases below name a real feature gap rather than assume it already exists.

## Phase 1 — Contracts and persistence (done)

`packages/contracts/src/compute.ts`, migration `021_compute_control_plane.sql`, the Postgres-backed store, and the REST routes exist and are tested, with zero effect on any existing admission path until a node is actually registered and a request actually submitted. Nothing to roll out here — this phase ships inert by construction.

## Phase 2 — Agent enrollment (done)

`app/src/compute-agent.ts` closes the previously-missing desktop half: an admin registers a node's certificate fingerprint (`POST /compute/nodes`, `compute:manageNodes`), the user enters the returned node id into Settings, and the agent starts heartbeating and reserving matching local capacity for any lease it's offered. Standalone desktop operation is unaffected — `computeAgentEnabled` defaults to off, and nothing about the local `ResourceOrchestrator`'s own admission changes.

**Before phase 3**: enroll a small number of real nodes (a handful of workstations plus, ideally, one dedicated inference server) in one pool, and confirm heartbeats/assignments actually flow — `GET /compute/summary` should show them online, and `admin-console`'s Compute page should render them with live CPU/RAM/device telemetry.

## Phase 3 — Shadow mode: a real, currently-missing feature, not just an ops step

The original design calls for running the scheduler in shadow mode — computing placement decisions without acting on them, to compare against whatever admission already happens today (locally, each node's own `ResourceOrchestrator` continues to decide for itself). **This does not exist in the code today.** `POST /compute/requests` always calls `ComputeControlPlane.submit()`, which schedules *and* commits a real lease (`store.commitPlacement()`) in the same call — there is no `dryRun`/observe-only flag anywhere in `submitRequestBody`, `ComputeScheduler.schedule()`, or `ComputeControlPlane`.

Shipping shadow mode for real needs:
- A `dryRun?: boolean` field on the submit-request body and `ComputeControlPlane.submit()`'s `options`, short-circuiting before `store.commitPlacement()` and returning the scheduler's decision (`SchedulerDecision`) without ever creating a lease or consuming quota/capacity.
- Somewhere to record dry-run decisions for later comparison against what actually happened (the simplest correct option: log them as `compute_allocation_events` rows tagged `event_type: "shadow_decision"`, reusing the existing append-only audit table rather than a new one).
- A comparison report (even a manual one, cross-referencing shadow decisions against the timing/placement of whatever local admission actually did) before trusting the scheduler's judgment on real capacity.

Until this is built, **phase 4 cannot be entered safely** — there is no way to observe the scheduler's decisions without it immediately committing real leases against real capacity. This is the one concrete blocking gap in the whole rollout sequence; everything from phase 4 onward assumes it's closed first.

## Phase 4 — Canary pools, no preemption or borrowing

Once shadow mode has validated placement quality, create one small `ResourcePool` (a handful of low-risk nodes) and start submitting real, committing requests against it — but only ever call `submit()`/`scheduleRequest()` with `allowSafePreemption: false` for this phase (the route currently always passes `true` — this needs to become a per-pool or per-call toggle, not a code change to the scheduler itself, which already respects the flag correctly). Set every canary pool's `TenantComputeQuota.borrowingEnabled: false` so a canary tenant can never dip into another tenant's reserved capacity while the scheduler's fairness behavior is still unproven at scale.

**Gate to phase 5**: run `npm run ops:canary` and `npm run ops:capacity` (docs/CANARY_RELEASES.md / docs/CAPACITY_TESTING.md) against the canary pool's own request/lease endpoints specifically — not just the server's generic `/health`/`/metrics` — to get a real read on scheduling-decision latency and lease-lifecycle success rate under load before trusting preemption or borrowing against it.

## Phase 5 — Quotas, fair-share, gang scheduling, safe preemption

Flip `allowSafePreemption: true` and `borrowingEnabled: true` for the canary pool once phase 4's gates pass. Gang scheduling (atomic multi-GPU device groups) and the fair-share weight scaling (`TenantComputeQuota.weight`, see docs/COMPUTE_CONTROL_PLANE.md's scheduling invariants) are already live in the scheduler itself — nothing to toggle for those specifically, just telemetry to watch: preemption rate, victim-request restart success, and whether a low-reservation/high-weight tenant is actually getting preferential treatment for borrowed capacity as intended.

## Phase 6 — Regional and pool rollout

Repeat phases 3-5 per region/pool rather than globally at once. Use `setComputeNodeState`'s `cordon`/`drain` transitions (already wired in the admin console's Compute page) to pull a pool out of scheduling before widening its blast radius, and run `npm run ops:rollout` (docs/ROLLOUT_AUTOMATION.md) with each region's own canary+capacity reports as the promotion/rollback decision input — that tool already supports exactly this "evaluate evidence, decide promote or rollback" role; it just needs to be pointed at each region's own reports in turn, not a new capability.

**Automatic rollback gate**: `ops:rollout`'s `rollback` verdict should, at minimum, cordon every node in the affected pool (stop new placement without killing running work) rather than only alerting a human — this wiring (a script or job that reacts to `ops:rollout`'s exit code / JSON verdict by calling `POST /compute/nodes/:nodeId/state`) does not exist yet and is a small, concrete follow-up.

## Phase 7 — Retire the aggregate server VRAM ceiling

Only after every managed AI-gateway deployment (`ai_inference_deployments`, already FK'd to `compute_resource_pools.pool_id` as of migration `021`) is assigned to a healthy, fully-rolled-out compute pool — confirm via `GET /compute/summary` per pool and the admin console's deployment view — should whatever aggregate VRAM ceiling the AI gateway enforces today be relaxed in favor of this system's own per-pool/per-node accounting. Not attempted here: finding and disclosing exactly where that legacy ceiling lives is its own small investigation, not assumed away.

## What this playbook deliberately does not cover

Real chaos/HA testing (database failover, Redis loss — moot today since nothing here depends on Redis, scheduler-instance loss, regional partition, delayed heartbeats without duplicate execution) needs representative institutional load and real multi-instance infrastructure this repo cannot simulate — this is the same P2 item 5 boundary already named in docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md, not a new gap specific to compute.
