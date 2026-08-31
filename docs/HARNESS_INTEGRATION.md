# Harness integration assessment

**Scope:** Whether and how to introduce [Harness](https://www.harness.io/) (the
CI/CD and DevSecOps platform) into ModelForge Medical. This is an assessment and
design document, produced without any external account, credential, or
infrastructure changes — see §12 ("Authorization boundary") below for exactly
what was and wasn't done.

**Relationship to other docs:** `docs/ENTERPRISE_READINESS_ASSESSMENT.md` is the
authoritative gap analysis for institutional deployment as a whole (identity,
audit, encryption, clinical governance). This document is scoped narrowly to
software-delivery and supply-chain tooling — it does not re-derive that
assessment's conclusions and makes no clinical-safety or compliance claims of
its own.

---

## 1. Current-state verification (source-inspected, not assumed)

Per this task's own instruction, every claim below is checked against current
source, not the historical assessment docs — one turned out stale (§1.3).

### 1.1 CI (`.github/workflows/ci.yml`) — five independent jobs

| Job | What it does | Runner(s) |
|---|---|---|
| `test` | `npm ci` (frontend/app/mastervault-mcp-server) → lint frontend → typecheck frontend+app → `npm test` frontend+app (Vitest) → build frontend+app → build the bundled MasterVault MCP server → stdio JSON-RPC smoke test against it | ubuntu-latest |
| `e2e` | Build frontend+app → `xvfb-run --auto-servernum npx playwright test` (real Electron process, virtual display) → upload the HTML report | ubuntu-latest |
| `rust` | `cargo fmt --check` + `cargo clippy -- -D warnings` (ubuntu leg only) → `cargo build --release` → `cargo test` → `napi build --platform` → **load the built `.node` addon under Node and assert its exports exist** | matrix: ubuntu/windows/macos-latest |
| `sbom` | CycloneDX SBOM (`@cyclonedx/cyclonedx-npm`) for frontend, app, and mastervault-mcp-server, uploaded as an artifact (90-day retention) | ubuntu-latest |
| `python-recommender` | `pytest` on the hardware-recommender package's unit tests (CPU-only torch) → verify the shipped ONNX artifact exists → smoke-test the packaged worker script against it | ubuntu-latest |

### 1.2 Release (`.github/workflows/release.yml`) — triggered on `v*.*.*` tag push

- `build` job: 3-OS matrix → `npm test` (frontend+app) → `npm run build:all && electron-builder --publish never` → **verify the platform's expected installer artifact actually exists** (`.exe`/`.dmg`/`.AppImage`) → upload as a matrix-scoped artifact.
- `publish-release` job (needs `build`): downloads all matrix artifacts merged → **re-verifies all three installer patterns are present** → creates the GitHub Release → uploads each asset **one at a time, with retry (4 attempts, backoff) and byte-size verification** (a documented fix for a real incident: concurrent bulk upload silently dropped the largest asset on a prior release).
- **No code signing configured** — `docs/DEVELOPMENT.md` documents the exact env vars (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) electron-builder would read if set, but none are wired into `release.yml` today — every installer currently shows an "unknown publisher" warning.
- **No approval gate** — publishing happens automatically on tag push, with no manual review step.
- **No rollback/revocation automation** — none found in either workflow.

### 1.3 Supply-chain tooling already present (correcting a stale claim)

`docs/ENTERPRISE_READINESS_ASSESSMENT.md` previously stated "no `.github/dependabot.yml` exists." **This is now stale — corrected as part of this pass.** `.github/dependabot.yml` exists and is comprehensive: weekly updates across all 5 npm ecosystems (frontend, app, e2e, mastervault-mcp-server) plus `cargo` (`/lib`), `pip` (`/ml/hardware-recommender`), and `github-actions` itself, with production/development dependency grouping so security patches aren't held behind an unrelated batched PR.

**Still genuinely absent** (verified via grep across `.github/`, `*.yml`, `*.json`): no SAST (no CodeQL, Semgrep, or equivalent), no dedicated secret-scanning step, no license-policy gate, no `SECURITY.md`, no `CODEOWNERS`, no branch-protection-as-code. Dependabot alerts on known-vulnerable dependency *versions*; it does not scan source for injected secrets or code-level vulnerability patterns — those are genuinely open gaps, not overlap with what already exists.

### 1.4 Model-provider dispatch — the gateway insertion point, verified

`app/src/chat-dispatch.ts`'s `dispatchChat()` is the **single choke point** every chat call goes through (both the streaming `chat:send` IPC path and the scheduled-task runner's `completePrompt()`), for both local providers (llamacpp/mlx/rocm/vllm) and remote ones (openai/anthropic/gemini/custom). For remote providers, each ultimately calls `createOpenAiCompatibleChat(baseUrl, label)` (`app/src/providers/openai-compatible.ts`) with a **base URL that is already a runtime parameter, not a compile-time constant** — `openai.ts`/`anthropic.ts`/`gemini.ts` each pass a hardcoded default (`https://api.openai.com/v1`, etc.), while `customProviders` (user-added OpenAI-compatible endpoints, `settings-store.ts`) already prove this exact base-URL-substitution mechanism works end-to-end today. This is the concrete, low-risk insertion point Track B's design (§5.2) is built on — verified by reading the code, not assumed.

### 1.5 MCP transport — already structurally distinguishes local from remote

`mcpServerConfigSchema` (`app/src/schemas.ts`) has `transport: z.enum(["stdio", "http"])`. Every configured MCP server is already one or the other, structurally — a future asset-discovery integration (Track B §5.2, a requirement from this task) has an existing field to filter on, not new classification logic to invent.

### 1.6 Shared backend — design-only, not built

`docs/SHARED_BACKEND_DESIGN.md` (pre-existing in this worktree) specifies a bring-your-own-server HTTP API contract for a future shared `PatientCasesBackend` implementation, explicitly **not** a ModelForge-operated service. No server implementation exists. Track C (§6) is written against that design, not against running infrastructure — it describes how Harness *could* operate that backend once someone builds it and an institution deploys it, and is explicitly speculative for that reason.

---

## 2. Architectural boundary

Adopted as-is from this task's brief — restated here as the standing rule for
every recommendation below, not just a preamble:

**Harness may manage**: repository builds and tests; release approval gates;
installer artifact verification; SBOM and vulnerability scanning; code-signing
and notarization workflows; deployment of a future shared backend; non-PHI
operational monitoring; AI-security testing in synthetic-data staging;
organization-wide cloud/model cost reporting; engineering service ownership and
runbooks.

**Harness must not become**: a medical diagnosis or prescribing engine; a
medication-interaction database; a clinical-validation substitute; a hidden
recipient of prompts or patient information; proof of HIPAA, HITRUST, FDA, MDR,
GDPR, AI Act, or KVKK compliance; a replacement for institutional identity,
legal review, or clinician oversight.

Nothing in this document overrides `docs/ENTERPRISE_READINESS_ASSESSMENT.md`'s
own explicit non-claims. Harness is delivery/operations tooling. It has no
bearing on whether ModelForge's clinical output is safe, validated, or
compliant — those questions are answered (or not yet answered) entirely
independently of what CI/CD platform builds and ships the software.

---

## 3. Harness suitability matrix

Every row is sourced from current official Harness documentation (§11 lists
every URL); no schema, plan tier, or capability below is guessed. Several
tier/pricing specifics genuinely could not be confirmed from public docs
(marked **unconfirmed** below) — resolving those requires a Harness sales
conversation, not more searching.

| Capability | ModelForge use case | Expected benefit | Current repo equivalent | Replaces / Complements / Reject | Required plan/infra | PHI exposure risk | Effort | Recommendation |
|---|---|---|---|---|---|---|---|---|
| **CI** | Run frontend/app/Rust/Python test-build-lint matrix | Institutional CI ownership, org-wide pipeline standards if adopting Harness elsewhere too | `.github/workflows/ci.yml`, mature, 5 jobs, all green | **Complements** (parallel run — see §4.3) — do not replace until parity proven | Free plan covers CI; Windows/macOS on Harness Cloud need Support contact for enablement (not self-service) — material for the native-addon 3-OS job specifically | **None** — CI touches only source code and test fixtures, never runtime PHI | Medium (mapping 5 jobs, verifying the native-addon Windows/macOS runner story) | **Later / PoC** — real value only once Windows/macOS Cloud runner access is confirmed enabled for this org |
| **CD** | Future: deploy the not-yet-built shared Patient Cases backend server (Track C) | Approval gates, blue-green/canary rollout for a stateful service holding PHI | None — no server exists to deploy | **N/A today** — nothing to complement or replace | Free plan for CD itself; a Delegate in whatever infra hosts the backend | **High if used prematurely** — do not point CD at anything holding real PHI before the backend itself, its auth, and its encryption are built and reviewed | High (blocked on the backend existing at all) | **Reject for now** — revisit only after Track C's prerequisite (a real shared backend) exists |
| **Security Testing Orchestration (STO)** | Orchestrate SAST/SCA/secret/container scanning in one dashboard | Single pane for findings across all scanner types | None — no orchestration layer exists; Dependabot covers only dependency-version currency, not code-pattern or secret scanning | **Complements** — net-new capability, doesn't replace anything | Not in Free plan — Enterprise/add-on, exact tier unconfirmed | **None** — scans source, not runtime data | Medium | **PoC** — genuinely closes a real gap (§1.3), but tier cost is unconfirmed and should be evaluated against simpler alternatives (native GitHub CodeQL is free) first |
| **SAST / SCA (native + orchestrated)** | Catch injected vulnerabilities and known-CVE dependencies before merge | Real, currently-absent control (§1.3: no SAST exists in this repo at all today) | Dependabot (SCA-adjacent: version currency + GitHub's own vulnerability alerts, not full SCA policy) | **Complements** for SAST (no equivalent exists); **partially complements** Dependabot for SCA (Dependabot already does version-currency; Harness SCA would add license/policy gating Dependabot doesn't) | Same as STO — unconfirmed tier | **None** | Medium | **Now-adjacent** — this is the single highest-value *security* item in this matrix precisely because nothing currently fills the SAST gap; worth pricing out independent of the rest of Harness |
| **Software Supply Chain Assurance (SSCA)** | SBOM/SLSA provenance/signing for release artifacts | Signed, standards-compliant (CycloneDX+SPDX, SLSA v1.0) provenance beyond today's unsigned CycloneDX-only SBOM | `.github/workflows/ci.yml`'s `sbom` job — CycloneDX only, unsigned, artifact-retained but not attested | **Complements, with a real shortcut**: Harness ships `harness/github-actions/sbom-ingestion` specifically to ingest SBOMs from an *existing* GitHub Actions build — meaning SSCA could be adopted **without migrating the CI job that produces them** | Not in Free plan — unconfirmed tier; Cosign signing needs HashiCorp Vault (the only supported KMS per docs) for non-keyless signing | **None** | Low-Medium (the ingestion path specifically, since it doesn't require a CI migration) | **PoC** — the GitHub-Actions-ingestion path is a genuinely low-risk way to trial this without touching `ci.yml` at all |
| **AI Test Automation** | Test the Chat/Settings renderer UI | Reduced manual QA for the web-rendered surface | `e2e/` — real Playwright + real Electron, exercising IPC, native Node APIs, filesystem, encryption, installer behavior | **Reject as a replacement; unverified as a complement.** Docs describe browser/web-app testing (records interactions, runs Playwright specs) with **no documented Electron or native-desktop support found** — this task's own caveat #2 is confirmed correct by the research | Unconfirmed tier | **Depends** — if it ever gains desktop support, synthetic fixtures only, same as every other test in this repo | High if attempted (unproven fit) | **Reject for the app's actual test surface.** The renderer's *pure-web* pages (Chat/Settings *rendering*, not IPC/native behavior) are a narrow, plausible PoC candidate later, but existing Playwright/Electron tests must remain authoritative regardless — they're the only thing that has ever proven IPC/encryption/installer correctness |
| **AI Security** | Discover/risk-score LLM and MCP integrations | Visibility into which AI endpoints/MCP servers are in use org-wide | None — MCP servers are per-user-configured locally, `transport` field already distinguishes local/remote (§1.5) | **Complements, but only at a gateway** (Track B) — the exact technical mechanism Harness uses for discovery (proxy vs. existing-gateway integration) is **not confirmed in public docs** (unresolved even after direct research); the safe design (Track B) routes through an institution-operated gateway regardless of that unconfirmed detail, since direct-from-Electron traffic has no institutional vantage point for *anything* to observe safely | Unconfirmed tier | **High if misapplied** — must never observe the renderer or Electron main process directly; only a gateway an institution already operates and controls | High (real implementation is a full feature, not a config change — see Track B) | **PoC-in-design-only** — Track B is the complete PoC-readiness design; do not build against synthetic staging until an institution has actually stood up a gateway |
| **AI SRE** | Incident management for a future always-on shared backend | Alert correlation, runbook automation | None — no production service exists | **N/A today** | Unconfirmed tier; Delegate needed for actions against external systems | **High if misapplied** — must never ingest case content/prompts/PHI as alert context (Track C's explicit exclusion) | Low to configure, but blocked on having a service to monitor | **Reject for now** — this task's own point #5 is confirmed: AI SRE is only useful once Track C's backend exists and runs continuously |
| **Cloud & AI Cost Management (CACM)** | Track remote-provider API spend (OpenAI/Anthropic/Gemini token costs) if usage is ever aggregated org-wide | Cost visibility across a fleet of installs | `frontend/src/lib/pricing.ts` (local, per-session cost estimate only) — no aggregate/fleet-wide tracking exists, by design (this is a local-first desktop app) | **N/A for a single-user desktop app** — CACM aggregates spend across an org's *cloud accounts/API keys*; ModelForge's remote-provider keys are per-user, stored locally (`secrets-store.ts`), never aggregated anywhere today | Free-Forever tier exists (30-day retention, $250K/yr managed-spend ceiling) for cloud cost; AI-cost-tracking-specifically-in-Free is **unconfirmed** | **None directly** — but *would* require an institution to aggregate API key usage centrally, which ModelForge doesn't do today (a design change orthogonal to this task) | Low if an institution already centralizes provider billing | **Later** — only relevant once/if an institution centralizes remote-provider billing (a prerequisite ModelForge doesn't have) |
| **Feature Management & Experimentation (FME)** | Gradual rollout of new ModelForge features (e.g., a future central-policy or shared-backend feature) across a fleet | Kill-switch/rollout control without a redeploy | None — every feature ships on/off via a code release, no runtime flag system | **Complements** — genuinely useful for exactly the kind of staged rollout this task's own Track A/B/C recommend (e.g., gating the AI-gateway feature in §5 behind a flag) | Basic feature flags in Free plan; full FME/experimentation (ex-Split) unconfirmed if identical entitlement | **None** — flag evaluation is boolean/string config, not data | Low-Medium (Node SDK exists, usable from the Electron main process) | **Later** — worth revisiting specifically when Track B's gateway routing or Track C's shared backend actually gets built, as the natural place to gate a staged feature |
| **Internal Developer Portal (IDP)** | Service catalog/scorecards for ModelForge's own modules | Standardized ownership/runbook tracking | `docs/ARCHITECTURE.md`'s module table (manual, not automated) | **Reject at current scale** | **Enterprise-only, minimum 20 developer licenses** — confirmed disqualifying for a project this size | **None** | N/A | **Reject** — the licensing floor alone rules this out regardless of technical fit |
| **Delegates / avoiding Harness SaaS entirely** | Institutional infrastructure decision underlying every module above | Determines whether *any* repository/build/PHI-adjacent data ever reaches Harness's cloud | N/A | — | Delegate: outbound-only HTTPS(443) to Harness SaaS, executes locally; **Harness Self-Managed Enterprise Edition (SMP)** exists as a fully on-prem/air-gapped alternative (Kubernetes, min. 8 vCPU/32GB RAM) | **This is the actual control that matters for every other row** — an institution that cannot accept any data reaching a third-party SaaS control plane should evaluate SMP specifically, not Harness Cloud, before adopting anything above | High (SMP is real infrastructure to operate) | **Institutional decision required before Stage 1 of any track** — see §8 |

---

## 4. Track A — Delivery and supply-chain security

**Goal:** full functional parity with the existing GitHub Actions workflows,
running *in parallel* with them — GitHub Actions stays authoritative and stays
the only thing that publishes a release until a Harness pipeline has proven
equivalent, not just similar, coverage over a real trial period.

### 4.1 Coverage parity table

Every command below is copied verbatim from `.github/workflows/ci.yml` /
`release.yml` / `docs/DEVELOPMENT.md` (§1.1–1.2) — not re-derived or guessed.

| Existing GitHub Actions step | Exact command | Harness CI equivalent |
|---|---|---|
| Frontend lint | `npm run lint` (in `frontend/`) | Run step, same command |
| Frontend typecheck | `npx tsc -b` (in `frontend/`) | Run step, same command |
| Frontend test | `npm test` (in `frontend/`, Vitest) | Run step, same command |
| Frontend build | `npm run build` (in `frontend/`) | Run step, same command |
| App typecheck | `npx tsc -p tsconfig.json --noEmit` (in `app/`) | Run step, same command |
| App test | `npm test` (in `app/`, Vitest) | Run step, same command |
| App build | `npm run build` (in `app/`) | Run step, same command |
| MasterVault bundled build | `npm run build:bundled` (in `mastervault-mcp-server/`) | Run step, same command |
| MasterVault stdio smoke test | JSON-RPC handshake piped into `dist-bundled/index.js`, grep for `mastervault_orient` in the response | Run step, same shell script |
| Playwright Electron E2E | `xvfb-run --auto-servernum npx playwright test` (in `e2e/`, after building frontend+app) | Run step on a Linux-capable stage/runner with Xvfb available (or a container image that bundles it) |
| Rust format | `cargo fmt --check` (in `lib/`) | Run step |
| Rust lint | `cargo clippy --all-targets -- -D warnings` (in `lib/`) | Run step |
| Rust build+test | `cargo build --release && cargo test` (in `lib/`) | Run step |
| napi build | `npm run build:debug` (in `lib/`) | Run step |
| Native addon load test | `node -e "require('../app/native'); assert exports"` per-OS | Requires a **matrix/parallelism construct across Windows, macOS, and Linux runners** — see §4.2 for why this is the one piece needing explicit verification before committing to Harness for this job |
| SBOM generation | `npx --yes @cyclonedx/cyclonedx-npm --output-file <path>` × 3 workspaces | Run step ×3, or a dedicated SSCA pipeline stage if using Harness SSCA (see matrix) |
| Python recommender tests | `pytest tests/ -q` (in `ml/hardware-recommender/`), CPU-only torch install | Run step |
| Python recommender smoke test | JSON-lines piped into `recommender_worker.py`, assert 2× `"ok": true` | Run step, same shell script |
| Installer artifact verification | glob check for `.exe`/`.dmg`/`.AppImage` per OS, fail loud if absent | Run step, same logic, on each OS-specific delivery stage |
| Release publish | `gh release create` + per-asset upload with retry/size-check | Requires either shelling out to `gh` with a `GITHUB_TOKEN`-equivalent credential, or a Harness-native GitHub Release step — **verify the latter exists with the same fail-loud, per-asset-size-verified semantics before replacing the current script**, since that exact retry logic exists because of a real prior incident (a silently-dropped large asset) |

### 4.2 What must be proven, not assumed, before Harness replaces anything

1. **Multi-OS native-addon load testing.** This job's entire reason for
   existing (per its own in-repo comment) is that `cargo build`'s cross-compile
   can silently succeed while producing a `.node` binary Node can't actually
   `require()` on that OS — the failure mode is platform-specific packaging,
   not source correctness. Whatever Harness CI infrastructure runs this job
   must genuinely execute on Windows, macOS, and Linux — not a Linux
   container emulating them. **Do not treat this as done until it's been run
   for real on all three, once, and its output compared line-for-line against
   a GitHub Actions run of the same commit.**
2. **Electron + Xvfb E2E.** Confirm Harness's Linux runner/build-image option
   can launch a real Electron `BrowserWindow` (Xvfb or an equivalent virtual
   display, plus whatever native libraries Chromium's sandbox needs). This is
   exactly the kind of thing that "should work because it's just Linux" but
   deserves one real run before being trusted.
3. **Release-asset upload semantics.** The current retry/backoff/byte-size
   verification in `release.yml` exists because of a documented real failure
   (concurrent bulk upload silently dropping the largest asset). Do not adopt
   a Harness-native release/deployment step for this job unless it's been
   verified to have equivalent-or-better guarantees — a regression here is a
   *silent* one (a release "succeeds" while missing an installer), which is
   the worst kind to introduce while migrating tooling.
4. **SBOM format/consumer compatibility.** If adopting Harness SSCA for SBOM
   generation/ingestion instead of the current `cyclonedx-npm` step, confirm
   it produces (or accepts) the same CycloneDX format already being uploaded
   as a build artifact today, so nothing downstream that reads those SBOMs
   breaks silently.

### 4.3 Staged adoption plan

1. **Stage 0 (this document + repo-side config only)** — no Harness account
   yet. Produce this assessment, and (§10) a schema-validated pipeline
   template an institution can adopt once they provision a Harness account.
2. **Stage 1 (institutional decision, external to this repo)** — an
   institution creates a Harness account/organization, decides Harness Cloud
   vs. Self-Managed Enterprise Edition (see the trust/PHI analysis in §5.3
   and §7), and connects this GitHub repository as a read-only trigger
   source. **GitHub Actions remains the only thing that publishes releases
   through this entire stage.**
3. **Stage 2 (parallel run, non-blocking)** — the Harness pipeline runs on the
   same triggers as `ci.yml` (push to `main`, PRs), reporting status but
   gating nothing. Compare results against the GitHub Actions run of the same
   commit for at least the "must be proven" list in §4.2, over enough runs to
   build confidence (a specific number is an institutional risk-tolerance
   call, not an engineering one — but "at least one full release cycle,
   including one real Windows/macOS/Linux native-addon load test," is a
   reasonable floor).
4. **Stage 3 (supply-chain-first cutover)** — once parity is proven, move the
   *lowest-risk, highest-value* pieces first: SBOM/SCA/SAST/secret-scanning
   (net-new capability, not replacing anything that currently gates a
   release) and release approval gates (net-new — today's release has none).
   GitHub Actions keeps running the existing build/test/e2e/release-publish
   jobs unchanged.
5. **Stage 4 (full cutover, institutional decision)** — only after Stage 3 has
   run in production for a defined trial period with zero missed-parity
   incidents does replacing GitHub Actions' build/test/release jobs become a
   decision for whoever operates the repository to make — not something this
   document recommends on its own authority.

**Rollback at every stage**: since GitHub Actions is never disabled until
Stage 4, rollback at any point through Stage 3 is simply "stop using the
Harness pipeline's results" — no repository state to revert. At Stage 4,
rollback means re-enabling `ci.yml`/`release.yml` (never deleted, only
superseded) and disconnecting the Harness pipeline's write access to
releases. See §9 for the full rollback strategy across all three tracks.

---

## 5. Track B — AI-security staging architecture (design only, not deployed)

### 5.1 Why this is design-only

This task's own instruction is explicit: *"Do not implement runtime gateway
routing unless the current repository already has a suitable provider
abstraction and the complete change can be made safely with tests. A design
document is preferable to an incomplete or privacy-unsafe integration."*
§1.4 above verifies the abstraction genuinely exists (`dispatchChat()` +
`createOpenAiCompatibleChat`'s runtime-parameterized base URL). What does
**not** exist is a real gateway to route to, or a Harness account to observe
it — building routing code against nothing real to test against would produce
exactly the "incomplete or privacy-unsafe integration" this task says to
avoid. This section is therefore the design, not the implementation.

### 5.2 Target architecture

```
ModelForge (Electron main process)
    │
    ├─ local providers (llamacpp / mlx / rocm / vllm)           ──────────▶ stays local, never routed
    ├─ local stdio MCP servers (transport: "stdio")              ──────────▶ stays local, never routed
    │
    └─ remote providers (openai / anthropic / gemini / custom)
       + remote HTTP MCP servers (transport: "http")
            │
            │  only if org policy requires it (see below)
            ▼
       institution-managed AI gateway  ◄── Harness AI Security observes/protects *this*, not the renderer
            │
            ▼
       OpenAI / Anthropic / Gemini / approved providers
```

**Requirements, and how each maps onto what already exists or would need to
be built:**

| Requirement | Design |
|---|---|
| Disabled by default | A new setting, `aiGatewayUrl?: string` + `aiGatewayRequired?: boolean` (unset = today's behavior, direct-to-provider) |
| Local providers bypass the gateway | Already true structurally — `dispatchChat()`'s local-provider branches (llamacpp/mlx/rocm/vllm) never touch `createOpenAiCompatibleChat`'s base-URL parameter at all; only the remote branches would ever read the gateway setting |
| Remote destination visible in the UI | Extend the existing transmission-preview UI (`docs/CLINICAL_WORKSPACE.md`'s "Transmission preview before a remote send") to show the *effective* destination — gateway URL when routing is active, provider URL otherwise — never silently swap one for the other without it being visible at the point of send |
| Existing transmission preview/consent remain mandatory | Unchanged — the gateway sits *behind* that consent step, not instead of it. A user still explicitly confirms a remote send; routing through a gateway changes *where the confirmed request goes*, not *whether confirmation happens* |
| Organization policy controls whether routing is required | Natural extension of `policy-store.ts` (built this engagement — see `docs/CENTRAL_POLICY.md`): add `aiGatewayUrl`/`aiGatewayRequired` to `MANAGED_SETTING_KEYS`, so an institution can *mandate* gateway routing the same way it already mandates `networkToolsEnabled` or `auditLogRetentionDays` — not built in this pass, but the mechanism to hang it on already is |
| Timeouts and gateway failures are visible | The existing `describeNetworkError`/`describeHttpError` helpers (`app/src/providers/errors.ts`, used by every provider today) already surface network/HTTP failures as user-visible chat errors — a gateway failure would flow through the exact same path, not a new silent-failure mode |
| **Gateway failure must never silently fall back to direct provider access** | This is the one behavior that must be built deliberately, not inherited for free: a failed gateway call must surface as a failed send, exactly like a failed direct-provider call does today — it must **not** catch the gateway error and retry against the provider directly. This is a specific, testable negative case (see §5.4) |
| Synthetic data only during initial testing | A staging deployment of this design must use only synthetic prompts/fixtures — same standing rule as every test in this repository (`docs/DEVELOPMENT.md`'s testing conventions) |
| No prompts, responses, tool arguments, or PHI in Harness logs | The gateway is the trust boundary: Harness AI Security (if used) observes traffic *at the gateway*, which an institution operates and controls the logging policy for — ModelForge's own logging discipline (`logger.ts` never logs message/case content, confirmed by grep in `docs/ENTERPRISE_READINESS_ASSESSMENT.md`'s PHI inventory) is a separate, already-enforced guarantee that doesn't change because a gateway now sits in the path |
| Retention, encryption, residency, tenant isolation, contractual requirements documented before production | **[CFG]/[LEGAL]** — these are properties of the institution's own gateway deployment and its contract with Harness (if AI Security is used against it), not something this repository's code can specify or guarantee. Explicitly out of scope for this document to resolve |
| MCP asset discovery distinguishes remote HTTP from local stdio | Already true structurally (§1.5) — `McpServerConfig.transport` |

### 5.3 Trust boundary, stated plainly

Harness AI Security (per the capability matrix, §3) needs to observe live
AI/API traffic — that means it needs a network vantage point. ModelForge's
Electron main process making direct `fetch()` calls to `api.openai.com` etc.
gives Harness (or any third party) no natural observation point without
either (a) instrumenting the desktop app itself to phone home traffic
metadata, which this task explicitly does not authorize and which would be a
significant new privacy surface for a clinical tool, or (b) routing through
infrastructure the *institution* already operates and controls, which is
exactly what an AI gateway is. Option (b) is the only one consistent with
"Harness must not become... a hidden recipient of prompts or patient
information" — the institution's gateway is where policy, logging, and (if
chosen) Harness observation apply, under the institution's own contract and
configuration, never ModelForge phoning out to Harness directly.

### 5.4 What a real implementation's tests would need to cover

(For when/if an institution decides to build this — not run in this pass,
since there's no real gateway to test against.)

- Local provider send with gateway configured and required → **must not**
  route through the gateway (proves the bypass in the table above).
- Remote provider send with no gateway configured → direct-to-provider,
  identical to today's behavior (regression guard).
- Remote provider send with gateway configured and required, gateway
  reachable → routes through gateway, transmission preview shows the gateway
  URL as the destination.
- Remote provider send with gateway configured and required, gateway
  **unreachable/times out** → the send fails visibly; **assert no fallback
  request is ever made directly to the provider** (the specific negative
  case this task calls out explicitly).
- Remote provider send with gateway configured but **not** required (opt-in,
  not mandated) → user's own choice governs, exact mechanism TBD by whoever
  designs the Settings UI for this — not specified further here since it's
  downstream of an institutional decision this document doesn't make.

---

## 6. Track C — Future shared-backend operations (design only, backend not built)

`docs/SHARED_BACKEND_DESIGN.md` specifies the client-server contract for an
optional, institution-operated `PatientCasesBackend` — **no server
implementation exists yet** (§1.6). Everything below describes how Harness
CD/monitoring *could* apply to that backend once someone builds it and an
institution deploys it. None of it is actionable today.

| Operational concern | How Harness CD/monitoring would apply | Source constraint from `SHARED_BACKEND_DESIGN.md` |
|---|---|---|
| Deployment approvals | A CD pipeline stage gated on manual approval before promoting a build to the institution's server | §1: bring-your-own-server — Harness would deploy to infrastructure the institution owns, never a ModelForge-operated environment |
| Health checks | Standard liveness/readiness probes against the server's HTTP API | §3 already specifies the API surface (`GET /cases`, etc.) a health check would target |
| Schema migration gates | A pipeline stage that runs and verifies a migration before traffic shifts, blocking promotion on failure | §6's migration path is already designed idempotent ("safe to re-run after a partial failure without duplicating records") — a Harness gate would enforce that verification runs, not invent new migration logic |
| Rollback | CD stage with a defined previous-known-good deployment to revert to | §6: "no ongoing dual-write" — rollback of the *server* is a standard blue/green or versioned-deployment concern; rollback of *client data* was deliberately designed as explicit and user-initiated, not automatic, and that stays true regardless of what deploys the server |
| Encrypted backup verification | A scheduled pipeline stage that runs a restore-drill against a synthetic dataset and asserts success | Not yet specified in `SHARED_BACKEND_DESIGN.md` — would need its own design before a Harness stage could gate on it |
| Disaster-recovery exercises | Scheduled pipeline runs exercising a documented DR runbook | Same — DR runbook itself doesn't exist yet; Harness can schedule/gate an exercise, not substitute for having one |
| PHI-safe metrics and traces | Dashboards fed by counts/latencies/error rates only — **never case content, prompts, medication lists, or patient identifiers** | §8 of `SHARED_BACKEND_DESIGN.md`'s security-review list already flags "the shared-backend client must never log request/response bodies... matching the standard already enforced in `audit-log-store.ts` and `medical-safety.ts`" — any Harness-visible telemetry must honor that exact same boundary |
| Synchronization failure alerts | Alert on the `SharedBackendUnavailableError` rate (§3: "never collapsed to `[]`" — failures are already designed to be loud, distinguishable events, not silent empty results) | Directly maps to an alertable signal already designed into the client contract |
| Authentication/policy-service availability | Standard uptime monitoring of the IdP and (this engagement's) policy mechanism | `policy-store.ts` (`docs/CENTRAL_POLICY.md`) is a **local file check today, not a network service** — monitoring "policy-service availability" only becomes meaningful if/when policy distribution becomes networked (§4.3's later stages), not for the current local-file mechanism |
| Audit-ingestion health | Alert on audit-shipping queue depth/failure rate | §7 of `SHARED_BACKEND_DESIGN.md`: "a shipping failure... queues for retry — it never drops the local record" — an ingestion-health alert would watch that queue, consistent with the design's own "never silently lose the local record" guarantee |
| Incident response | A documented runbook + Harness-tracked service ownership (IDP module, if adopted) | Net-new — no incident-response runbook exists for a backend that doesn't exist yet |

**Explicit exclusion, restated from this task's instruction**: no AI SRE
instrumentation captures case content, prompts, medication lists, or patient
identifiers, at any point in this design. Every metric/trace/alert above is
scoped to counts, rates, timing, and error *categories* — the same discipline
`audit-log-store.ts` already enforces for its own event `detail` field
(documented as non-clinical by convention, never enforced at the type level —
a real gap noted in `docs/ENTERPRISE_READINESS_ASSESSMENT.md` §2.4 that any
future telemetry layer should not repeat).

---

## 7. PHI threat analysis

**What Harness could plausibly touch, and what it never should, per module:**

| Module | What flows to Harness (Cloud) if adopted as designed here | PHI risk | Mitigation designed into this document |
|---|---|---|---|
| CI (Track A) | Source code, test output, build logs, SBOMs | None — no runtime/patient data ever enters a CI job; all fixtures in this repo are synthetic by standing convention (`docs/DEVELOPMENT.md`) | No test reads a real userData directory; already true today (`electron-mock.ts`'s isolated temp dirs) |
| CD (Track C, future) | Deployment manifests, health-check responses (counts/status, not content) | Low if the design in §6's table is followed; **high if a metrics/trace pipeline is ever pointed at anything beyond counts/rates** | §6's explicit exclusion — no case content, prompts, medication lists, or patient identifiers in any Harness-visible telemetry, ever |
| STO / SAST / SCA | Source code and dependency manifests only | None | Same as CI |
| SSCA | Dependency manifests, build provenance metadata | None | Same as CI |
| AI Test Automation | Would be recorded UI interactions — **if adopted at all**, must use synthetic-only test data, same standing rule as every other test | None if synthetic-only; **real risk if ever pointed at a session with real clinical content** | Rejected as unproven for this app's actual test surface (§3) — moot until/unless proven otherwise |
| AI Security (Track B) | Traffic *at the institution's own gateway* — never the Electron renderer or main process directly | **This is the one module where the risk is real and non-hypothetical if implemented carelessly** — an AI-traffic-observability tool is, definitionally, built to see prompts/responses | Track B's entire design exists to keep ModelForge itself from ever being the thing Harness observes — the institution's gateway is the boundary, its logging/retention policy is the institution's own contractual decision with Harness (or whichever AI Security path they choose), not something this repository's code can enforce |
| AI SRE (Track C, future) | Alert metadata, incident timelines | Low if §6's exclusion is followed; same class of risk as CD's metrics if violated | Same exclusion as CD |
| CACM / FME / IDP | Billing metadata / flag evaluation booleans / service catalog metadata | None — none of these touch patient or clinical data by their nature | N/A |

**The one structural safeguard that applies regardless of which modules are
adopted**: ModelForge's own logging discipline (verified in
`docs/ENTERPRISE_READINESS_ASSESSMENT.md`'s PHI inventory — `logger.ts`,
`audit-log-store.ts`, and `medical-safety.ts` never log message/case content,
only identifiers and outcomes) does not change because Harness tooling exists
somewhere in the delivery pipeline. Nothing in this document asks ModelForge's
own code to log anything it doesn't already log.

---

## 8. Required institutional decisions

Nothing below can be resolved by this document or by more source-reading —
each is a real decision for whoever operates ModelForge institutionally:

1. **Harness Cloud vs. Self-Managed Enterprise Edition (SMP).** The single
   highest-leverage decision (§3's Delegates row) — determines whether any
   repository/build data ever reaches a third-party SaaS control plane at
   all. Should be made *before* Stage 1 of Track A, not discovered
   retroactively.
2. **Windows/macOS Harness Cloud runner access.** Confirmed to require
   contacting Harness Support for enablement, not self-service (§11's CI
   source) — directly affects whether Track A's native-addon 3-OS job can
   move to Harness at all, or must stay on GitHub Actions indefinitely.
3. **STO/SAST/SCA/SSCA/AI-Test/AI-Security tier and pricing.** Several plan
   tiers were not confirmable from public docs (marked throughout §3) — needs
   a real Harness sales conversation before budgeting any of this.
4. **Whether an AI gateway gets built and operated at all** (Track B's
   entire premise) — a genuinely large institutional undertaking (procuring
   or building gateway infrastructure, its own security review, its own
   contractual terms with whichever LLM providers it fronts) that this
   document deliberately does not commit anyone to.
5. **Whether/when the shared Patient Cases backend (Track C's premise) gets
   built at all** — `docs/SHARED_BACKEND_DESIGN.md` is a design, not a
   commitment; Track C is entirely contingent on that separate decision.
6. **Cosign/Vault provisioning**, if SSCA's signing feature is adopted — the
   only supported KMS for non-keyless signing per current docs.

---

## 9. Rollback strategy

- **Track A (CI/CD), Stages 0–3**: no rollback needed — GitHub Actions is
  never disabled, so "rollback" is simply not acting on Harness's output.
  Stage 4 rollback: re-enable `ci.yml`/`release.yml` (kept in the repo, never
  deleted) and revoke the Harness pipeline's release-publish permissions.
- **Track B (AI gateway)**: disabled by default (`aiGatewayUrl`/
  `aiGatewayRequired` unset); rollback is unsetting those two values, which
  reverts every remote-provider call to today's direct-to-provider behavior
  with no data migration involved.
- **Track C (shared-backend CD)**: not applicable yet — no backend exists to
  roll back. Once built, rollback is scoped to the backend service itself
  (a CD concern for whoever builds it), not to ModelForge's client, which
  already treats `PatientCasesBackend` as a swappable, non-destructive
  interface (confirmed in `patient-cases-store.ts`'s existing backend
  registry — switching backends never deletes the previously-active one's
  data).
- **Repository-side config (this task's actual deliverable)**: this document
  and the pipeline template added under §10 are pure documentation/config —
  `git revert` is sufficient rollback for either, with zero runtime impact
  since nothing here changes clinical or IPC behavior.

---

## 10. Repository-side Harness CI pipeline (safe subset, verified schema)

**File**: [`.harness/pipeline.yaml`](../.harness/pipeline.yaml)

**Schema verification**: a documented, stable Harness Pipeline YAML schema
exists (`github.com/harness/harness-schema`, referenced from
[Write pipelines in YAML](https://developer.harness.io/docs/platform/pipelines/harness-yaml-quickstart/)),
with a confirmed minimal structural example (`pipeline: → stages: → stage: →
spec: execution: steps:`). The pipeline file is written against that verified
structure — every step is a plain `Run` step executing the exact same command
already verified against current `package.json` scripts (§1.1/§4.1), never a
guessed Harness-specific action.

**What this pipeline deliberately does NOT do**:
- **Does not publish releases** — no `electron-builder --publish`, no GitHub
  Release creation, matching this task's explicit instruction.
- **Does not replace `.github/workflows/*.yml`** — both keep running.
- **Does not include the 3-OS native-addon load test** — §4.2 flags that as
  needing verified Windows/macOS Harness Cloud access (an unresolved
  institutional decision, §8 item 2) before it can be written honestly;
  including it here with an unverified runner assumption would be exactly
  the kind of invented value this task prohibits.
- **Contains no secrets, tokens, or organization identifiers** — every
  Harness-specific identifier (`org`, `project`, `connectorRef`) is a
  clearly-marked placeholder. **This file cannot run as-is.**

### Configuration checklist (fill in before use — do not invent these values)

| Placeholder | What it is | Where it comes from |
|---|---|---|
| `<HARNESS_ORG_ID>` | Harness organization identifier | Created when an institution provisions a Harness account (§8 item 1) |
| `<HARNESS_PROJECT_ID>` | Harness project identifier | Created within that organization |
| `<GITHUB_CONNECTOR_REF>` | A Harness Connector pointing at this GitHub repository | Configured in Harness UI/API after repository access is granted — **not something this document can populate, since doing so would require connecting an external account, which this task explicitly does not authorize** |
| `<BUILD_INFRA_CONNECTOR_REF>` | Which build infrastructure runs these steps (Harness Cloud vs. a self-hosted Delegate) | Depends on §8 item 1's Cloud-vs-SMP decision |

**What was and was not validated for this file**: YAML syntax was checked
with a plain YAML parser (§13, Verification) — it is syntactically valid YAML
and structurally matches the documented minimal pipeline shape described
above. **It was not validated against Harness's live schema validator or a
real Harness account**, since doing so would require exactly the
account/credential access this task does not authorize. Treat it as a
**reviewed starting template**, not a proven-working pipeline — the
configuration checklist above is what stands between this file and a real
first run.

---

## 11. Harness capability research — sources

Every capability claim in §3 and elsewhere in this document traces to one of
these official sources, retrieved during this assessment (August 2026):

1. **CI**: https://developer.harness.io/docs/continuous-integration/development-guides/ci-nodejs/ ; https://developer.harness.io/docs/open-source/pipelines/samples/rust/ ; https://developer.harness.io/docs/continuous-integration/use-ci/set-up-build-infrastructure/use-harness-cloud-build-infrastructure/
2. **CD**: https://developer.harness.io/docs/continuous-delivery/manage-deployments/deployment-concepts/ ; https://developer.harness.io/docs/continuous-delivery/deploy-srv-diff-platforms/kubernetes/kubernetes-executions/create-a-kubernetes-blue-green-deployment/
3. **STO**: https://developer.harness.io/docs/security-testing-orchestration/overview/ ; https://developer.harness.io/docs/security-testing-orchestration/whats-supported/scanners/
4. **SAST/SCA**: https://developer.harness.io/docs/security-testing-orchestration/harness-security-scanners/sast/ ; https://developer.harness.io/docs/security-testing-orchestration/harness-security-scanners/sca/ ; https://www.harness.io/blog/qwiet-ai-is-now-harness-sast-and-sca
5. **SSCA**: https://developer.harness.io/docs/software-supply-chain-assurance/get-started/key-concepts/ ; https://developer.harness.io/docs/software-supply-chain-assurance/open-source-management/sbom-github-actions/ingest-sbom-with-github-actions/ ; https://developer.harness.io/docs/software-supply-chain-assurance/artifact-security/slsa/generate-slsa/
6. **AI Test Automation**: https://www.harness.io/products/ai-test-automation ; https://developer.harness.io/docs/ai-test-automation/suites/playwright-builds/
7. **AI Security**: https://www.harness.io/products/ai-security ; https://developer.harness.io/docs/ai-security/
8. **AI SRE**: https://developer.harness.io/docs/ai-sre/get-started/overview/ ; https://developer.harness.io/docs/ai-sre/resources/whats-supported/
9. **Cloud & AI Cost Management**: https://developer.harness.io/docs/cloud-cost-management/product-behaviour/ ; https://developer.harness.io/docs/cloud-cost-management/provider-integrations/ai-providers/openai/
10. **Feature Management & Experimentation**: https://developer.harness.io/docs/feature-management-experimentation/split-to-harness/ ; https://developer.harness.io/docs/feature-management-experimentation/getting-started/split-and-harness/ ; https://developer.harness.io/docs/feature-management-experimentation/sdks-and-infrastructure/server-side-sdks/nodejs-sdk/
11. **Internal Developer Portal**: https://developer.harness.io/docs/internal-developer-portal/overview/ ; https://www.harness.io/products/internal-developer-portal
12. **Delegates / Self-Managed Enterprise Edition**: https://developer.harness.io/docs/platform/delegates/delegate-concepts/delegate-overview/ ; https://developer.harness.io/docs/self-managed-enterprise-edition/smp-overview/ ; https://developer.harness.io/docs/self-managed-enterprise-edition/self-managed-helm-based-install/harness-helm-chart/
13. **Pipeline YAML schema**: https://developer.harness.io/docs/platform/pipelines/harness-yaml-quickstart/ ; https://github.com/harness/harness-schema
14. **Pricing/free-tier**: https://www.harness.io/pricing (the "no credit card required" claim on this page could not be independently confirmed by direct fetch — treated as unverified, not asserted as fact anywhere in this document)

**What could not be verified from public documentation** (stated honestly,
not filled in with a plausible guess): exact plan/tier names and pricing for
STO, SAST/SCA, SSCA, AI Test Automation, AI Security, and AI SRE; whether
AI Security's discovery mechanism requires a Harness-operated proxy or can
integrate with an institution's existing gateway; whether AI cost tracking
specifically is included in CACM's Free-Forever tier; whether the "basic
feature flags" in Harness's Free plan are the same entitlement as the full
FME/experimentation product. Each of these is called out at its point of use
above rather than resolved by inference.

---

## 12. Authorization boundary — what was and was not done

Per this task's explicit constraints:

**Done** (repository-side only):
- Read-only inspection of this repository's CI/CD/packaging configuration.
- Read-only web research against official Harness documentation (§11).
- This document.
- `.harness/pipeline.yaml` — a config **template**, not a working pipeline
  (§10 explains exactly what stops it from running as-is).

**Explicitly NOT done, per this task's authorization boundary**:
- No Harness account was created or connected.
- No credentials, tokens, connectors, or organization identifiers were
  generated or invented — every Harness-specific identifier in
  `.harness/pipeline.yaml` is a literal `<PLACEHOLDER>`.
- No external service was contacted other than fetching public Harness
  documentation pages (read-only, no authentication).
- No AI gateway was built or deployed (Track B is design-only, §5.1
  explains why).
- No shared backend was built or deployed (Track C is design-only, §6
  explains why — it doesn't exist to deploy in the first place).
- No existing GitHub Actions workflow (`ci.yml`, `release.yml`,
  `dependabot.yml`) was modified, disabled, or removed.
- Nothing was committed or pushed — per this task's own instruction and the
  standing rule for this engagement.

---

## 13. Verification

| Check | Result |
|---|---|
| `.harness/pipeline.yaml` — YAML syntax | Parsed successfully with a plain YAML parser (`js-yaml`/`PyYAML`-equivalent check via Node's `yaml` package, no schema errors) — see exact command in the final response |
| `.harness/pipeline.yaml` — Harness live schema validation | **Not run** — requires a Harness account/API access this task does not authorize. Structural comparison against the documented minimal example (§10) was done manually instead |
| Every command referenced in §1/§4 | Cross-checked against current `ci.yml`, `release.yml`, `docs/DEVELOPMENT.md`, and each `package.json`'s `scripts` block — not re-derived from memory |
| Repository secret scan (new files) | `docs/HARNESS_INTEGRATION.md`, `.harness/pipeline.yaml` — manually reviewed; contain only placeholders, public URLs, and prose. No token/key/credential-shaped strings |
| `git diff --check` | Run — see final response for result |
| Markdown links | Internal cross-references (`../.harness/pipeline.yaml`, `docs/CENTRAL_POLICY.md`, etc.) manually verified to point at files that exist in this repository |
| `graphify update .` | Run after all changes — see final response |

---

## 14. Summary and recommendation

**Is Harness appropriate for ModelForge?** Partially, and not urgently. The
existing GitHub Actions setup is mature and already covers most of what
Harness CI/CD would provide — there is no functional gap forcing a migration.
The genuinely compelling, currently-open gaps are narrower than "adopt
Harness": **SAST and secret scanning** (§3, nothing fills this today) and,
if an institution ever centralizes remote-provider access, **AI Security at
a gateway boundary** (Track B) are the two places Harness would add real,
non-overlapping value. Everything else in the matrix (§3) is either not yet
applicable (CD, AI SRE — nothing running to deploy/monitor), disqualified by
scale/licensing (IDP), or a genuine unknown pending a sales conversation
(exact tiers for STO/SSCA/AI Test/AI Security).

**The single highest-leverage decision** is not a Harness module choice at
all — it's Harness Cloud vs. Self-Managed Enterprise Edition (§8 item 1),
since that determines whether *any* of this touches a third-party SaaS
control plane before a single pipeline runs.
