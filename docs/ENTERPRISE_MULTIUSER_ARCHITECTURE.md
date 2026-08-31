# Enterprise multi-user deployment — architecture plan

**Scope:** A concrete plan for an optional **enterprise deployment mode** —
multiple clinicians working concurrently against shared organizational data,
plus an AWS-shaped central administration system (IAM-style roles, an
org-wide audit trail, a managed user pool) — layered on top of today's
local-first, single-device Electron app. One recommendation per question,
with rejected alternatives and why. No code is written here.

**Relationship to existing docs — read first, not duplicated here:**

- [`docs/ENTERPRISE_READINESS_ASSESSMENT.md`](ENTERPRISE_READINESS_ASSESSMENT.md)
  already established the target control-plane architecture (§5), the
  institutional data model (§7: `Organization`/`User`/`Role`/
  `UserRoleAssignment`/`AuditEvent` extensions), the threat model (§4), and a
  phased roadmap (§6). This plan does not re-derive any of that — it accepts
  §5's topology as given and answers the eight questions that document leaves
  at roadmap-level abstraction.
- [`docs/SHARED_BACKEND_DESIGN.md`](SHARED_BACKEND_DESIGN.md) already
  specifies the `PatientCasesBackend` client contract, the HTTP API shape for
  case sync, optimistic-concurrency conflict handling (**no CRDT for
  cases — a deliberate, already-made decision, not reopened here**), the
  OIDC-via-`mcp-oauth.ts`-reuse authentication pattern, and the migration
  mechanics (explicit one-time import, no dual-write). This plan **extends**
  that document to the rest of the enterprise surface (sessions, notes,
  audit, admin console, deployment topology) rather than replacing it. Where
  this plan's conclusions differ from that document, the difference and its
  reasoning are stated explicitly (see §6's reconciliation of "bring your own
  server" with the AWS-managed-stack option below) — nothing here silently
  overrides a prior decision.
- [`docs/CENTRAL_POLICY.md`](CENTRAL_POLICY.md) already ships one real piece
  of this puzzle in miniature: a signed, Ed25519-verified, fail-closed
  policy document (`app/src/policy-store.ts`) governing a curated settings
  subset per **device**. §5 below reuses its verification/fail-closed model
  and generalizes its delivery from "local file an MDM tool drops" to
  "network-pulled and cached," per-**organization** rather than per-device.
- [`docs/BACKUP_RESTORE.md`](BACKUP_RESTORE.md) and `app/src/case-encryption.ts`
  are the device-tied assumptions the user's request calls out by name; §7
  and the reuse table at the end state exactly what changes and why.

Everything below assumes enterprise mode is **additive**: the existing
single-device local mode is not deprecated, weakened, or made a second-class
citizen anywhere in this plan (see §8).

---

## 1. Backend service

**Recommendation: Node/TypeScript on Fastify, packaged as containers, run as
a long-running service (ECS Fargate) — not serverless Lambda, not Go/Rust.**

The deciding constraint is real-time session traffic (§3), not raw
throughput. A clinician's case-editing session or Clinical Assistant chat
session should stay live for a working shift; API Gateway's WebSocket API
specifically caps idle connections at 10 minutes without a ping and total
connection duration at 2 hours, with a 128KB per-message frame limit — a
`clinicalNotes` collaborative-edit payload or a chat-session replay is a
plausible way to bump into that ceiling, and building ping/reconnect
machinery to work around a serverless product's connection limits is exactly
the kind of complexity a long-running service avoids by construction. Once
WebSocket-holding infrastructure exists, there's no operational reason to
split bursty admin/REST traffic onto a second, serverless runtime — that
traffic is institutional-scale (hundreds to low thousands of requests/day
per org), nowhere near the volume where Lambda's cost/ops profile pays for
itself, and running two deployment models (Lambda + Fargate) is strictly
more operational surface than running one.

TypeScript on Fastify specifically (over NestJS, over Go/Rust):

- **Reuses `app/src/schemas.ts`'s zod schemas and the stores' validation
  logic directly.** `patientCaseSchema`, `auditEventSchema`, etc. move into a
  new shared workspace package (`shared/`) consumed by both `app/` and the
  new server — one source of truth for the wire contract, matching how
  `SHARED_BACKEND_DESIGN.md` §3 already specifies the API responses use
  `patientCaseSchema`'s exact shape. This is the single biggest argument
  against Go or Rust: either language forks validation logic into a second,
  hand-maintained implementation of the same rules `schemas.ts` already
  encodes, unless schemas are code-generated from one source of truth — a
  real option, but extra toolchain (zod → JSON Schema → target-language
  types) not justified when the existing team's primary codebase is already
  TypeScript end to end (Electron main, renderer, and the Rust `lib/` addon
  is narrowly scoped to native I/O, not business logic).
- **Fastify over NestJS**: NestJS's DI/decorator/module ceremony is a larger
  conceptual jump from this codebase's existing style (`app/src/ipc/*-handlers.ts`
  — plain functions registered against named channels) than Fastify's plugin
  model, which maps onto the same "named handler, validated input, explicit
  registration" shape almost directly. NestJS's extra structure pays off at a
  scale (many teams, many services) this project isn't at yet.

**Rejected:**
- **Go/Rust** — better raw throughput/latency, but forks `schemas.ts`'s
  validation logic into a second implementation to hand-maintain, unless
  code-generated from one source — an unjustified toolchain addition given
  institutional (not internet-scale consumer) traffic volumes.
- **NestJS** — heavier framework ceremony than this codebase's existing
  lightweight handler-registration style warrants at current scale.
- **Fully serverless (API Gateway + Lambda)** — good fit for bursty
  admin/REST traffic in isolation, but a poor fit for the WebSocket-held
  real-time sessions §3 requires, specifically because of API Gateway
  WebSocket API's connection-count/idle-timeout/message-size ceilings above.
  Running a second serverless stack just for REST once a long-running WS
  service already exists adds operational surface for no benefit at this
  traffic scale.

---

## 2. Multi-tenancy data model

**Recommendation: schema-per-tenant in one Postgres instance (or cluster),
as the default for every institutional tenant — not shared tables with
`tenant_id` + RLS as the default, and not database-per-tenant as the
default either.**

**Decision status (2026-08-27): accepted.** Clinical data follows
[ADR 0001](adr/0001-clinical-tenant-isolation.md). Shared IAM metadata keeps
RLS-protected shared tables. This is no longer an open implementation choice.

This is medical data; the default posture should lean toward physical/
namespace isolation, not toward "isolation is enforced by policy
correctness." Shared tables + RLS makes cross-tenant leakage a function of
every query and every RLS policy being written correctly, forever — a single
missing `WHERE tenant_id = ...` in a raw query, or one misconfigured policy,
is a cross-tenant PHI leak. That risk is not acceptable as the **default**
for this data class, even though RLS is cheaper to run. Schema-per-tenant
gets most of database-per-tenant's isolation story (a query issued with the
wrong `search_path` returns nothing, not another tenant's rows — a
structural, not policy-dependent, guarantee) while sharing one instance's
connection pool, monitoring, and backup infrastructure.

The two usual objections to schema-per-tenant are both manageable at this
product's actual scale (dozens to low hundreds of institutional tenants, not
thousands):

- **Migrations run N times** — mitigated with a migration runner that
  iterates every tenant schema and applies each migration idempotently,
  exactly the same idempotent-migrate-and-skip-if-present pattern this
  repository already proved out for the audit log's JSON→SQLite migration
  (`lib/src/store/audit.rs`'s `migrate_audit_log_from_json`, cited in
  `SHARED_BACKEND_DESIGN.md` §6) — this isn't a new pattern to invent, just
  the same one applied per-schema instead of once.
- **Connection pooling per tenant** — a single connection pool with
  `SET search_path = tenant_<id>` per request avoids needing N physical
  pools; Postgres's native schema-qualified search path makes this a
  request-scoped setting, not a per-tenant connection.

**Database-per-tenant** is offered as an explicit **opt-up tier**, not the
default — for the specific institutions whose contract or compliance posture
requires physically separate infrastructure (a large hospital system with
its own dedicated-instance requirement, or a government customer). This
keeps the strongest isolation option available without making every tenant
pay its operational cost (migrations run N times for real, N connection
pools, N sets of infrastructure to patch and monitor).

**Rejected as the default:**
- **Shared tables + `tenant_id` + RLS** — cheapest to run, but isolation is
  enforced by policy correctness rather than physical separation; for PHI,
  defaulting to this requires an explicit argument for why RLS
  misconfiguration risk is acceptable, and there isn't one strong enough at
  this product's tenant count. (It remains a legitimate choice *within* a
  tenant's schema for department/workspace-level sub-isolation — see §5's
  Organization→Workspace hierarchy — where the primary cross-tenant boundary
  is already the physical schema, and RLS is doing a smaller, lower-stakes
  job.)
- **Database-per-tenant as the universal default** — strongest isolation,
  simplest HIPAA story, but migrations-run-N-times and per-tenant connection
  pooling are real operational costs not worth paying for every tenant when
  schema-per-tenant closes most of the isolation gap at a fraction of the
  operational cost.

---

## 3. Real-time sync / conflict handling

Not one mechanism — a mechanism per data shape, as the underlying concurrency
needs genuinely differ.

### Patient case structured fields
**Optimistic concurrency with a per-case version/ETag — already specified in
`SHARED_BACKEND_DESIGN.md` §5, not reopened here.** Discrete-value fields
(`demographics`, `allergies`, `vitalSigns`, etc.) are rarely edited by two
people at once; a `writeOne` call carrying `expectedVersion` is rejected with
`412` + the current server version on conflict, and the client surfaces this
to the clinician for an explicit reload-and-reapply or diff-and-choose —
**never an automatic merge.** That document's own reasoning stands: silently
combining two independently-edited versions of a patient case risks
producing a document that reads as coherent but was never reviewed as a
whole by anyone, which is a worse failure mode for clinical data than an
occasional "someone else edited this" prompt. A CRDT here would be solving a
problem (frequent concurrent edits to the same case) that mostly doesn't
occur for this data shape, at the cost of building infrastructure this
document already rejected on clinical-safety grounds.

### Free-text clinical notes (`clinicalNotes`)
**Yjs, if and only if two clinicians genuinely co-edit the same note in the
same session** — this is worth confirming as a real workflow before building
it; if concurrent co-authorship of a single note is rare in practice,
optimistic locking (same as case fields, one level down) may be sufficient
and simpler. If real-time co-editing is confirmed as needed:

- **Yjs over Automerge**: smaller runtime footprint, more mature/battle-tested
  editor bindings for exactly this use case (`y-prosemirror`/`y-textarea`,
  Tiptap's first-class Yjs collaboration support), and a simpler, more
  network-efficient binary update encoding. Automerge's strengths (full
  document history, branching/time-travel semantics) solve problems this
  product doesn't have — a note field doesn't need a version-control-style
  history graph, it needs two people's live edits to converge.
- **Persistence model**: the CRDT document is *live-session merge state*,
  not the system of record. On session end (or a periodic checkpoint), the
  merged text quiesces into a new `ClinicalNote` entry
  (`app/src/patient-cases-store.ts`'s existing `{id, author, text, createdAt}`
  shape) — the append-only note history stays the durable record; Yjs only
  owns the transient collaborative-editing window. This avoids a schema
  migration of `clinicalNotes` itself into a CRDT-native format.
- **Transport note relevant to §7**: Yjs updates are opaque binary diffs — a
  relay server can fan them out to other editors of the same note without
  ever decoding their content. This is a real, cheap partial mitigation
  worth building regardless of the encryption posture decided in §7 (never
  persist plaintext note content in the pub/sub fan-out layer itself — only
  relay-and-forward the opaque update, decrypting only when materializing to
  the REST-readable `ClinicalNote` record).

**Rejected**: Automerge (heavier for a need this narrow); a CRDT for every
data shape uniformly (rejected per-shape below and above — this is the
justification for treating sync as a per-shape decision rather than picking
one global protocol).

### Chat sessions (`sessions-store.ts`)
**Ordered append — each message gets a server-assigned monotonic sequence
number, full stop. No CRDT machinery.** Chat sessions are mostly append-only
by nature (a conversation grows one message at a time); the only real
concurrency question is "what order do near-simultaneous messages from
different participants land in," which a server-assigned sequence number
answers directly without needing conflict-free merge semantics at all.

### Audit log
**Already decided — a centrally aggregated, still-hash-chained event
stream, not a new mechanism.** `audit-log-store.ts`'s existing
`computeEventHash`/`previousEventHash`/`verifyChainIntegrity` chain stays
authoritative on-device exactly as today; `SHARED_BACKEND_DESIGN.md` §7's
fire-and-forget shipping queue (local write never blocked on network,
retries on failure, never drops the local record) ships new events to a
central sink. Server-side, the same hash-chain algorithm aggregates
per-organization into one queryable, immutable stream — the CloudTrail
shape the user asked for is exactly this: local chains stay the source of
truth for integrity, the server is where they're aggregated and queried
across a fleet.

### Transport
**Self-hosted WebSocket gateway (`ws`) + Redis pub/sub for cross-instance
fan-out — not AppSync, not IoT Core, not a third-party like Ably.**

The deciding factor is §6: this plan supports both an AWS-hosted topology
*and* a self-hosted/on-prem topology (a real requirement for
data-residency-constrained hospital procurement). AppSync GraphQL
subscriptions only exist in the AWS-hosted topology — choosing it as the
transport would mean building and maintaining a second, GraphQL-shaped
schema alongside `schemas.ts`'s zod source of truth (the same
schema-duplication problem §1 already rejected for Go/Rust, recurring here)
*and* it wouldn't work at all for a self-hosted deployment. IoT Core is
built for device-telemetry pub/sub semantics (topic-based, small messages),
not app session state. Ably/PubNub are viable purely as a managed
convenience, but add a paid third-party dependency and an outbound network
path for a HIPAA-relevant data stream that a self-hosted gateway avoids —
and, like AppSync, wouldn't be usable in the self-hosted topology either.

`ws` + Redis pub/sub is the one transport that works identically across
every topology in §6, at the cost of running and monitoring Redis and
handling reconnection/backpressure in the gateway service — real operational
burden, accepted deliberately because portability across topologies matters
more here than avoiding that burden in the AWS-hosted case specifically.

---

## 4. Auth / identity

**Recommendation: the app is a generic OIDC relying party — reusing
`app/src/mcp-oauth.ts`'s existing Authorization Code + PKCE loopback-redirect
pattern exactly as `SHARED_BACKEND_DESIGN.md` §2 already specifies — with the
actual identity provider chosen per deployment topology: AWS Cognito for the
AWS-hosted topology, Keycloak for the self-hosted topology.** This is decided
together with §6, not independently, because the two are in real tension
otherwise: a self-hosted, no-cloud-vendor deployment target and a
hard-wired Cognito dependency contradict each other.

- **Cognito (AWS-hosted topology, default/flagship target)**: User Pools for
  authentication — SSO/SAML/OIDC federation for institutions with their own
  IdP, MFA, self-service password reset — with Groups mapped to the roles in
  §5, and Identity Pools *only if* some component needs temporary AWS
  credentials directly (e.g., a client uploading an evidence attachment
  straight to S3) — otherwise skipped as unnecessary surface. This is the
  most literal match to "administration like AWS," and it means building
  almost none of the undifferentiated identity-provider plumbing in-house.
- **Keycloak (self-hosted topology)**: full control, zero AWS dependency,
  satisfies the "no cloud vendor" procurement requirement common in hospital
  IT, and exposes the exact same OIDC endpoints the app's relying-party code
  already expects — swapping IdP is a configuration change (issuer URL,
  client ID), not a code fork, because the client was built as a generic
  OIDC consumer from the start.
- **What is never built**: a custom username/password login screen, custom
  session management, or custom MFA — this reaffirms
  `ENTERPRISE_READINESS_ASSESSMENT.md` §2.1's P0 call ("delegate to IdP, do
  not build custom MFA") rather than reopening it. `app/src/accounts.ts`
  (GitHub/Hugging Face token linking for Agent-mode tools) remains explicitly
  unrelated — identifying a developer's tool-access account is a different
  problem from identifying a clinician for PHI access, and the two must
  never be conflated.

**Rejected:**
- **Cognito everywhere, including self-hosted deployments** — contradicts
  the no-cloud-vendor procurement requirement §6 says is common enough to
  design for explicitly, not assume away.
- **Keycloak/Ory everywhere, including the AWS-hosted topology** — running
  and securing a self-hosted IdP when the AWS-hosted topology could instead
  consume Cognito as a managed service is extra undifferentiated operational
  burden with no corresponding benefit in that topology specifically.
- **Ory** specifically over Keycloak for the self-hosted case — Keycloak's
  SAML support and broader enterprise-IdP-federation track record is a
  better fit for hospital-IT interop requirements (existing Active
  Directory/ADFS federation, SAML-only legacy IdPs) than Ory's more
  API-first, SAML-light design.

**Implementation status**: `packages/server/` (new workspace, see its own README.md)
implements the *generic* half of this section — `packages/server/src/auth/oidc-verifier.ts`
verifies a bearer token's signature/issuer/audience/expiry against any
spec-compliant OIDC provider's JWKS, resolved via discovery or a direct
JWKS URI, with the issuer/audience read from config
(`packages/server/src/config.ts`). Neither Cognito nor Keycloak is hard-coded
anywhere, matching this section's "decide the actual IdP per deployment
topology" framing. **Not done**: no Cognito- or Keycloak-specific setup
tooling (User Pool/Group provisioning scripts, a Keycloak realm export),
and the Electron client has no relying-party OIDC flow yet — reusing
`app/src/mcp-oauth.ts`'s PKCE pattern for this, per
`SHARED_BACKEND_DESIGN.md` §2, remains unimplemented.

---

## 5. Admin console

Enumerated as the concrete AWS-shaped features requested, not a restated
question:

- **IAM-style RBAC**: named roles (Org Admin, Clinician, Read-only Auditor,
  matching the `Role` shape already sketched in
  `ENTERPRISE_READINESS_ASSESSMENT.md` §7) backed by **policy documents**,
  not a fixed enum — a JSON structure scoping exactly which
  resource/action/condition combinations a role can touch (analogous to an
  IAM policy: `{"effect": "allow", "resource": "patient-case:*", "action":
  ["view", "edit"], "condition": {"department": "${user.department}"}}`).
  Evaluated **server-side only, always** — this is the same principle
  `SHARED_BACKEND_DESIGN.md` §4 already established for case-data tenant
  scoping ("the client is never trusted for this, full stop"), generalized
  to every resource type the admin console governs, not just cases.
- **AWS Organizations-style hierarchy**: one `Organization` containing
  multiple Workspaces/departments. This maps directly onto §2: `Organization`
  = tenant = Postgres schema (the primary, physical isolation boundary);
  Workspace-level isolation *within* an org's schema is enforced with a
  lighter-weight `workspace_id` + RLS check — acceptable here specifically
  because the schema boundary already carries the primary cross-tenant
  isolation burden, so a Workspace-level RLS bug is a within-organization
  scoping error, not a cross-institution PHI leak.
- **CloudTrail-style org-wide audit**: the aggregated, hash-chained stream
  from §3, exposed as one queryable, immutable log per organization in the
  console — reusing `audit-log-store.ts`'s existing hash-chain algorithm
  server-side rather than inventing a second integrity mechanism.
- **CloudWatch-style monitoring**: ships primarily as a **structured
  export hook into the organization's own SIEM/monitoring stack**
  (matching `ENTERPRISE_READINESS_ASSESSMENT.md` §2.4's own recommendation
  of a SIEM-compatible export format), plus a **minimal first-party
  dashboard** covering only what's needed without a SIEM already in place
  (login anomalies, error rates, active-session counts, policy-enforcement
  state — the same kind of state `docs/CENTRAL_POLICY.md`'s Settings page
  already surfaces per-device, generalized to per-organization). Building a
  full first-party observability platform is explicitly out of scope —
  that's Prometheus/Grafana (self-hosted topology) or CloudWatch itself
  (AWS-hosted topology) doing the job they already do well.
- **Usage metering/quotas**: build the counters now — per-seat active-user
  count, per-model-call counts, instrumented at write-time in the same
  handlers that already call `audit-log-store.ts`'s `recordEvent` — even
  before any tiered/billed plan exists, because retrofitting metering after
  the fact is materially more expensive than instrumenting it alongside the
  audit calls that already exist at every relevant call site. **Do not**
  build billing/invoicing itself in this phase (Stripe integration, AWS
  Marketplace metering, contract-tier enforcement) — that's a business-system
  integration decided separately from this architecture plan.

**Implementation status**: the IAM-style RBAC bullet above is implemented in
`packages/server/` — real JSON policy documents (`{effect, actions, resources,
condition?}` statements, AWS IAM evaluation semantics: default deny,
explicit deny always wins), attached to a `User` directly or via a `Group`,
evaluated server-side only via `POST /organizations/:id/authz/check`
(`packages/server/src/domain/policy-evaluator.ts`, `packages/server/src/routes/authz.ts`). One
scope narrowing versus this bullet's own example text: conditions support
`StringEquals`/`StringNotEquals` only (no `${user.department}`-style
variable interpolation inside the policy document itself — a condition
compares a statement's literal expected value against a context key the
caller/server supplies at evaluation time instead), which covers the same
department-scoping use case with a simpler, more auditable evaluator. **Not
done**: the Organizations→Workspace hierarchy (only `Organization` exists;
no `workspace_id` scoping yet), CloudTrail-style aggregation (no audit
emission from this service at all yet — see this workspace's own README.md
"Known gaps"), CloudWatch-style monitoring, usage metering, and the admin
console *frontend* itself — `packages/server/` is an API only, with no UI calling it.

---

## 6. Deployment topology

**Recommendation: support two server topologies an institution chooses
between — AWS-hosted managed stack, and self-hosted Docker
Compose/Kubernetes — with local-first client caching as a mandatory
property under *both*, not a third topology choice.**

- **AWS-hosted managed stack** (ECS Fargate for the backend service from
  §1, RDS Postgres for §2, Cognito for §4, an `ws`-based gateway + Redis for
  §3, S3 for object storage) is the flagship target — the most direct match
  to "administration like AWS," and it reuses real code that already exists:
  `app/src/cloud-backup-store.ts`'s S3-compatible client is the same shape
  needed for evidence-attachment/backup object storage in this topology, not
  a new integration.
- **Self-hosted / on-prem** (Docker Compose or Kubernetes manifests,
  Postgres, Keycloak per §4, the same `ws`+Redis gateway) is a real,
  documented, equally-supported second target — needed for any institution
  with a data-residency requirement ruling out a US cloud vendor, which
  `ENTERPRISE_READINESS_ASSESSMENT.md` §9's own regulatory matrix already
  flags as a live KVKK/GDPR concern, not a hypothetical.
- **Local-first caching is not a third option to pick — it's a required
  client property regardless of which server topology is chosen.** The
  Electron client keeps an encrypted, short-TTL local cache and syncs
  opportunistically, exactly as `SHARED_BACKEND_DESIGN.md` §3's offline
  behavior already specifies (a "may be stale — last synced {time}" banner
  when serving from cache, writes queued locally and flushed on reconnect
  through the same conflict path as any other write). This preserves the
  app's real current strength — clinicians working in low-connectivity
  settings — under both server topologies identically.

**Reconciling this with `SHARED_BACKEND_DESIGN.md` §1's "bring-your-own-server,
not a ModelForge-operated SaaS" stance**: this plan does not reopen that
decision. The AWS-hosted topology above is an institution deploying the
stack **into their own AWS account**, using AWS-managed services
(Cognito/RDS/ECS) rather than self-managed OSS on bare metal — it is still
not ModelForge operating a shared multi-tenant SaaS on institutions' behalf.
"Bring your own server" now has two supported flavors (self-hosted OSS, or
your own AWS account) rather than one; both satisfy the original
no-managed-SaaS commitment while the first flavor is also the literal
"administration like AWS" answer the enterprise-mode request asks for.

**Rejected:**
- **A ModelForge-operated managed SaaS** — a business and compliance
  commitment (BAAs, uptime SLAs, incident-response ownership) explicitly
  outside this document's scope, per `SHARED_BACKEND_DESIGN.md` §1's
  existing reasoning, not reopened here.
- **AWS-hosted only, no self-hosted option** — would exclude any
  data-residency-constrained customer outright, a real and common enough
  procurement blocker in healthcare to design around rather than assume
  away.
- **Local-first caching as an optional/configurable mode** — making it
  optional would let a poorly-configured deployment silently drop the
  offline resilience that's a genuine product differentiator; it's specified
  as mandatory client behavior instead.

---

## 7. Encryption vs. real-time collaboration — the hardest trade-off

**Recommendation: server-managed, per-tenant KMS-backed keys (AWS KMS in the
AWS-hosted topology; a self-hosted equivalent — HashiCorp Vault's transit
engine, or the self-hosted deployment's own KMS-equivalent — in the
self-hosted topology), explicitly *not* full end-to-end encryption with
per-user key wrapping, for enterprise mode's first iteration.** This is
stated as a trade-off, not left implicit, exactly as the request asks.

**Why server-managed keys, not E2E, and why now**: real-time multi-user
merge — §3's optimistic-concurrency conflict detection for case fields, and
Yjs's CRDT merge for notes — needs *something* to read, diff, or relay
plaintext deltas to do its job. This is not strictly impossible under E2E in
principle (Yjs's update messages are opaque binary diffs a relay server can
forward without decoding them — noted in §3 — so the *transport* layer is
compatible with E2E in a narrow sense), but the moment that content needs to
be **persisted** as the durable `ClinicalNote`/`PatientCase` record, queried,
searched, or reconciled against a conflicting case-field edit, something
server-side needs to read plaintext (or a KMS-decryptable ciphertext) to do
that work. A true E2E scheme — a per-case symmetric key wrapped separately
per authorized user's public key, rotated on every offboarding — is
substantially more complex than everything else in this plan combined:
key-wrapping infrastructure, a public-key directory per user, rotation
logic that must run correctly on every role change or termination (a missed
rotation is a live security hole, not a degraded feature), and a hard
answer for what happens to server-side search/audit-log content-matching
once the server genuinely cannot read the data. Building that half-right is
worse than shipping server-managed keys honestly labeled as the interim
posture.

**This must be stated as loudly as `docs/CLINICAL_WORKSPACE.md`'s and
`docs/BACKUP_RESTORE.md`'s existing "not a certified compliance product"
posture, because it changes the guarantee this app has made until now.**
`case-encryption.ts`'s current device-tied model has a real property: *the
passphrase is never stored anywhere, and the derived key exists only in this
process's memory* — meaning, correctly, that not even ModelForge (a company
with no server component today) can read a user's case data. Server-managed
KMS keys in enterprise mode give up that specific guarantee: an institution's
own cloud/ops team (or, in the AWS-hosted topology, AWS itself under its own
KMS access controls) can decrypt tenant data given sufficient access,
because the key exists and is retrievable server-side by design. This is a
weaker end-to-end guarantee than today's single-device model, traded for the
ability to do real-time multi-user collaboration at all — and it should be
disclosed to institutions evaluating enterprise mode in exactly those terms,
not glossed over as "still encrypted." A future, explicitly separate phase
can revisit true E2E for institutions whose threat model specifically
requires zero server-side plaintext exposure even from their own
infrastructure operators — but that is out of scope for enterprise mode's
first iteration, named here as deferred rather than silently dropped.

**What has to change in `case-encryption.ts` specifically**: nothing, for
the local single-device mode — it keeps working exactly as today,
unmodified, for any install that never opts into enterprise mode. For
enterprise mode, a **new, separate server-side key-provider module** is
built; it is not a modification of `case-encryption.ts`, because that
module's core design (a `scryptSync`-derived key from a single passphrase,
living only in one process's memory) is architecturally single-user/
single-device and has no meaningful "multi-user" variant to retrofit. What
*is* worth reusing conceptually, not literally: the verifier-check pattern
(never compare or store the actual secret, only an HMAC fingerprint of the
derived key), the memory-only-while-unlocked lifecycle, and the
`onBeforeLock` hook mechanism that lets dependent stores register their own
cleanup rather than requiring every caller to remember to do it — all three
are good design patterns worth carrying into the new server-side module's
shape, even though the concrete implementation (a per-tenant KMS data key,
fetched over an authenticated channel, not a user-typed passphrase) is
necessarily different.

**Rejected:**
- **Full E2E with per-user key wrapping, in enterprise mode's first
  iteration** — correctly identified as substantially more complex than the
  rest of this plan; deferred to an explicitly named future phase rather
  than attempted now, per the reasoning above.
- **Silently treating server-managed keys as equivalent to today's local
  guarantee** — rejected outright; the trade-off must be disclosed, not
  glossed over, matching this codebase's existing pattern of stating
  limitations loudly (the medication-safety demonstration-table labeling,
  the redaction "not clinical-grade" caveat, the "not a certified compliance
  product" posture) rather than implying a stronger guarantee than what's
  actually built.

---

## 8. Migration/rollout path

**Recommendation: enterprise mode is a new, explicit, opt-in mode with a
required backend — not a hard requirement on the base app, and not "backend
stays fully optional with opportunistic sync" as the general answer either.
The existing pure-local single-device mode remains first-class, unchanged,
and the default for any install that never configures enterprise mode.**

"Multiple users working concurrently against shared org data" is not
achievable without a shared store to be concurrent against — a backend is
definitionally required *to use enterprise mode at all*, in the same way
`docs/CENTRAL_POLICY.md`'s policy mechanism is only active once an admin
deploys `policy.json`/`trusted-public-key.pem` to the device, and is a
complete no-op (today's default local-control behavior, "not a degraded
state") otherwise. Enterprise mode should follow the identical shape: an
install that never points at an organization's backend behaves exactly as
today, in every respect, forever — this plan does not touch that path at
all. An install that *does* opt into enterprise mode accepts a real backend
dependency for the enterprise-specific features (shared cases, org admin
console, central audit aggregation), while still preserving graceful offline
degradation *within* that mode once initially provisioned — the cached
last-known-good snapshot and offline write queue from §6, not a hard
"useless without connectivity" client. Local-model inference continues to
work fully offline regardless of enterprise-mode status, exactly as
`ENTERPRISE_READINESS_ASSESSMENT.md` §5 point 4 already commits to for the
control-plane architecture generally.

**Migration mechanics**: reuse `SHARED_BACKEND_DESIGN.md` §6's design
exactly — an explicit, one-time, user-initiated "Import local data to shared
backend" action, idempotent on each record's existing client-generated `id`
(the same `migrate_audit_log_from_json`-shaped idempotent-insert-if-absent
pattern already proven in this codebase), no automatic or silent migration,
and **no ongoing dual-write** once a backend is selected as active — all
business logic goes through exactly one active backend at a time, matching
the existing `PatientCasesBackend` single-active-backend design rather than
adding the consistency risk of two simultaneously-authoritative stores. This
plan's only extension to that mechanics: the same explicit-import pattern
applies to chat sessions (`sessions-store.ts`) as well, since enterprise
mode's premise (shared, concurrent access) applies to sessions and notes
just as much as to cases — `SHARED_BACKEND_DESIGN.md` scoped itself to
patient cases only; this plan generalizes the *mechanism*, not the specific
document's stated scope.

**Rejected:**
- **Backend as a hard, unconditional dependency of the desktop app** — would
  break the pure-offline use case for every existing single-device install,
  including ones that never want or need enterprise mode. Rejected outright.
- **Backend fully optional even *within* enterprise mode, opportunistic sync
  only, no required connection ever** — harder to build than the explicit-mode
  approach and doesn't actually match what "multiple users working
  concurrently" requires; if it's meant to work at all, someone has to be
  reachable to concur with. The graceful-degradation-after-initial-provisioning
  model above gets the practical benefit (works through a connectivity gap)
  without pretending the feature has no connectivity requirement whatsoever.

---

## What changes vs. what's reused as-is

| Component | Status | Notes |
|---|---|---|
| `app/src/schemas.ts` (zod schemas) | **Reused directly** | Becomes the shared wire contract via a new `shared/` workspace package (§1) |
| `patient-cases-store.ts`'s `PatientCasesBackend` interface | **Extended, additive** | `readSince`/`writeOne` added per `SHARED_BACKEND_DESIGN.md` §3; `readAll`/`writeAll` stay the required baseline, unchanged |
| `app/src/mcp-oauth.ts` (PKCE/loopback pattern) | **Reused directly** | Same shape drives the enterprise-backend OIDC client (§4), per `SHARED_BACKEND_DESIGN.md` §2 |
| `app/src/secrets-store.ts` | **Reused directly** | New namespaced keys for backend tokens, same `safeStorage` mechanism |
| `audit-log-store.ts`'s hash-chain algorithm | **Reused directly, server-side too** | `computeEventHash`/`previousEventHash`/`verifyChainIntegrity` logic aggregated per-organization server-side (§3, §5); local chain stays authoritative on-device unchanged |
| `policy-store.ts`'s Ed25519 signed-policy verification | **Reused conceptually** | Verification/fail-closed model carried into org-level policy (§5); delivery changes from local-file-only to network-pulled-and-cached |
| `backup-store.ts` / `cloud-backup-store.ts` | **Reused directly** | Enterprise mode doesn't replace per-device backup; the S3-compatible client in `cloud-backup-store.ts` is the same shape needed for the AWS-hosted topology's object storage (§6) |
| `json-store.ts`'s atomic-write pattern | **Reused directly, local-cache scope only** | Irrelevant server-side (Postgres's job), unchanged for the mandatory local-first cache layer (§6, §8) |
| `case-encryption.ts` | **Not modified — new module built alongside it** | Local single-device mode keeps this file completely unchanged. A new, separate server-side KMS key-provider is built for enterprise mode; only its verifier/lock-hook *design patterns* are reused, not its passphrase-derived, single-device implementation (§7) |
| `sessions-store.ts` | **Extended** | Ordered-append sequencing (§3) and writeOne/readSince wiring; `clinicalNotes`' CRDT live-session state is new and separate from the durable append-only note history it quiesces into (§3) |
| `audit-log-store.ts`'s `AuditEvent` shape | **Extended** | `actorUserId`/`organizationId` fields added (blocked on §4's identity existing — already flagged in `ENTERPRISE_READINESS_ASSESSMENT.md` §7); shipping-queue hook added per `SHARED_BACKEND_DESIGN.md` §7 |
| Backend service (Fastify, §1) | **Net new** | No existing analog in this repository |
| Admin console frontend | **Net new component, reused UI kit** | New route/app surface; reuses `frontend/`'s existing shadcn/Base UI component library and i18n setup (`ARCHITECTURE.md`) rather than rebuilding a design system, but is not the Electron desktop shell |
| Postgres schema-per-tenant infra, KMS, Redis, `ws` gateway | **Net new** | No existing analog |

---

## What still needs explicit human sign-off before implementation

Mirroring `SHARED_BACKEND_DESIGN.md`'s own closing pattern:

1. **§7's encryption trade-off** — server-managed KMS keys over full E2E for
   enterprise mode's first iteration is the single highest-stakes decision
   in this plan, and the one most likely to need re-litigating per
   institution depending on their specific threat model and risk tolerance.
2. **§2's schema-per-tenant default is accepted in ADR 0001.** Revisit only
   through a superseding ADR if the deployment model changes to many
   thousands of very small tenants.
3. **§6's two-topology commitment** — supporting both AWS-hosted and
   self-hosted doubles the deployment surface to build and test; confirm
   both are genuinely needed (i.e., that data-residency-blocked customers
   are a real near-term segment, not a hypothetical) before committing
   engineering time to both rather than shipping AWS-hosted first and
   adding self-hosted later if demand materializes.
4. **§8's mode boundary** — confirm product/business agreement that
   enterprise mode is genuinely opt-in and the local single-device mode
   stays permanently first-class, since that framing is what keeps this
   plan additive rather than a breaking migration of the existing product.
