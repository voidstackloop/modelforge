# Enterprise compute control plane

ModelForge's compute control plane coordinates PHI-free CPU/GPU capacity across managed workstations and inference servers while preserving standalone desktop admission. See docs/COMPUTE_CONTROL_PLANE_ROLLOUT.md for how to actually roll this out from zero nodes to full regional production.

## Components

- `packages/contracts/src/compute.ts` is the wire-contract source of truth for nodes, accelerators, pools, quotas, signed policies, requests, heartbeats, and fenced leases.
- `server/src/compute/scheduler.ts` is a pure deterministic scheduler. It hard-filters compatibility and policy first, then scores priority, deadlines, queue age, warm-model locality, capacity, and thermal headroom.
- `server/src/store/compute-control-store.ts` defines durable transitions and supplies the in-memory development implementation. `postgres-compute-control-store.ts` persists the same contract.
- Migration `021_compute_control_plane.sql` creates RLS-protected inventory, pool, policy, request, lease, heartbeat, and allocation-event tables. PostgreSQL is authoritative; fencing tokens come from a database sequence.
- `app/src/resource-orchestrator.ts` remains the standalone node admission layer and now reserves accelerators per stable device id. Explicit multi-GPU groups are all-or-nothing.
- `app/src/compute-agent.ts` is the desktop side of the protocol: it heartbeats capacity, receives lease offers, and reserves matching local capacity via the resource orchestrator (see "Desktop agent" below).

## Timing and failure behavior

- Agents heartbeat every 15 seconds; three missed heartbeats mark a node offline.
- Offers must be acknowledged within 15 seconds.
- Running leases renew every 30 seconds and expire after 90 seconds without renewal.
- The production process runs an idempotent maintenance sweep every 10 seconds. Narrow `SECURITY DEFINER` functions perform cross-tenant expiry without granting the runtime role general RLS bypass.
- Every lease carries a monotonically increasing fencing token. A stale token cannot acknowledge, renew, release, or overwrite a newer allocation.
- A missed acknowledgement or expired lease requeues its request. Cordon/drain/quarantine states prevent new placement because only `online` nodes pass scheduler filters.

## API surface

All paths are organization-scoped under `/organizations/:organizationId/compute`:

- `GET/POST /nodes`, `POST /nodes/:nodeId/state`
- `POST /nodes/:nodeId/heartbeat`, `GET /nodes/:nodeId/assignments`
- `GET/POST /pools`, `GET/PUT /pools/:poolId/quota`
- `GET/POST /policies`, `POST /policies/:policyId/activate`
- `GET/POST /requests`, `POST /requests/:requestId/cancel`
- `GET /leases`, `POST /leases/:leaseId/{acknowledge,renew,release}`
- `GET /summary`

Administrative calls use normal OIDC and IAM policies. Agent calls require both an OIDC service-principal grant for `compute:agent` and an authorized TLS peer certificate whose SHA-256 fingerprint matches node enrollment. An mTLS-terminating ingress may inject a trusted fingerprint resolver into `buildApp`; arbitrary client headers are not trusted by default.

## Signed resource policies

Set `COMPUTE_POLICY_PUBLIC_KEY_PEM` to the institution's Ed25519 SPKI public key. Policy signatures are base64 Ed25519 signatures over the canonical JSON returned by `canonicalComputePolicyPayload(organizationId, input)`. The organization id is signed, so a policy cannot be replayed into another tenant. Missing trust configuration returns `503`; bad or tampered signatures return `400`.

Activation retires the previous policy for the same pool. Activating an earlier retained version is the rollback operation. Agents receive active, unexpired policies with their assignment feed and should retain the last known good signed policy while disconnected.

## Scheduling invariants

- Stable explicit device ids are never substituted.
- Required accelerators never silently fall back to CPU.
- Tensor-parallel device groups are allocated atomically on one node.
- Separate devices may run concurrent exclusive workloads.
- Safe preemption applies only to non-interactive work marked restartable or checkpointable; active interactive work is never a victim.
- Tenant reservations are consumed before borrowed burst capacity, and borrowing receives a score penalty scaled by the tenant's own fair-share `weight` (default 1) — a higher-weight tenant's borrowing costs less. This scales only the requesting tenant's *own* penalty; it is not a cross-tenant comparison. `SchedulerSnapshot` is fetched per (organizationId, poolId) under that organization's own RLS scope, so one scheduling pass has no visibility into other organizations' usage sharing the same pool — a genuine cross-tenant weighted comparison would need a new privileged, cross-tenant aggregate query (the same category of thing the maintenance sweep's `SECURITY DEFINER` functions exist for), which is a disclosed follow-up, not yet built.
- Telemetry free capacity and lease reservations are combined conservatively with `min(reported free, total - reserved)` to prevent both stale-heartbeat overcommit and avoidable double subtraction.

## Desktop agent

`app/src/compute-agent.ts` is the previously-missing desktop half of this protocol — every piece above existed and was fully tested before it, but nothing in `app/` ever called any of it. It is opt-in (`AppSettings.computeAgentEnabled` + `computeNodeId`, both off by default) on top of an already-connected shared backend (`shared-backend-config-store.ts`/`shared-backend-auth.ts` supply the organization id and bearer token; `compute-agent-client.ts` reuses both rather than a separate login).

- **Identity**: `compute-node-identity.ts` generates one long-lived, self-signed EC (P-256) client certificate per install on first use, storing the private key via `secrets-store.ts` (OS-encrypted where available). The server only ever compares a certificate's SHA-256 fingerprint (`X509Certificate.fingerprint256` — the same value Node's own TLS layer reports for the live peer) against what an admin registered; it never validates a certificate chain, so a self-signed identity authenticates exactly as well as a CA-issued one would.
- **Enrollment stays an admin action**: registering a node (`POST /compute/nodes`) requires the admin-level `compute:manageNodes` permission, which this app never calls on its own behalf. The user copies this device's fingerprint (surfaced via the `computeAgent:getIdentity` IPC channel) to their organization's compute admin, who registers it and hands back a node id; the user enters that id into Settings as `computeNodeId`. From then on the agent only ever calls the agent-scoped endpoints (heartbeat, assignments, lease acknowledge/renew/release).
- **Loop**: a ~15s-jittered heartbeat reports live free CPU/RAM and per-device health/VRAM (from `resource-orchestrator.ts`'s own hardware snapshot), then polls assignments. An offered lease is only acknowledged after this node's own `ResourceOrchestrator.acquire()` actually grants the matching local capacity (at a new `"fleet-assigned"` workload kind, always `"background-compute"` priority regardless of the server-side request's own priority — fleet-delegated work must never contend with the person sitting at this workstation); a lease that can't be reserved locally is silently left un-acknowledged and reclaimed server-side rather than ever double-booking capacity. Acknowledged/running leases are renewed every cycle; a lease no longer present in the server's assignment list has its local reservation released.
- **Scope boundary, disclosed rather than assumed away**: this closes the admission/capacity-protection half of the protocol, not job dispatch — what actually *runs* inside a granted lease (e.g. serving a managed AI-gateway deployment to other users) is a separate, larger, unbuilt integration. The agent is also polling-based, not push-based: an offer landing just after a heartbeat cycle's poll could occasionally miss its 15s acknowledgment deadline and simply get reassigned. Certificate rotation is not implemented — there is no server-side "trust this new fingerprint for the same node" flow yet either.

## Node-level enforcement: what's real today

Verified directly against the desktop code rather than assumed, since "enforcement" can silently mean very different things:

- **GPU visibility masking — real, OS-level.** `app/src/gpu-selection.ts`'s `buildGpuVisibilityEnv()` builds `CUDA_VISIBLE_DEVICES` (by GPU UUID where available, index otherwise) / `HIP_VISIBLE_DEVICES` / `ROCR_VISIBLE_DEVICES` and injects them into a spawned runtime process's own environment (`local-server-manager.ts`, for the ROCm/vLLM backends) — the child process genuinely cannot see or select a masked-out device, not merely told not to.
- **NUMA and thread-count control — real, but delegated.** `llamaCppNumaPolicy`/`llamaCppMaxThreads` are passed straight into node-llama-cpp's own `getLlama({numa, maxThreads})`, which does its own native NUMA/thread handling. This app makes no OS syscalls (`sched_setaffinity`, cgroups, Windows `SetProcessAffinityMask`) of its own — real enforcement, but owned by the inference library, not this codebase.
- **CPU/memory sandbox ceilings — real, but reactive, not proactive.** `AppSettings.sandboxMaxMemoryMB`/`sandboxMaxCpuPercent` (agent tool execution — a different "sandbox" than the OS process sandbox) are enforced by `resource-monitor.ts`'s `monitorProcess()`: a polling watchdog (`pidusage`, default interval) that kills the child process once it's *already* exceeded a threshold. This is detect-and-kill, not an OS-level rlimit/cgroup that prevents the process from ever crossing the ceiling in the first place — a real, meaningful distinction from what the original plan's "CPU: ... thread ceilings ... per-workload quotas" language could imply.
- **True cpuset/processor-affinity pinning and per-workload memory cgroups — investigated concretely, not just named as future work, and correctly not attempted.** Three real avenues, each with a verified, disclosed reason it's not safe to ship blindly for a cross-platform desktop app:
  - **cgroups v2** would be the correct mechanism (plain filesystem writes, no native addon) — but it's not universally available even on Linux. Checked directly in this project's own dev environment: WSL2 mounts the legacy cgroups v1 hierarchy (separate `memory:`/`cpu:`/`cpuset:` controllers, no unified `cgroup.controllers` file) with `/sys/fs/cgroup` itself read-only — zero delegation. A real end-user's desktop Linux distro might have v2 with delegation (modern systemd user sessions often do), or might not; there is no reliable way to assume it.
  - **`RLIMIT_RSS` (`ulimit -m`) has been a documented no-op on Linux since kernel 2.4.30** — it does not actually cap resident memory. There is no portable syscall-level hard RSS ceiling available without cgroups.
  - **`RLIMIT_AS` (`ulimit -v`, virtual address space) is real and enforced**, but is a poor proxy for actual memory pressure — many legitimate programs (Go/Java runtimes, anything doing sparse mmap) reserve large virtual address ranges far beyond their real RSS. Using it as a hard kill switch risks false-positive kills of legitimate agent-tool commands.
  - CPU is similar: `ulimit -t` caps cumulative CPU-*time*, not CPU-*rate* — it doesn't express "throttle to N% of a core" at all, the actual meaning of `sandboxMaxCpuPercent`.

  Given none of the three has both universal availability and a correct mapping to what this app's `sandboxMaxMemoryMB`/`sandboxMaxCpuPercent` actually mean, the existing reactive polling watchdog (`resource-monitor.ts`) remains the correct choice — not a fallback stopgap, but a genuine "this is the safest available mechanism for an app running on arbitrary, unmanaged end-user machines" conclusion. Separately: this is moot for the *compute fleet* specifically today regardless of platform — a fleet-granted lease has no actual runtime process behind it yet (see the Desktop agent section's disclosed job-dispatch gap), so there is nothing yet to apply cpuset/cgroup limits *to* on that path.

## Admin console

`admin-console/src/pages/Compute.tsx` implements fleet/pool capacity, per-node topology/health, cordon/drain/quarantine, active leases/queue, and a quota-and-fair-share-utilization editor: reserved/burst/weight/borrowing per pool, with a reserved-vs-borrowed utilization bar computed from live active leases (`GET/PUT /compute/pools/:poolId/quota` — the `GET` half didn't exist before this pass; only the pool-creation flow could set a quota blind, with no way to read one back).

`admin-console/src/pages/ComputePolicies.tsx` covers signed resource policies: a full policy-version history per pool (every version, its status, and one-click activate — including activating a retired version, which is the rollback path), a draft composer for `hardLimits`/per-priority `workloadClassLimits` with a live effective-policy preview (the exact `{...hardLimits, ...workloadClassLimits[priority]}` merge the scheduler itself applies), a "download draft JSON" step, and a "paste the signed result and submit" step. Signing itself stays strictly offline — the Ed25519 private key never touches the browser or the server. `server/scripts/sign-compute-policy.js` is the tool that actually signs a draft (mirrors `app/scripts/sign-policy.js`'s pattern for the *different*, desktop-only central-policy system — verified end-to-end against the server's real `createComputePolicySignatureVerifier()` before shipping, including that a wrong organization id or a tampered payload both correctly fail verification).

**Compute audit events use the general Audit page, not a dedicated view** — deliberately not duplicated, since `listAudit`'s `action`/`targetType` filters are exact-match only (no prefix/wildcard support server-side), so a single "show all compute events" link isn't possible without a broader audit-search change this pass didn't make. Filter by `targetType` to browse a specific compute entity's history: `computeNode`, `computePool`, `computeRequest`, `computeLease`, `computePolicy`. Real action strings recorded: `computeNode.stateChanged`, `computePool.created`, `computeQuota.updated`, `computePolicy.created`, `computePolicy.activated`, `computeRequest.submitted`, `computeRequest.cancelled`, `computeLease.allocated`, `computeLease.acknowledged`, `computeLease.released`.

## Local performance profiles

Desktop local inference supports `interactive`, `balanced`, `throughput`, and `energy-efficient` profiles. Active chat defaults to `interactive`; scheduled inference defaults to `balanced`. Profiles fill missing batch/thread/GPU settings but never reduce a session's context length or generation limit. Signed desktop policy may cap CPU threads and batch size, select the GPU backend, set RAM/VRAM reserves, control warm-model cache count, and lock the global resource budget.

Operational telemetry remains metadata-only: scheduler outcome/duration, model-load and generation timing, utilization, memory, power, temperature, and throttling. Prometheus labels must never include organization, node, request, lease, model, prompt, response, patient, or case identifiers.
