# Clinical AI Gateway

`ClinicalAiGateway` (`server/src/ai-gateway/gateway.ts`) is the single, centralized path by which
patient data reaches an AI model and a model's output reaches a clinician. No UI, plugin, or
provider adapter is permitted to reach a patient database, DICOM store, object store, vector
index, or service credential directly — every path runs through this class.

**This is clinical decision support, not a diagnostic device.** Every output is an unsigned draft
until a licensed clinician accepts, corrects, rejects, or escalates it. Nothing in this system
diagnoses, prescribes, discharges, orders treatment, contacts a patient, or silently alters a
medical record. This document describes what was built, is deliberately explicit about what was
not, and does not claim regulatory certification of any kind — see "Compliance applicability
matrix" below.

## The architecture decisions this was built against

- **Reuse, don't replace.** Tenant context (`server/src/tenant-context.ts`), schema-per-tenant
  clinical storage (`provision_tenant_clinical_schema`), the existing IAM policy engine
  (`routes/guards.ts`), the audit/provenance chain (`store/audit-store.ts`), the imaging
  architecture (`docs/IMAGING.md`), and `packages/contracts` are all reused as-is. Nothing here
  duplicates them.
- **Two separate authorization questions, two separate modules.** "Can this user perform this
  action" is the existing IAM policy engine (`aiGateway:invoke`/`aiGateway:review`/
  `aiGateway:viewAuditTrail`/`aiGateway:manageProviders`/`aiGateway:manageTenantSettings`/
  `aiGateway:manageConsent` in `domain/action-catalog.ts`). "May this patient's data go to this
  provider" is a separate data-governance layer (`ai-gateway/policy.ts`) that IAM never reasons
  about. Conflating them was a deliberate anti-goal.
- **Global catalog, tenant-scoped everything else.** The provider/model catalog
  (`public.ai_providers`/`public.ai_provider_models`, migration 018) is global, cross-tenant,
  PHI-free control-plane data — the same pattern `organizations` itself already follows. Every
  patient-linked resource (consent, request envelopes, outputs, reviews, safety events) lives in
  each tenant's own schema, provisioned by `provision_tenant_ai_gateway_tables`.
- **No new break-glass mechanism.** The existing IAM break-glass grant (`routes/break-glass.ts`)
  already unlocks whichever actions an org's emergency policy includes — any `aiGateway:*` action
  is break-glass-eligible the moment an org's policy lists it. Nothing new was built for this.
- **No new server-side resource orchestrator was imported from the Electron app.**
  `app/src/resource-orchestrator.ts` is single-user, has no tenant concept, and runs in a
  different process/runtime — it cannot be imported into this multi-tenant Fastify server. A new,
  smaller, tenant-aware admission-control module (`ai-gateway/admission.ts`) was built to the same
  design (priority queue, leases, TTL reclamation) instead of forcing an incompatible import.
- **Structured output, never chain-of-thought.** Every provider is asked to answer in a small
  tagged format (`SUMMARY`/`EVIDENCE`/`UNCERTAINTY`/`FOLLOWUP`/`ABSTAIN`) and the schema has no
  `reasoning`/`chainOfThought` field anywhere. A model that ignores the format doesn't get its
  free-form answer discarded — it becomes the whole `summary`, with `formatCompliant: false`
  recorded as a trust signal, never a fabricated structure.
- **Prompt versioning, alongside model versioning.** `AiOutput.modelVersion` recorded which
  provider model produced an output from day one; `AiOutput.promptVersion`
  (`ai-gateway/prompt-registry.ts`) now does the same for the gateway's own system-prompt text —
  an append-only, immutable-per-version registry, so "rollback" is just pinning an older version,
  never editing shipped prompt text in place.
- **Multi-model routing is opt-in, additive, and never widens authorization.** `providerModelId`
  on a submit/preview request is now optional. Supplying it is unchanged from before this existed:
  exactly that one model, no fallback. Omitting it runs `ai-gateway/model-router.ts`'s
  `rankEligibleProviderModels` (validated-before-canary, quality-before-hosting, local/on-premises-
  before-cloud, lower-cost first, deterministic tie-break) over every enabled candidate, then
  `submitRequest` tries each in ranked order — falling back to the next on a retryable outcome
  (admission rejection, provider failure, or an authorization denial, since eligibility filtering
  is only a pre-check of what `evaluateGatewayAuthorization` will actually decide), stopping
  immediately on a non-retryable one (content-blocked, case-not-found). Each attempt is its own
  real, immutable `AiRequestEnvelope` — a failed attempt is never deleted or hidden. Ranking also
  factors in real production quality now: a candidate's recent clinician-acceptance rate
  (`eval-harness/production-monitor.ts`, fetched per candidate in `gatherRoutingCandidates`)
  outranks hosting/cost preference but never overrides validation status, bucketed
  (good/fair/poor) rather than by raw rate so statistical noise never reorders two models with
  indistinguishable real performance, and neutral (never penalized) below `MIN_QUALITY_SAMPLE_SIZE`
  (20) reviewed outputs so a newly-approved model isn't starved of traffic for lacking history yet.
  Not implemented: true concurrent-load balancing (this ranks a static snapshot, not current load)
  and latency-based ranking (no latency telemetry exists anywhere in this codebase yet).
- **Every included case field is cited, not only clinical notes.** `data-minimization.ts`'s
  `resourceRefs` originally only produced citations for individually-identified resources
  (clinical notes); scalar fields (labResults, vitalSigns, etc. — most of most prompts) produced
  none. A synthetic `patientCaseField` citation now covers those too, with a matching read-time
  re-authorization branch in `routes/ai-gateway.ts`.

## Where the code lives

| Concern | File |
|---|---|
| Shared contracts (zod schemas) | `packages/contracts/src/ai-gateway.ts` |
| Migration (global catalog + tenant tables) | `server/migrations/018_clinical_ai_gateway.sql` |
| IAM actions | `server/src/domain/action-catalog.ts` |
| Data-governance authorization | `server/src/ai-gateway/policy.ts` |
| Content/injection/secret scanning | `server/src/ai-gateway/content-scanner.ts` |
| Identifier redaction | `server/src/ai-gateway/redaction.ts` |
| Data minimization (task allowlists) | `server/src/ai-gateway/data-minimization.ts` |
| Tenant-aware admission control | `server/src/ai-gateway/admission.ts` |
| Provider client adapters | `server/src/ai-gateway/provider-client.ts` |
| Model response parsing/validation | `server/src/ai-gateway/response-validation.ts` |
| Orchestration (the 15-step lifecycle) | `server/src/ai-gateway/gateway.ts` |
| Global provider/model catalog store | `server/src/store/ai-provider-registry-store.ts` (+ `in-memory-*`) |
| Tenant-scoped gateway store | `server/src/store/ai-gateway-store.ts` (+ `in-memory-*`) |
| HTTP routes | `server/src/routes/ai-gateway.ts` |

## The 15-step request lifecycle

`ClinicalAiGateway.submitRequest()` implements the full lifecycle end to end; `previewRequest()`
implements steps 1-2 read-only; `recordReview()` implements step 13.

1. **Select scope** — the caller's own `SubmitAiRequestInput` (case, purpose of use, provider/model, requested data categories).
2. **Preview** — `previewRequest()` reports exactly which data categories, resource count, and provider/model info would be shared, with zero side effects (no consent, request, or output created).
3. **Authorize** user/patient/case/resources/purpose/model — `evaluateGatewayAuthorization()`.
4. **Validate** consent/org-policy/provider-approval/retention — same call, fed real consent, provider, provider-model, and tenant-settings rows.
5. **Minimize** to exactly what the purpose of use allows — `minimizeForTask()`, a static per-purpose allowlist (`TASK_DATA_CATEGORIES`), never "send everything and hope the model ignores it."
6. **Redact/de-identify** — folded into step 5; every section `minimizeForTask` builds is already passed through `redactIdentifiers()` before this class ever sees the text.
7. **Scan** for malicious instructions/secrets/unsupported content — `scanForUnsafeContent()`, re-run on the fully-composed, already-minimized/redacted text.
8. **Create** a tenant-bound, time-limited request envelope (15-minute default `expiresAt`) — `gatewayRepo.createRequest()`.
9. **Schedule** via tenant-aware admission control — `AiInferenceAdmission.withLease()`, priority-ranked (interactive > imaging-inference > background-summary > indexing = de-identification > evaluation > administrative).
10. **Validate/normalize** the model's response — `parseModelResponse()`/`validateModelResponse()`.
11. **Apply clinical-safety/DLP checks** — folded into step 10; the same content scanner re-runs on the OUTPUT and a flagged output is entirely withheld (never partially surfaced) and forced into `abstained: true`.
12. **Present as an unsigned draft** — `gatewayRepo.createOutput()`; `AiOutput.reviewStatus` defaults to `"unreviewed"` at the schema layer.
13. **Record the clinician's decision** — `recordReview()` (accept/reject/correct/escalate), a separate call since review happens after a draft already exists. A review is immutable: `createReview` throws on a duplicate (`UNIQUE(output_id)` at the DB layer too) — correcting an already-reviewed output means a new request/output, never an edited review.
14. **Provenance/audit** — every store call above takes an `AuditActor` and writes its own audit row; `recordTransformation` captures minimization/redaction/content-scan metadata against the request.
15. **Delete transient data per retention policy** — see `runMaintenanceSweep()`'s own doc comment: there is no separate transient-prompt buffer to purge, because this pipeline never persists raw prompt/output text anywhere except the structured `AiOutput` fields that are supposed to hold it. What the sweep does do: propagate consent expiry immediately, and reclaim any admission lease whose holder crashed mid-inference.

## Effective PHI permission — the hard rails

`effectivePhiPermitted = providerModel.phiPermitted && tenantSettings.phiAllowed` — an AND, never
an OR; a tenant can never widen what the global catalog itself permits. Two additional rails are
never overridable by any tenant setting:

- A model whose catalog entry admits `trainingUseAllowed: true` can **never** receive PHI, full stop.
- A model that retains prompts or outputs (`retainsPrompts`/`retainsOutputs`) without a
  `zeroRetentionSupport` guarantee can **never** receive PHI.

Every governance flag defaults to the safe (closed) value at three independent layers: the zod
schema (`.default(false)`), the SQL migration (`DEFAULT FALSE` + CHECK constraints), and the
policy-evaluation code itself — not just a UI toggle.

`policy.ts` also checks the *provider's* own kill switch and operational status (not just the
model row) — engaging a provider's kill switch blocks every model under it immediately, on the
very next authorization check, with no cache or background sweep to wait on.

## Data minimization: how "includesIdentifiers" is decided

Pattern-based redaction (`redactIdentifiers`) is best-effort — it catches structured shapes
(email/phone/SSN/MRN/DOB) but cannot guarantee a free-text clinical narrative carries no
identifiers. Rather than let a redaction pass silently downgrade a request to "de-identified,"
`gateway.ts` treats **any non-empty data selection** as `includesIdentifiers: true` — the only
case reported as not including identifiers is an empty selection. This is intentionally
conservative: "never imply that automated de-identification guarantees anonymity" is enforced in
code, not left to a comment.

## Admission control

`AiInferenceAdmission` (`server/src/ai-gateway/admission.ts`) is a new, tenant-aware,
priority-ranked admission-control component — see that file's own doc comment for exactly why it
duplicates the *design* of `app/src/resource-orchestrator.ts` rather than importing it. VRAM
budgeting defaults to 0 (no local-GPU admission enforced) until a deployment explicitly configures
a real budget; there is no server-side GPU/hardware-detection module in this codebase today.
`sweepExpired()` reclaims any lease whose holder crashed without releasing it and is wired to a
60-second timer in `index.ts`, process-wide across every tenant.

## HTTP surface

See `server/src/routes/ai-gateway.ts`. Every route reuses the existing `patientCase` resource
identity (`organization:{orgId}/patientCase:{caseId}`) for its IAM check, so an org's existing
case-level policy conditions (owner/assigned/department) apply to AI actions on that case without
any additional configuration. Idempotency-Key support (`routes/idempotency.ts`, already used by
`cases.ts`/`sessions.ts`) is reused as-is on the request-submission route — a retried submission
with the same key replays the original response rather than creating a second request envelope.

Every non-2xx outcome from `submitRequest` (authorization-denied → 403, content-blocked → 422,
admission-rejected → 503, provider-failed → 502, case-not-found → 404) is a real, expected
governance/safety gate reported as structured JSON — never a 500.

## What's implemented and tested

- Full 15-step lifecycle, unit-tested end to end against in-memory stores and a deterministic
  provider double (`server/src/ai-gateway/gateway.test.ts`, 18 tests): happy path, every
  authorization denial reason, content-blocking on both a secret-shaped string and a
  prompt-injection pattern in source data, admission rejection, provider failure, output-side
  secret/injection withholding, abstention, review immutability, and the maintenance sweep.
- HTTP-level integration tests (`server/src/routes/ai-gateway.integration.test.ts`, 6 tests): full
  happy path over real `app.inject()` requests, an authorization-denied 403, an engaged kill
  switch blocking the very next request, Idempotency-Key replay, unauthenticated rejection, and
  identical 404s for a cross-tenant case vs. a nonexistent one.
- Policy-evaluation unit tests (`server/src/ai-gateway/policy.test.ts`, 23 tests) covering every
  denial reason, including the provider-level kill-switch/operational-status checks.
- Every other module (content scanner, redaction, data minimization, admission, response
  validation, both stores) has its own dedicated unit test file.
- A real, authenticated OpenAI-compatible adapter for verified vLLM and
  `llama-server` deployments. The adapter checks served model identity and
  never includes provider response bodies in errors.

## What's deliberately not implemented — disclosed gaps, not fake safeguards

- **No idempotency-key deduplication at the domain layer.** The HTTP-level `Idempotency-Key`
  header mechanism (`routes/idempotency.ts`) is reused and does work for a client retrying the
  exact same HTTP request, but `ai_requests` has no `idempotency_key` column — a caller that
  retries via a fresh HTTP request (different Idempotency-Key, or none) after a timeout can create
  a second, independent request envelope. Adding true domain-level dedup needs a migration.
- **No automatic retry/backoff on provider failure.** A provider error is surfaced as
  `provider-failed` immediately; nothing here retries with jitter.
- **No streaming.** Every provider call is request/response; "stream responses where clinically
  appropriate" is not implemented.
- **No tenant-safe retrieval/RAG.** There is no vector index anywhere in this codebase (confirmed
  during the architecture survey for this work) — nothing to make tenant-safe yet.
- **No pixel-aware model adapter or DICOM SR/SEG output generation.** Imaging-scoped requests are
  implemented, but the provider receives only an authorized manifest for an approved
  de-identification job. It never receives raw DICOM bytes, object keys, viewer tokens, or pixel
  data. The manifest explicitly tells the model not to infer visual findings. A validated frame
  extraction/multimodal adapter and immutable DICOM SR/SEG writer remain separate clinical work.
- **No cloud/external provider actually exercised.** `HttpProviderClient` is a real,
  production-shaped OpenAI-chat-completions-style adapter, but this environment has no external
  network egress or provider credentials to test it against — same disclosed posture as imaging's
  `ProxyDicomwebAdapter`.
- **The global provider/model catalog's tenant boundary is imperfect by construction.** Catalog
  management routes are gated on `aiGateway:manageProviders` in the *caller's own organization*,
  but the catalog itself is shared across every tenant. Any organization whose administrator holds
  that permission can affect what every other tenant reads. A real multi-tenant deployment should
  restrict this permission to a small, trusted set of platform-admin accounts via policy until a
  genuinely separate platform-admin authentication path exists.
- **No automated shadow/canary traffic or longitudinal production drift monitor.** The synthetic
  offline evaluation harness and baseline-regression gate are implemented, but the application
  does not duplicate live requests to a shadow model or automatically change rollout state.
- **`callerRoles`/`AiProviderTenantSettings.allowedRoles` are IAM group ids, not a separate
  human-readable role taxonomy.** This codebase has no such taxonomy elsewhere; reusing group ids
  avoids inventing a parallel concept, but means role-based model approval is only as
  fine-grained as an org's existing group structure.

## Compliance applicability matrix

**This is an engineering-team applicability assessment, not a legal opinion and not a
certification of any kind.** Every row below needs review by qualified privacy/security/legal/
regulatory counsel before this system is used with real patient data in any jurisdiction. Do not
treat this table as evidence of compliance.

| Framework | Applicability to what was built | Status |
|---|---|---|
| HIPAA / HITECH (US) | Applies if any tenant is a US covered entity/business associate handling PHI. Technical controls relevant here: access control, audit controls, encryption, minimum-necessary/data-minimization, breach notification. | Partially addressed in code (tenant isolation, audit chain, data minimization, default-deny PHI); no BAA process, breach-notification workflow, or formal risk analysis exists. **Needs legal review.** |
| GDPR (EU) | Applies if any data subject is in the EU. Relevant: lawful basis/consent, data minimization, right to erasure, DPA with any processor (including an AI provider), cross-border transfer rules. | Consent model exists (`AiConsent`, versioned/revocable/purpose-specific) but is not validated against GDPR's specific lawful-basis and erasure requirements. Cross-border transfer logic (`hostingRegion`/`processingLocation`) is tracked in the catalog but not enforced against any specific legal mechanism (SCCs, adequacy). **Needs legal review.** |
| EU AI Act | Clinical decision-support AI is likely a high-risk AI system under the Act once in force for this use case. Relevant: risk management, human oversight, technical documentation, logging, transparency to affected persons. | Human-in-the-loop is structurally enforced (unsigned draft until clinician review); the safety-event/audit trail gives a real logging foundation. No formal AI Act conformity assessment, technical documentation package, or CE-marking process exists. **Needs regulatory review — do not deploy in the EU on this basis alone.** |
| FDA (US) — Clinical Decision Support / medical device software | The system is designed to stay on the CDS-exemption side of 21st Century Cures Act criteria (transparent basis, clinician can independently review, not the sole basis for a decision) rather than as a regulated medical device. | This is a design intent enforced by the code's own safety rails (citations, evidence separation, mandatory review), not an FDA determination. Whether any specific configured use case actually qualifies for the CDS exemption is a **regulatory determination that has not been made and requires qualified review before clinical use.** |
| State/local health data laws | Vary by jurisdiction (e.g. 42 CFR Part 2, state genetic-privacy or mental-health-specific statutes). | Not assessed at all — **jurisdiction-dependent, needs legal review per deployment.** |
| NIST AI RMF | Voluntary framework (govern/map/measure/manage). | Partially aligned in spirit (risk-aware design, human oversight, logging) but no formal RMF mapping/gap-assessment exercise has been performed. |
| ISO 14971 (medical device risk management) | Applies if any configured use case is ultimately determined to be a regulated device. | Not performed — no formal risk management file exists. |
| IEC 62304 (medical device software lifecycle) | Same conditional applicability as ISO 14971. | Not performed — this codebase's own SDLC (tests, code review) is real but was not built to IEC 62304's process/documentation requirements. |
| IEC 62366-1 (usability engineering) | Applies to the clinician-facing Clinical AI workspace. | UI safety states and explicit review controls exist; no formal usability-engineering study or summative validation has been performed. |
| ISO 13485 (QMS for medical devices) | Same conditional applicability as ISO 14971/62304. | Not in place — this is a software engineering project, not a certified QMS. |
| ISO/IEC 27001 / 27701 | Information security / privacy information management. | Not certified. Individual controls this build implements (encryption in transit/rest expectations on provider catalog rows, tenant isolation, audit chain, secret scanning) are real but not mapped to a formal ISMS/PIMS. |
| SOC 2 | Vendor/service trust criteria. | Not audited. |
| Data retention / legal hold / breach notification / patient right of access | Retention fields exist on the provider catalog (`retainsPrompts`/`retainsOutputs`) and consent (`expiresAt`); the existing `AuditLegalHoldStore` (from an earlier phase) is reusable but not yet wired to AI-gateway resources specifically. | **Needs a dedicated retention/legal-hold policy decision and implementation pass**, and legal review of what "patient right of access" means for AI-generated drafts specifically. |

## Threat model summary

Covered by a concrete, tested control in this build:

- **Cross-tenant leakage** — every tenant-scoped store method is bound to a `TenantContext`; the
  in-memory store's own tests assert two orgs with colliding ids never see each other's data.
- **Direct/indirect prompt injection** — `content-scanner.ts` scans both input (before it leaves
  this process) and output (before it's ever stored/shown), on a fixed pattern set covering the
  well-known jailbreak/override shapes.
- **Secret/credential leakage into a model** — the same scanner's `SECRET_PATTERNS` catch
  vendor-prefixed API keys, PEM private-key blocks, bearer tokens, and connection strings embedded
  in clinical text.
- **Provider/model substitution or downgrade** — every request is pinned to an exact
  `providerModelId` (one row per provider+model+version+API-version); a `policySnapshotHash` over
  the exact consent/provider/model/tenant-settings state is frozen at request-creation time.
- **Unauthorized/stale access** — default-deny authorization, revoked/expired consent checked
  inline on every request, provider kill switch checked before every request.
- **Resource exhaustion (queue/GPU/RAM)** — tenant-aware admission control with per-tenant
  concurrency caps, priority-ranked queueing, and TTL-based lease reclamation.

**Explicitly not covered by a working control in this build** (real risk, not a false negative —
each corresponds to a "what's deliberately not implemented" item above): cross-tenant RAG/cache
leakage (no RAG exists), BOLA against imaging resources via the gateway (no imaging integration
exists), SSRF from a cloud provider adapter (untested against a real network), malicious
file/DICOM parsing via the gateway (no imaging path), decompression bombs via the gateway, replay
of a stolen provider credential (no secret-manager integration for external providers exists),
training-data membership/inversion attacks against an external provider (out of this system's
control once data legitimately leaves it, which is exactly why the training-use/retention hard
rails in `policy.ts` exist), and supply-chain compromise of a model artifact (no model-signing
verification exists).

## Migration and deployment

`server/migrations/018_clinical_ai_gateway.sql` — Part 0 creates the global `public.ai_providers`/
`public.ai_provider_models` tables; Part 1 extends `provision_tenant_clinical_schema` with a call
to the new `provision_tenant_ai_gateway_tables` function; that function creates 10 tenant tables
(provider-tenant-settings, consent, request, request-inputs, transformations, outputs, citations,
reviews, safety events, change feed) plus indexes; Part 2 backfills every existing tenant schema.
Validated via `libpg-query` (real Postgres grammar parsing) — every embedded DDL statement parses.

`PostgresAiGatewayStore` and `PostgresAiProviderRegistryStore` now map these tables and are selected
whenever `DATABASE_URL` is configured; local mode retains the in-memory stores. The implementations
compile and use transaction-bound tenant context, audit writes, and change-feed writes. They have
**not yet run against a live Postgres instance in this environment**, so real migration/lifecycle
tests remain a deployment gate rather than an implied verification.

## Remaining work

- Pixel-aware multimodal imaging inference and validated DICOM SR/SEG output artifacts.
- Tenant-safe retrieval/RAG, if a vector index is ever added to this codebase.
- Automated shadow/canary rollout and incident-response workflow. (Production quality/drift
  *monitoring*, as distinct from automated rollout/rollback, now exists — see
  `server/src/eval-harness/production-monitor.ts` and docs/CLINICAL_AI_EVALUATION.md's "Online
  production quality monitor" section.)
- Domain-level idempotency keys and automatic retry/backoff.
- A genuinely separate platform-admin authentication path for the global provider catalog.
- Formal risk-management, usability-engineering, and QMS documentation for any use case that ends
  up regulated as a medical device.

## Decisions requiring clinical, privacy, security, or legal approval before production use

1. Whether any specific configured use case qualifies for the FDA CDS exemption, or is a regulated
   device requiring a formal quality/risk-management process.
2. The lawful basis and DPA arrangements for sending any patient data to an external ("cloud")
   provider under GDPR or equivalent regimes, per jurisdiction.
3. Whether this system's current design meets EU AI Act high-risk-system obligations for any EU
   deployment, and what a conformity assessment would require.
4. A concrete data-retention and legal-hold policy for AI requests/outputs/citations, and how
   patient right-of-access requests are fulfilled for AI-generated drafts.
5. Restricting global provider-catalog management to a genuinely trusted platform-admin group
   (an organizational/policy decision available today, not a code change).
6. Approval of any specific external ("cloud") provider for PHI use — BAA/DPA/contractual/security
   review sign-off per the fields already modeled in `AiProviderModel.approvals`.
