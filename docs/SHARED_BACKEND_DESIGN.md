# Shared/networked persistence backend — design

**Scope:** Architecture design for an optional shared `PatientCasesBackend`
implementation — the concrete, implementation-ready counterpart to the
seam already in `app/src/patient-cases-store.ts`. No code is written here;
this is the document a human architect signs off on before implementation
starts, and the specification an implementer would follow.

**Relationship to `docs/ENTERPRISE_READINESS_ASSESSMENT.md`:** that
document already establishes the target control-plane architecture (§5),
data model (§7), threat model (§4), and phased roadmap (§6) for
institutional deployment as a whole — identity, RBAC, central policy,
tamper-evident audit shipping, key management. This document does not
re-derive any of that; it accepts §5's control-plane topology as the given
direction and answers the questions that document leaves at roadmap-level
abstraction: what does a *shared `PatientCasesBackend` implementation*
concretely look like, wired against the seam that now actually exists in
this codebase. Where this document's conclusions depend on a
not-yet-built piece of that roadmap (identity, in particular), that
dependency is called out explicitly, not silently assumed away.

**A note on staleness:** `ENTERPRISE_READINESS_ASSESSMENT.md` predates
`PatientCasesBackend` (`app/src/patient-cases-store.ts`) and
`MedicationSafetyProvider` (`app/src/medical-safety.ts`) — both were added
after that assessment was written. §2.7 of that document already reflects
`MedicationSafetyProvider`; §1/§5 do not yet mention `PatientCasesBackend`.
This document's existence is itself the correction for that gap; no
further edit to the assessment is needed beyond what this document
supersedes on the patient-cases point specifically.

---

## 1. Deployment topology

**Decision: bring-your-own-server, speaking a documented HTTP API this
document specifies — not a ModelForge-operated managed service.**

This repository ships a *client* (the Electron app) that can be pointed at
a shared backend an institution stands up and operates itself, using
whatever infrastructure/hosting fits their compliance posture (on-prem,
their own cloud tenancy, a regional provider for data-residency reasons —
§9 of the assessment's regulatory matrix makes residency a live concern
for KVKK/GDPR specifically). ModelForge does not commit to operating a
multi-tenant SaaS on institutions' behalf: that would be a business and
compliance commitment (BAAs, uptime SLAs, incident response ownership) far
outside what an engineering design document can decide, and conflating
"we designed the protocol" with "we operate your PHI store" is exactly the
kind of scope creep this design should resist.

Concretely: this document specifies (a) the `PatientCasesBackend` client
adapter contract, and (b) the HTTP API contract a server must implement to
satisfy it. Building a *reference server implementation* is worthwhile
future work but is explicitly out of this document's scope (§9) — an
institution (or a future ModelForge engagement) implements the server
side against the contract specified here, in whatever stack fits their
existing infrastructure.

This mirrors the assessment's §5 diagram directly: the "Institutional
control plane" box is what a shared `PatientCasesBackend` talks to for
case data specifically, alongside (not instead of) the identity/policy/
audit-ingestion components already scoped there.

## 2. Identity & authentication

**Decision: OIDC Authorization Code + PKCE against the institution's own
identity provider — reusing the exact pattern already implemented for MCP
server OAuth, not a new mechanism.**

`app/src/mcp-oauth.ts` already implements a complete, working OAuth
2.1+PKCE client on top of the official MCP SDK's `OAuthClientProvider`
interface: a fixed loopback redirect (`http://127.0.0.1:51823/oauth/callback`,
the same approach `gh`/`gcloud` CLIs use — no OS custom-protocol
registration needed, works identically across platforms Electron ships
on), with tokens/verifiers/client registration stored in
`secrets-store.ts`, namespaced per server id so one server's credentials
can never be confused with another's.

The shared `PatientCasesBackend` should reuse this exact shape rather than
build a second OAuth client:

- A new namespace (`shared_backend_tokens`, `shared_backend_verifier`,
  `shared_backend_client_info` — mirroring `mcp-oauth.ts`'s
  `tokensKey`/`verifierKey`/`clientInfoKey` functions) in
  `secrets-store.ts`, using the same `safeStorage`-backed encryption (with
  the same documented plaintext-fallback-and-warning behavior when the OS
  credential store is unavailable) already used for every other secret in
  this app.
- The same loopback-redirect flow, driven from Settings ("Connect to
  shared patient case backend" — mirroring the "Patient case storage
  backend" section already added by this session, extended with a
  "Connect" action that triggers the OIDC flow before a shared backend can
  be selected as active).
- Refresh-token handling follows whatever the MCP SDK's `auth()` helper
  already does for MCP servers — no new refresh logic to design.

**What this explicitly does not build**: no username/password login
screen, no custom session mechanism, no MFA implementation. Per the
assessment's §2.1/§5.1, identity is delegated to the institution's own
IdP; this app is a relying party only. `app/src/accounts.ts` (GitHub/
Hugging Face token linking for Agent-mode tools) is unrelated and must
not be confused with or reused for this — it identifies a *developer
account for tool access*, not a clinician for PHI access.

**Authorization**, as distinct from authentication: the access token
obtained above carries whatever claims the IdP/policy service issues
(organization, role, scope) per the assessment's §7 `User`/`Role`/
`UserRoleAssignment` model — this client only forwards the token; it does
not interpret or enforce those claims locally (see §4 below — enforcement
is server-side, always).

## 3. Network protocol & API shape

**Decision: HTTPS/TLS 1.2+, JSON bodies matching `patientCaseSchema`'s
existing shape, with the `PatientCasesBackend` interface evolved to add
optional incremental methods rather than staying bulk-only.**

The current interface (`readAll(): PatientCase[]`, `writeAll(cases:
PatientCase[]): void`) is correct and sufficient for a single local file —
but shipping the *entire* case list on every read/write is the wrong
contract for a shared backend serving a multi-user care team: it doesn't
scale past a small case count, and a bulk `writeAll` from one client would
silently clobber concurrent edits from another with no way to detect the
conflict (see §5).

Recommendation: extend `PatientCasesBackend` with two **optional** methods
a backend may implement for efficiency/correctness, while keeping
`readAll`/`writeAll` as the required baseline every backend (including
`localPatientCasesBackend`) must still provide, so this is additive and
non-breaking to the seam that exists today:

```
interface PatientCasesBackend {
  // ...existing name/label/scope/limitations/isAvailable/readAll/writeAll...

  /** Incremental sync: returns cases changed since `cursor` (opaque,
   * backend-defined — a server timestamp or monotonic counter) and the
   * cursor to pass next time. `cursor: null` means "everything". */
  readSince?(cursor: string | null): { cases: PatientCase[]; cursor: string };

  /** Single-case write with optimistic concurrency (see §5). Returns the
   * accepted case + its new version, or a conflict with the server's
   * current version for the caller to reconcile. */
  writeOne?(patientCase: PatientCase, expectedVersion: string | null):
    { patientCase: PatientCase; version: string } | { conflict: true; current: PatientCase };
}
```

Callers in `patient-cases-store.ts` (`listCases`, `createCase`,
`updateCase`, etc.) prefer `writeOne`/`readSince` when the active backend
provides them, falling back to `readAll`/`writeAll` otherwise — the same
optional-capability pattern already established by `isAvailable?()` on
this interface and by `MedicationSafetyProvider`.

**HTTP API a server must implement**, corresponding to the above:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/cases?since={cursor}` | `readSince` — `cursor` omitted or empty means full sync |
| `POST` | `/cases` | Create — server assigns nothing the client doesn't already own (`id` stays client-generated `randomUUID()`, matching today's `createCase`) |
| `PUT` | `/cases/{id}` | `writeOne` — requires `If-Match: {expectedVersion}`; server returns `412 Precondition Failed` + current representation on mismatch |
| `DELETE` | `/cases/{id}` | Delete |

Every request carries the bearer token from §2. Response bodies use the
exact same field shapes as `patientCaseSchema` (`app/src/schemas.ts`) —
no separate wire schema to keep in sync by hand; version this via an
`X-API-Version` header for forward compatibility rather than versioning
the URL path.

**Failure must be loud, never silent-empty.** A new
`SharedBackendUnavailableError` (mirroring `CaseDataLockedError`'s
existing shape and purpose in `case-encryption.ts`) is thrown by the
shared backend's `readAll`/`readSince` on any network failure, timeout, or
non-2xx response — never collapsed to `[]`. This is the same principle
already load-bearing in this codebase for medical-safety ("an unavailable
provider must not collapse to an empty-warning success result") and the
audit log (a failed migration retries rather than silently succeeding) —
"no cases" and "couldn't reach the server" must never look the same to a
clinician.

**Offline behavior**: preserve the local-first value the assessment's §5
point 4 already commits to. A read-through, encrypted local cache
(reusing `case-encryption.ts`'s existing at-rest encryption, not a new
mechanism) holds the last-known-good snapshot; the UI shows a "may be
stale — last synced {time}" banner when serving from cache after a
reachability failure. Writes made while offline queue locally and flush
on reconnect through the same `writeOne` conflict path as any other write
— never auto-resolved, always surfaced if a conflict results (§5).

**Implementation status**: `readSince`, `writeOne`, and `PatientCase.version`
are implemented in `app/src/patient-cases-store.ts` and `app/src/schemas.ts`
as specified above — every read path (`listCases`, `getCase`) and mutation
(`createCase`, `updateCase`, `deleteCase`, `grantConsent`, `revokeConsent`,
`addClinicalNote`, `reviewClinicalNote`) prefers the optional methods when
the active backend provides them, falling back to the original bulk
`readAll`/`writeAll` path otherwise (unchanged for `localPatientCasesBackend`,
which implements neither). One addition beyond this section's original TS
snippet: a `deleteOne?(id, expectedVersion)` method, mirroring `writeOne`'s
conflict shape, was added to close the gap between this section's interface
and its own HTTP API table above, which already specified `DELETE
/cases/{id}` with no corresponding client method. `SharedBackendUnavailableError`
and a new `CaseWriteConflictError` (carrying the backend's current copy, per
§5) are both defined and exported from `patient-cases-store.ts`.

**Known gap, disclosed rather than silently shipped**: `writeOne`/`deleteOne`
take an `expectedVersion` parameter, but no caller in this codebase threads
a UI-loaded version through yet — `updateCase`/`deleteCase` accept it as an
optional trailing argument that every current call site (the IPC handlers in
`app/src/ipc/patient-cases-handlers.ts`) leaves `undefined`, in which case
`patient-cases-store.ts`'s internal `mutateCase` helper falls back to a
version read fresh immediately before the write. That fallback only guards
against a write racing with its own read within the same call — it cannot
detect "a clinician's UI still shows a case version that's since changed
server-side," which is the actual scenario optimistic concurrency exists to
catch. Closing that gap for real requires threading a version from the
renderer's loaded case, through the `patientCases:update`/`patientCases:delete`
IPC channels, into these calls — genuine follow-on work, not done here.

## 4. Multi-tenant data isolation

**Decision: server-side only, enforced against the access token's scope
claims — the client is never trusted for this, full stop.**

The client sends its bearer token; the server resolves organization/role/
scope from it (per the assessment's §7 data model —
`UserRoleAssignment.scope` of `organization | department | patient-list`)
and filters every response accordingly. The client-side `readSince`/
`writeOne` calls carry no tenant/organization identifier of their own —
there is nothing for a compromised or buggy client to spoof, because
scoping is entirely a function of the token the server already validated.

This is a hard *precondition*, not a nice-to-have: shipping a shared
`PatientCasesBackend` without server-side scoping enforcement would be
strictly worse than the current local-only design, since it would create
a shared store with no isolation guarantee at all. A reference server
implementation must have isolation enforcement covered by the kind of
test the assessment's §11 already specifies: "unauthorized-access
rejection tests per role/scope combination."

## 5. Concurrent-write semantics

**Decision: optimistic concurrency with a per-case version, reject-and-
surface on conflict — no automatic merge, ever, for this data.**

Every case carries a server-assigned `version` (opaque string — a
timestamp or monotonic counter, backend's choice) alongside its existing
`updatedAt`. A `writeOne` call includes the version the client last saw
(`expectedVersion`); the server accepts only if it still matches current
state, otherwise responds `412` with the current server-side version of
the case.

On conflict, the client does **not** attempt to auto-merge. It surfaces
the situation to the clinician explicitly — "This case was updated by
someone else since you loaded it" — and requires an affirmative choice
(reload and reapply, or view a diff and pick which fields to keep). This
is a deliberate rejection of CRDT-style automatic merging: silently
combining two independently-edited versions of free-text clinical
narrative (`clinicalNotes`, `presentingComplaint`, etc.) risks producing
a document that reads as coherent but was never actually reviewed as a
whole by anyone — worse than an explicit conflict a human resolves. This
applies uniformly to the whole case object, including the structured list
fields (`allergies`, `medications`) that could in principle merge more
safely (e.g. union of additions) — one conflict-resolution UX for the
whole case is simpler to reason about and test than field-by-field merge
rules, and the safety cost of getting a per-field merge rule wrong for
clinical data outweighs the UX cost of an occasional "someone else edited
this, reconcile it" prompt.

## 6. Migration path

**Decision: explicit, one-time, user-initiated import — no silent/
automatic migration, no ongoing dual-write.**

A new "Import local cases to shared backend" action (Settings, alongside
the existing `PatientCasesBackendSection`) reads the local store directly
via `localPatientCasesBackend.readAll()` — the same local-file-only path
`getAllCasesForMigration()` already uses, bypassing whichever backend is
currently active — and `POST`s each case to the shared backend, keyed by
its existing client-generated `id`. The server-side create endpoint must
be idempotent on `id` (insert-if-not-present, skip if already there),
exactly mirroring the pattern already proven in
`lib/src/store/audit.rs`'s `migrate_audit_log_from_json`: safe to re-run
after a partial failure without duplicating records.

After a successful import, local cases are **not** automatically deleted
— matching this repo's established pattern of never silently discarding
data on a backend switch (the audit log's JSON file stays as a rollback
path even after a SQLite migration completes). The user clears local
cases explicitly afterward if they choose to.

**No ongoing dual-write.** Once `selectPatientCasesBackend` points at the
shared backend, all business logic goes through it exclusively — the
existing single-active-backend design is kept as-is rather than adding a
dual-write mode, which would introduce an entire class of consistency
bugs (which backend is authoritative if they disagree?) for a benefit
(near-zero-downtime cutover) that doesn't matter for what is, at cutover
time, a single clinician's local case list.

## 7. Audit trail implications

**Decision: the local audit log stays authoritative and hash-chained
exactly as today; a best-effort async shipping queue additionally
forwards new events to a central audit-ingestion endpoint once identity
(§2, and by extension the assessment's Phase 1) exists to populate an
authenticated actor on each event.**

This directly follows the assessment's own §5 point 2 ("audit events are
shipped, not just stored locally... local logs stay hash-chained
regardless of connectivity so a gap in shipping doesn't create a gap in
integrity") — this document is the concrete client-side counterpart:

- `audit-log-store.ts`'s `recordEvent()` gains a fire-and-forget shipping
  step: on successful local record, enqueue the event for shipping;
  never block or fail the local write on shipping success. A shipping
  failure (offline, server down) queues for retry — it never drops the
  local record, and it never blocks the calling code path (chat, case
  edits) on network I/O.
- Shipped events use the same bearer token as the `PatientCasesBackend`
  connection (§2) — one authenticated identity for both, not two
  separate credential flows.
- Server-side storage/aggregation of shipped events (a central,
  tamper-evident sink across an institution's whole fleet) is explicitly
  the control-plane's responsibility per the assessment's §5, not
  specified further here — this document only specifies what the client
  sends and when.
- Recommend co-locating the audit-ingestion endpoint with the case
  backend server initially (one server, two endpoint groups) rather than
  standing up a second service before there's a load reason to split
  them — premature separation adds operational surface without a
  concrete benefit yet.

Actor identity on shipped events (`actorUserId`, per the assessment's §7
`AuditEvent` extension) is populated from the same access token as
everything else here — this is one of the concrete reasons identity is a
hard dependency, not just a nice-to-have, for centralized audit to mean
anything (an unauthenticated audit event is exactly the "no accountability"
gap the assessment's §2.4 already flags).

## 8. Security review surface

Enumerated for a future formal review — not resolved here:

- **Token storage and refresh handling** — inherits `mcp-oauth.ts`'s
  existing design (§2), but a shared-backend token grants access to PHI
  directly (unlike an MCP server token, which grants tool access); review
  should confirm the same storage mechanism is an adequate control for
  the higher sensitivity of what it protects.
- **TLS configuration** — minimum version, cipher suite policy, and
  whether certificate pinning is warranted given this is a fixed,
  institution-configured endpoint (not a dynamic set of servers like MCP).
- **Server-side tenant isolation** (§4) — needs penetration testing
  against the specific server implementation, not just a code read of
  this design.
- **Payload-level encryption beyond TLS** — open question, not resolved
  by this document. `case-encryption.ts`'s local-at-rest model assumes a
  single passphrase-derived key for one device; there is no obvious
  multi-user equivalent without a KMS wrapping keys per-recipient, which
  is explicitly Phase 1+ work in the assessment's roadmap (§5 point 5).
  Recommendation: do not block the shared `PatientCasesBackend` on this —
  TLS-in-transit plus server-side-at-rest encryption (an infrastructure
  responsibility of whoever runs the server, per §1) is the interim
  posture, explicitly documented as such rather than silently assumed
  equivalent to end-to-end encryption.
- **Conflict-resolution UI data exposure** (§5) — confirm a conflict
  response never exposes another user's edit to a case the requesting
  user isn't authorized to see the current state of (i.e. the 412
  response's "current version" payload must pass through the same
  authorization check as any other read, not bypass it because it's
  attached to a write attempt).
- **Logging discipline** — the shared-backend client must never log
  request/response bodies (which contain PHI) at any log level, matching
  the standard already enforced in `audit-log-store.ts` and
  `medical-safety.ts` (log identifiers/outcomes, never payloads).
- **Rate-limiting/DoS resistance** of the server — a requirement on any
  server implementation, out of this client-focused document's scope to
  design.

## 9. Explicitly out of scope

- **A reference server implementation.** This document specifies the
  contract (§3); building a server that satisfies it is separate,
  substantial future work.
- **Identity provider implementation.** Delegated entirely to the
  institution's OIDC provider (§2) — this app is a relying party only,
  now and in any future phase.
- **Automatic (CRDT-style) conflict merging** (§5) — rejected for this
  data on clinical-safety grounds, not merely deferred.
- **Multi-region/data-residency architecture** beyond noting it's the
  assessment's `Organization.dataResidencyRegion` (§7) concern for
  whoever operates the server (§1) — this document doesn't design a
  multi-region topology.
- **Terminology/medication-safety data licensing** — an entirely
  separate axis, already addressed by the `MedicationSafetyProvider` seam
  and unrelated to patient-case storage location.
- **Sharing any other local store** (`sessions.json`, Evidence Library,
  Settings) via this same mechanism. This document is scoped to Patient
  Cases (and, per §7, audit shipping) specifically; extending the same
  pattern to other stores is a future decision to make on its own merits,
  not an assumed follow-on.
- **A managed/hosted service ModelForge operates** (§1) — the business
  and compliance commitment that would require is explicitly not an
  engineering-design decision.

---

## Summary

**Recommended topology, in one paragraph:** an institution (or a future
engagement) stands up and operates its own server implementing the HTTP
API specified in §3 — this repository never becomes a SaaS operator.
The desktop client authenticates to it via OIDC Authorization Code+PKCE,
reusing the exact loopback-redirect/`secrets-store.ts` pattern already
working for MCP server OAuth (`app/src/mcp-oauth.ts`) rather than
building a second auth mechanism. The `PatientCasesBackend` interface
gains optional `readSince`/`writeOne` methods for efficient, conflict-
aware sync while `readAll`/`writeAll` stay as the required baseline every
backend (including today's local one) implements — additive, not
breaking. Concurrent edits use optimistic concurrency with no automatic
merging; conflicts are always surfaced to a clinician, never silently
resolved. Migration from local to shared is an explicit, idempotent,
one-time import with no ongoing dual-write. The audit trail stays locally
authoritative and hash-chained exactly as today, with best-effort
shipping added once identity exists to populate an authenticated actor
per event.

**The three riskiest open decisions**, in order:

1. **Evolving the `PatientCasesBackend` interface** (§3) — adding
   `readSince`/`writeOne` is the single largest design choice in this
   document with real implementation cost on both the local and shared
   sides; the alternative (keep bulk-only, accept it doesn't scale well)
   is simpler but was rejected here on scaling/conflict-detection
   grounds. Worth a second engineering opinion before committing.
2. **Conflict-resolution UX** (§5) — "reject and require manual
   reconciliation" is the clinically-safe default, but whether real care
   teams will find that acceptable in practice (versus wanting some
   assisted merge) is a product/clinical-workflow question this document
   answers from a safety-first engineering stance, not from observed
   clinician behavior. Needs validation with actual users, not just
   architectural reasoning.
3. **Deferring payload-level encryption beyond TLS** (§8) — explicitly
   punted to a not-yet-built KMS phase; this is a real gap in the interim
   state that a security reviewer may reasonably want closed sooner,
   depending on the sensitivity of what's being shared and the specific
   institution's risk tolerance.

**What should get explicit human-architect sign-off before implementation
starts:**

- The topology decision itself (§1) — bring-your-own-server, no managed
  ModelForge-operated service — since it has real business/support-model
  implications beyond engineering.
- The conflict-resolution direction (§5) — ideally validated with input
  from someone representing actual clinical/care-team workflow, not
  engineering judgment alone.
- The decision to ship without payload-level encryption beyond TLS in the
  first iteration (§8) — an explicit, documented risk-acceptance call,
  not a default that should happen by omission.
