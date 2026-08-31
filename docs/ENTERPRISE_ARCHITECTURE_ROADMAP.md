# ModelForge Enterprise Architecture Roadmap

## Executive Summary

ModelForge already has useful enterprise building blocks: an Electron security boundary, local encrypted stores, signed device policy, audit chaining, OIDC/JWKS verification, a Fastify/PostgreSQL server prototype, an IAM policy evaluator, and a shared patient-case adapter.

It is not yet a safe multi-user system. The critical path is:

1. Make identity and tenant context trustworthy.
2. Make cross-tenant access structurally impossible below the HTTP layer.
3. Establish bounded revocation for tokens, memberships, policies, and cached grants.
4. Make shared cases authoritative, resource-aware, conflict-safe, and synchronizable.
5. Centralize immutable audit, administration, policy distribution, and operational controls.
6. Only then expand shared data domains and enterprise integrations.

**Status note (2026-08-28): the paragraph below is the original P0-era
assessment and is now stale — it was never updated as P0 and P1 items 1-8
landed, and it contradicted this document's own §2 capability matrix even
before today. Kept for historical record of the starting state; do not
treat it as current. See §14's P0/P1 backlog for verified current status.**

The highest-risk gaps *at the time this document was first written* were:

- The Electron OIDC callback had PKCE but no OAuth state or OIDC nonce. **Fixed** — `app/src/shared-backend-auth.ts` implements state, nonce, PKCE, and a random per-attempt loopback port (see §14 P0 item 3).
- A compromised renderer could configure an arbitrary shared-backend URL and cause the main process to send it a bearer token. Partially addressed — `isAllowedRemoteUrl`/`requireAllowedRemoteUrl` in that same file constrain it to HTTPS (or an explicit loopback dev endpoint); full removal of renderer influence over trusted origin configuration (§14 P0 item 4) has not been separately re-verified in this pass.
- OIDC audience validation was optional. **Fixed** — `server/src/config.ts`'s `loadConfig` requires `OIDC_AUDIENCE` and fails startup without it.
- Tenant safety depended primarily on route-layer checks; IAM repositories exposed unscoped operations. **Addressed** — `TenantContext`-bound repositories, schema-per-tenant clinical data, and RLS on shared control-plane tables (migrations 007-010).
- Redis failure could leave stale grants on other instances until cache TTL expiry. **Addressed** — durable authorization epochs (migration 004) checked from Postgres before trusting a cached decision; see §9.
- Shared case payloads were opaque JSON, so resource-level authorization/consent/ownership couldn't be enforced. **Fixed** — strict `@modelforge/contracts` schema validation plus server-derived `CaseResourceAttributes`.
- Case deletion had no tombstone; the incremental cursor could skip concurrent changes. **Fixed** — transactional change feed with tombstones (`case_changes`/`chat_session_changes` tables).
- The admin console, invitations, access reviews, service identities, centralized policy delivery, and central audit service did not exist. **All now exist** — see §14 P1 items 1-4 (admin console, break-glass/access-reviews, policy versioning minus signing, immutable audit chain/search/export/legal-hold); invitations and service identities shipped as part of P0.
- PostgreSQL integration suites were skipped because no test database was configured locally. **CI now runs them** — `.github/workflows/ci.yml` provisions real `postgres:16-alpine`/`redis:7-alpine` services (§14 P0 item 18); they remain `describe.skipIf(!DATABASE_URL)` in this specific dev environment only (see `reference_modelforge_dev_env` — no local Postgres/Redis available here), not in CI.

The recommended deployment is institution-operated and self-hosted, with an initial modular monolith rather than premature microservices. Local/personal mode remains fully supported and does not require the enterprise server.

## 1. Evidence Baseline and Documentation Reconciliation

The source currently overrides several stale statements in the design documents:

- `server/` now exists even though `docs/ENTERPRISE_READINESS_ASSESSMENT.md`, `docs/SHARED_BACKEND_DESIGN.md`, and `docs/HARNESS_INTEGRATION.md` still describe the backend as absent or out of scope.
- Some enterprise design references use `packages/server/`; the current implementation is under `/home/saldev/projects/modelforge/server`.
- The clinical-workspace documentation says only the local patient backend is registered; current main-process code registers the shared backend.
- The server README still describes the case store as in-memory-only, while current startup code can construct `PostgresCaseStore`.

Verification performed:

- Server: 11 test files passed, 2 skipped; 193 tests passed, 25 skipped.
- Electron targeted suites: 7 files and 140 tests passed.
- Skipped coverage includes the real PostgreSQL case and IAM integration suites.
- Initial and final Git status were identical: 53 modified and 42 untracked paths pre-existed this review.

## 2. Current-State Capability Matrix

**Local/personal mode**
Status: Implemented and verified.
Evidence/gap: Current local stores remain a sound product mode.

**Electron process isolation**
Status: Implemented, mostly hardened (2026-08-28).
Evidence/gap: `contextIsolation` is true and `nodeIntegration` is false in `app/src/main.ts`. IPC caller verification (`app/src/ipc/trusted-sender.ts`) and a renderer CSP (`app/src/csp.ts`, report-only — see P0 item 20 in §14) now exist. Explicit sandboxing (`webPreferences.sandbox: true`) remains — not attempted, needs a live packaged-app launch to verify safely (none available in the environment this was built in).

**Local encryption**
Status: Implemented, conditional.
Evidence/gap: Electron `safeStorage` is used, but managed mode can fall back to plaintext if the OS facility is unavailable. Enterprise mode must fail closed or use an approved alternative.

**Signed device policy**
Status: Implemented locally.
Evidence/gap: Last-known-good fail-closed behavior exists. The key and policy are still locally replaceable and there is no central distribution service.

**Local audit**
Status: Implemented, insufficient for enterprise.
Evidence/gap: Hash-chained local log, capped retention, no authoritative actor/tenant fields, and user-clearable data.

**Local backup/restore**
Status: Implemented.
Evidence/gap: Encrypted profile backup and restore exist; RPO is app-activity-dependent and restore is not tenant-aware.

**Server OIDC verification**
Status: Implemented and unit-tested.
Evidence/gap: JWT signature, issuer, expiry, optional audience, and subject checks exist. Production audience and revocation controls are incomplete.

**Electron OIDC flow**
Status: Implemented, unsafe for production.
Evidence/gap: PKCE and refresh exist; state, nonce, random callback port, endpoint binding, full logout, and a timeout policy do not.

**Organization discovery**
Status: Implemented.
Evidence/gap: `/me` returns active memberships, but creation is self-service for any authenticated user and organization ownership/provisioning is immature.

**Users, groups, and policies**
Status: Implemented prototype.
Evidence/gap: Domain types, CRUD APIs, and PostgreSQL stores exist. Real PostgreSQL behavior was not verified during this review.

**Default-deny authorization**
Status: Implemented and tested.
Evidence/gap: Explicit deny precedence exists. Condition vocabulary and resource scopes are too limited.

**Custom roles**
Status: Partially implemented.
Evidence/gap: Groups plus attached policies can express roles. There is no typed scope model, permission boundary, platform-role separation, or approval workflow.

**Invitations and provisioning**
Status: First-class invitations implemented.
Evidence/gap: Pending invitations, hashed acceptance tokens, expiry, revocation, identity binding, and active memberships exist. JIT policy, SCIM, and external group mapping remain absent.

**Service identities/M2M**
Status: First-class service principals implemented.
Evidence/gap: OIDC issuer/subject binding, lifecycle state, direct policies, permission boundaries, authorization, and audit actor representation exist. Credential issuance remains the external IdP's responsibility.

**Break-glass/access reviews**
Status: Implemented (2026-08-27, P1 item 2).
Evidence/gap: Justification-driven, immediately-granted, time-bound emergency access to one pre-configured per-org emergency policy, with mandatory post-hoc review; access-review campaigns snapshot memberships at creation, self-review is rejected. Migration `011_break_glass_and_access_reviews.sql`. No certification-campaign scheduling automation (campaigns are created on demand, not recurring).

**Shared patient cases**
Status: Tenant-safe implementation complete; production database validation pending.
Evidence/gap: The HTTP adapter, tenant repositories, full case model, resource authorization, and staged migration exist. The real PostgreSQL suite remains environment-gated.

**Case schema validation**
Status: Complete for the current versioned contract.
Evidence/gap: App, renderer, server, and migration tooling consume the strict `@modelforge/contracts` patient/case/consent schema. Contract version evolution still needs a compatibility policy.

**Tenant isolation**
Status: Hybrid model implemented; production database validation pending.
Evidence/gap: PHI-bearing clinical data is schema-per-tenant. Shared IAM metadata uses tenant-bound repositories plus RLS. Real pooled-connection/RLS tests still require `DATABASE_URL`.

**Optimistic concurrency**
Status: Partially implemented.
Evidence/gap: General update/delete use versions; several consent, note, and review operations fetch the newest version in `main` and can overwrite a stale UI edit.

**Durable synchronization**
Status: Transactional change feed implemented.
Evidence/gap: Snapshot-consistent high-water cursors, upserts, tombstones, and incremental client application exist. Push notifications and offline writes remain outside this slice.

**Offline enterprise editing**
Status: Implemented (2026-08-28, P1 item 5).
Evidence/gap: OS-keychain-backed encrypted per-organization cache (`app/src/case-offline-cache.ts`), transparent write-queue-and-flush-on-reconnect wrapping `PatientCasesBackend`, `Idempotency-Key`-threaded outbox replay, explicit-sign-out quarantine. No structured field-by-field conflict UI (a minimal case-list-and-discard version instead — no auto-merge, by design); does not yet distinguish "offline" from "access revoked while still connected." Not exercised in a live Electron runtime in this dev environment (no display available).

**Local-to-shared migration**
Status: Staged workflow implemented.
Evidence/gap: Verified encrypted backup, idempotent/resumable batches, full validation, collision preview, explicit activation, backend cutover, and tombstone rollback exist. Operational signing and real PostgreSQL failure-injection remain pending.

**Admin console**
Status: Implemented (2026-08-27, P1 item 1).
Evidence/gap: Separate `admin-console/` web app (Vite+React+TS, OIDC Authorization Code+PKCE) with all 6 IAM screens (Users, Invitations, Groups, Policies with dual-control history, Service Principals, Audit) plus BreakGlass, AccessReviews, and Backup screens added in later items. Gated client-side on the same permissions the server enforces (UX only, never the trust boundary). Bundle-load verified with zero console errors; full authenticated click-through not exercised (no OIDC/seeded-org harness in this dev environment).

**Central audit/control plane**
Status: Partially implemented (2026-08-28, P1 item 4; item 3 minus signing).
Evidence/gap: Centralized append-only audit now exists — per-organization SHA-256 hash chain (migration `013_audit_immutability_and_legal_hold.sql`, `UPDATE`/`DELETE` revoked from the runtime role), server-side search/filter/cursor-pagination, CSV export, legal-hold records. Central *policy* distribution exists as immutable `PolicyVersion` rows with a dual-control propose/approve/reject/rollback workflow (migration `012_policy_versions.sql`) — explicitly **not cryptographically signed** (plain SHA-256 `contentHash` only, documented as an integrity/audit aid, not a signature — no certificate/key-custody infrastructure built, by the user's own standing instruction). The direct `PATCH .../policies/:policyId` path still bypasses the dual-control workflow for a caller holding broad `iam:managePolicies` — a disclosed, intentional gap. No feature-flag or entitlement service.

**Observability**
Status: Metrics/dashboard implemented (2026-08-28, P1 item 8); tracing/exporters still absent.
Evidence/gap: `server/src/metrics.ts` exposes PHI-free Prometheus metrics at `GET /metrics` (HTTP/authz-decision/audit-write latency histograms, audit-write outcome counts, authorization-cache stats, Node.js process metrics) plus a bundled importable Grafana dashboard (`server/observability/grafana-dashboard.json`) wired to this document's own §17 objectives — see `docs/OBSERVABILITY.md`. Split liveness (`/health/live`) vs. readiness (`/health/ready`) probes added alongside the original `/health`. No Prometheus/Grafana/alerting deployment, no SLO burn-rate alert rules, no distributed tracing, no SIEM export — all named explicitly as operator/infrastructure decisions this repository cannot make on its own.

**Deployment/HA**
Status: Prototype.
Evidence/gap: Graceful shutdown and health handling exist. There is no production image, TLS ingress, PostgreSQL topology, migration orchestration, or DR automation.

**MCP governance**
Status: Strong local foundation, incomplete enterprise model.
Evidence/gap: Per-tool policy and audit exist, but no institutional registry or centrally managed allowlist. MasterVault write/search symlink handling was already implemented (confirmed 2026-08-28 — the earlier note here was stale) and now has 14 adversarial tests proving it against real on-disk symlinks (`mastervault-mcp-server/src/services/vault.test.ts`); that package had no test framework installed at all before this.

**Supply chain**
Status: Partial (2026-08-28: SAST/secret-scanning/Action-pinning/Dependabot-cooldown added).
Evidence/gap: CI, dependency updates, SBOM generation, SAST (Semgrep), secret scanning (gitleaks), Dependabot cooldown periods, and pinned-by-SHA GitHub Actions now exist (see P1 item 9 in §14). License gates, provenance, artifact signing, and release revocation are still missing — signing/provenance need real certificates/key-custody infrastructure out of this repository's authority.

**Tenant backup/restore (enterprise)**
Status: Implemented (2026-08-28, P1 item 6).
Evidence/gap: On-demand tenant data export plus dual-control reconciliation-restore (`server/src/store/tenant-backup-store.ts`) — pure `pg`-client JSON across all in-scope tables, uniform `INSERT ... ON CONFLICT DO NOTHING` restore semantics (never overwrites an existing row — deliberately not a true point-in-time rollback), cross-tenant restore refused outright. No real continuous PITR (WAL-archiving infrastructure) and no backup-custody/object-storage product choice — both named §19 infra decisions. The Postgres-dependent fidelity/cross-tenant-safety test suite has never run against a real database in this dev environment — the highest-stakes unverified suite in the codebase (writes across ~20 tables in one transaction).

**Additional shared clinical domains**
Status: One additional domain implemented (2026-08-28, P1 item 7).
Evidence/gap: Shared chat sessions (`server/src/routes/sessions.ts`, migration `015_shared_chat_sessions.sql`) — same tenant-schema placement and authorization shape as patient cases, owner/assigned-user visibility model. Local-only fields (device tuning, filesystem paths, device-only chat organization) deliberately never sent to the server. Other named-but-not-yet-built shared domains (evidence, projects, patient lists — Phase 4 scope) remain absent.

## 3. Target Enterprise Architecture

**Institution-controlled device**

```
Untrusted renderer
  - UI only
  - No tokens, tenant authority, filesystem, or KMS access
  - Narrow, schema-validated IPC to Electron main

Electron main / enterprise agent
  - OIDC authorization-code flow with PKCE
  - Secure token vault
  - Authenticated enterprise API client
  - Signed policy/configuration cache
  - Encrypted tenant/account cache and durable sync outbox
  - Audit delivery spool

Local-only boundary
  - Local inference runtime
  - Governed MCP tools
  - Full local/personal mode

External dependencies
  - System browser to external institutional IdP
  - TLS/mTLS where applicable to institutional ingress/API gateway
```

**Institution-operated ModelForge deployment**

```
Initial modular Fastify application, independently scalable by module:
  - Identity/membership and authorization
  - Clinical case and synchronization service
  - Policy/configuration/entitlement service
  - Audit ingestion and outbox publisher
  - Admin console BFF
  - Optional SSE/WebSocket notification channel

Authoritative infrastructure:
  - PostgreSQL for control-plane and clinical data
  - Redis for performance and ephemeral notification only
  - Object storage for attachments, exports, and backup artifacts
  - KMS/HSM for key wrapping
  - Immutable audit store plus query index
  - Metadata-only observability and sanitized SIEM export
```

Start as a modular monolith with hard module interfaces and separate database roles. Split services only when independent scaling, blast-radius reduction, or an institutional deployment constraint justifies the operational cost.

## 4. Trust Boundaries

1. Browser/IdP to loopback callback: protect with state, nonce, PKCE, exact redirect path, short lifetime, and a random port.
2. Renderer to main: treat renderer content as hostile input. Every IPC channel needs a schema, sender/frame checks, capability limits, and response minimization.
3. Device to institutional ingress: require TLS, exact trusted origin, bearer-token audience binding, redirect rejection, and request-size/rate controls.
4. Application to storage/KMS: use least-privilege service roles, tenant-bound transactions, encryption, immutable audit, and no shared superuser runtime.
5. Admin console: use a separate admin audience/client, permission boundaries, step-up authentication, CSRF protection, and immutable administrative audit.
6. Local inference/MCP: keep a device-local trust zone, a centrally governed tool allowlist in managed mode, filesystem confinement, and explicit data-egress policy.
7. Operations/SIEM: expose metadata-only observability by default. PHI export requires explicit institutional policy and an audit event.

## 5. Deployment Modes

**Local/personal mode**

- Current local stores remain authoritative.
- No server, IdP, organization, or network dependency is required.
- Local policy, audit, encryption, backup, inference, and MCP remain supported.

**Managed enterprise mode**

- Institutional IdP authenticates; ModelForge authorizes.
- Server data is authoritative.
- Device storage is an encrypted, tenant/account-bound cache and outbox.
- Managed configuration is signed and cannot be replaced by renderer input.

**Hybrid inference mode**

- Enterprise clinical data and authorization remain server-authoritative.
- Model execution and approved MCP tools may stay on the device.
- Only policy-approved data crosses the local inference boundary.

## 6. Sources of Truth

- Credentials, MFA, and authenticator enrollment: external IdP.
- Authentication identity: OIDC issuer plus subject, never email alone.
- Verified display name/email: IdP claims, cached as non-authoritative profile attributes.
- Tenant membership and status: ModelForge PostgreSQL.
- Groups, roles, policies, and scoped assignments: ModelForge PostgreSQL.
- Imported IdP group mapping: explicit ModelForge mapping record; raw token group claims do not directly grant access.
- Organization configuration: central ModelForge configuration service.
- Client configuration snapshot: signed cache only; never authoritative.
- Clinical cases, ownership, assignments, consent, and sharing: tenant clinical PostgreSQL schema.
- Attachments and large artifacts: institution-controlled object storage with DB metadata.
- Offline edits: device outbox until acknowledged; server record becomes authoritative after acceptance.
- Audit: transactional DB outbox until published; immutable central audit store thereafter.
- Entitlements/licensing: separate entitlement service/table. Entitlements may expose a feature but must never grant access to data.
- Operational telemetry: monitoring system, logically and physically separated from the clinical audit record.
- Local-mode data: existing local stores only.

## 7. Tenant Isolation Design

Use a hybrid design:

- Shared control-plane tables contain `tenant_id`, composite keys, composite foreign keys, and PostgreSQL RLS.
- Clinical PHI lives in a generated schema per tenant for the initial supported enterprise topology.
- A server-owned tenant directory maps opaque tenant UUIDs to validated schema identifiers. Client input never becomes a SQL identifier.
- Database-per-tenant can be an institutional opt-up later without changing service contracts.
- Inside each clinical schema, department, project, patient-list, ownership, and consent scopes receive row-level enforcement where appropriate.

Every request receives an immutable `TenantContext` after authentication and active-membership resolution. Repositories must be constructed from that context. Unscoped `getUser(id)`, `getCase(id)`, `getPolicy(id)`, and similar operations must not exist in application-facing repository interfaces.

The runtime database role:

- Cannot bypass RLS.
- Cannot create schemas or modify RLS.
- Cannot use cross-tenant control-plane queries.
- Cannot directly access audit or KMS administration.
- Uses `SET LOCAL` only inside a transaction.
- Has separate migration credentials unavailable to the application.

HTTP routes, service methods, repository APIs, SQL constraints, schemas, and RLS all enforce the same tenant invariant. A missing `TenantContext` should make clinical access unrepresentable in application code.

## 8. IAM and Authorization Model

**Tenant/Organization** — UUID, name/slug, lifecycle state, owner assignments, region, tenant-schema locator, policy version, and authorization epoch.

**Identity** — Issuer, subject, verified attributes, and last authentication. Unique on issuer plus subject.

**Membership** — Tenant, user/identity, active/suspended/deprovisioned state, provisioning source, start/expiry, and tenant-local profile.

**Group and GroupMembership** — Tenant-local group, name, type, optional external-directory ID, member, validity interval, and provisioning source.

**PolicyVersion** — Immutable version, typed statements, resource/action catalog version, hash, author, reviewer, and timestamps.

**PolicyAssignment** — Tenant, user/group/service principal, policy version, typed scope, and validity interval.

**Scope/Resource** — Organization, department, project, patient list, or individual resource. Server-maintained hierarchy and attributes.

**Invitation** — Token hash, intended identity/email, tenant, proposed groups/scopes, expiry, inviter, and status.

**ServiceIdentity** — Tenant, external workload subject/client, purpose, owner, state, and last use. Secrets remain in the IdP or workload identity system.

**Session/Device** — Token/session identifiers or hashes, identity, membership, device, issued/expiry/revoked timestamps.

**BreakGlassGrant** — User, resource/scope, justification reference, expiry, approvals, and review result.

**AccessReview** — Campaign, reviewer, assignments under review, decisions, and immutable evidence.

**AuditActor** — Human/service/system type, identity, membership, impersonator, and break-glass context.

**Privilege separation**

- Platform operators manage deployment health and tenant lifecycle, not clinical records.
- Tenant admins manage only their tenant and only delegated policy/action types.
- Security auditors have read-only security evidence access, not clinical-content access by default.
- Clinical roles receive only explicit clinical resources.
- Permission boundaries constrain what tenant admins may delegate, even if they can author custom policies.

**Policy semantics**

- Retain default deny and explicit deny precedence.
- Introduce a versioned action and resource-type catalog.
- Support organization, department, project, patient-list, and individual-resource scopes.
- Load principal, resource, consent, ownership, and environmental attributes on the server.
- Support time, network-zone, device-compliance, purpose-of-use, and emergency-access conditions where institutionally required.
- Make policy versions and assignments immutable, with activation windows.
- Store explainable decisions as policy/version IDs and normalized reason codes.

Security-sensitive attributes must not come from caller-supplied authorization context. The target evaluator must load membership and resource facts itself. Any external authorization-check endpoint should be internal workload-only.

## 9. Revocation and Cached Authorization

Redis remains a performance layer, never the revocation authority.

Each tenant and affected principal has a durable authorization epoch. Every membership, group, policy, assignment, suspension, service-identity, or break-glass mutation:

1. Writes immutable policy/assignment state.
2. Increments the relevant durable epoch in the same PostgreSQL transaction.
3. Writes the administrative audit outbox record.
4. Commits.
5. Publishes best-effort cache invalidation and client notification.

Protected requests read the current epoch from PostgreSQL before using a cached compiled policy keyed by tenant, principal, and epoch. If the epoch cannot be checked, protected operations fail closed. A Redis partition therefore cannot preserve a stale allow decision.

## 10. Critical Request Flows

**Login and organization selection**

1. The main process loads signed managed configuration, not renderer-provided origins.
2. It creates a random loopback port, state, nonce, PKCE verifier/challenge, and short-lived attempt record.
3. The system browser opens the institutional authorization endpoint.
4. The exact callback path and state are checked before code exchange.
5. Discovery and token endpoints must be HTTPS, time-bounded, issuer-matched, and redirect-restricted.
6. ID/access token issuer, audience, signature, lifetime, nonce, and subject are validated.
7. Tokens are stored only in an approved secure facility. Managed mode does not silently fall back to plaintext.
8. `/v1/me` returns active memberships only.
9. Organization selection is stored per issuer/subject on the device. The server independently revalidates it on every request.
10. Logout revokes or ends the provider session where supported, revokes the ModelForge session, clears tokens, closes account-bound caches, and handles unsynchronized edits explicitly.
11. Account switching uses an explicit provider account-selection flow and never reuses the previous tenant cache.

**Authorized case request**

1. Ingress validates transport and request bounds.
2. Server validates issuer, required audience, algorithm, expiry/not-before, token type, subject, and current revocation state.
3. Issuer/subject resolves to identity and active tenant membership.
4. Tenant context is derived; it is never accepted solely from an organization header/path.
5. The authorization epoch is checked.
6. Resource metadata and consent/ownership facts are loaded server-side.
7. Policy is evaluated.
8. The tenant-bound repository and DB/RLS enforce the same decision boundary.
9. Only necessary data is returned.
10. Decision and outcome are placed in the audit outbox.

**Cross-tenant denial**

- No foreign tenant repository is acquired.
- The response is uniformly 404 `resource_not_found` unless disclosure is explicitly permitted.
- No message reveals whether the tenant, patient, or case exists.
- The denial audit record contains only the attempted tenant context and a normalized reason.

**Policy or membership change**

- The write transaction creates an immutable version, applies assignments, increments epochs, and emits the audit outbox.
- Subsequent requests cannot use the previous grant.
- Long-running mutations recheck authorization immediately before commit.

**Deprovisioning**

- An admin or SCIM event suspends the membership, increments the epoch, revokes known sessions, removes or disables assignments, and emits audit in one transaction.
- Online clients are notified and logged out.
- Offline queued changes are quarantined and never uploaded under a new user or tenant.

**Offline edit and reconnect**

Each edit has:

- A UUID idempotency key.
- Account and tenant binding.
- Entity identifier and base version.
- Validated operation payload and schema version.
- Queue state: queued, sending, acknowledged, conflict, denied, or failed.

After reauthentication, each operation is authorized and applied through optimistic concurrency. Duplicate keys with the same request hash return the original response; reuse with a different hash returns a conflict. Denied items stay quarantined for review/export and are not silently discarded.

**Concurrent edit conflict**

- If-Match or an explicit base version is mandatory.
- A mismatch returns 409 or 412 with the current version and safe diff metadata.
- There is no automatic clinical merge.
- The clinician must reload, reapply, or choose fields.
- The resolution audit links both competing versions.

**Audit delivery failure**

- A server mutation and its audit-outbox entry share one PostgreSQL transaction.
- Inability to create the outbox row rolls back the mutation.
- Publishing is idempotent and retried until the immutable store acknowledges it.
- Client-originated events use an encrypted spool with an acknowledgment watermark.
- Disk-full, corruption, or exhausted retry conditions are surfaced rather than reported as successful.

## 11. API and Synchronization Contracts

Introduce URL-major versioning and typed shared contracts:

- `GET /v1/me`
- `GET /v1/tenants/{tenantId}/cases`
- `GET /v1/tenants/{tenantId}/cases/{caseId}`
- `POST`/`PATCH`/`DELETE /v1/tenants/{tenantId}/cases/{caseId}` with `Idempotency-Key` and `If-Match`
- `GET /v1/tenants/{tenantId}/changes?after={sequence}&limit={n}`
- IAM APIs for memberships, groups, policy versions, assignments, invitations, service identities, access reviews, and break-glass grants
- Internal audit ingestion and authorization APIs using workload identity
- Signed configuration/policy snapshot APIs

Extract strict, versioned schemas from the desktop app into a package shared by server, main process, renderer, migration tooling, and tests.

The synchronization feed must be a transactional change log:

- Mutation and monotonically ordered `change_sequence` entry commit together.
- Deletes produce retained tombstones.
- Bootstrap returns a stable snapshot sequence and paginated rows.
- Incremental synchronization begins strictly after that snapshot sequence.
- SSE/WebSocket messages only say that changes are available; they are not the durable source.
- Redis Pub/Sub may accelerate notification but cannot affect correctness.

## 12. Encryption and Key Hierarchy

- Institutional KMS/HSM root keys wrap tenant key-encryption keys.
- Tenant KEKs wrap domain DEKs for database fields, object storage, exports, and backups.
- Key IDs and ciphertext metadata are stored with records; plaintext keys are not.
- Rotation normally rewraps DEKs without rewriting all data.
- Tenant suspension can disable unwrap operations without deleting ciphertext.
- Recovery and destructive rotation require dual control and immutable audit.
- Device cache/outbox keys are unique to account and tenant and sealed to the OS secure store.
- Managed mode fails closed if approved secure storage is unavailable.
- Logout and account switching close keys immediately; retention or secure purge of pending data follows explicit institutional policy.

TLS protects traffic, but this model should not be described as end-to-end encryption. True E2E encryption would materially restrict server-side search, policy evaluation, and recovery, so it remains a separate later product decision.

## 13. Phased Roadmap

### Phase 0 — Architecture Decisions and Safety Baseline

**Scope:** ADRs for deployment, tenancy, identity claims, policy semantics, revocation, audit, offline behavior, and API versioning. Shared contracts, threat models, and real dependency test harness.

**Exclusions:** No production clinical data and no migration cutover.

**Prerequisites:** Product, clinical, security, legal, and infrastructure representatives assigned.

**Components:** Server, Electron main/preload, renderer, shared contracts, test infrastructure, deployment skeleton, and MCP boundary.

**Data changes:** Additive draft IAM v2 and audit schemas; fixture-only tenant schemas.

**Security:** PHI inventory, trust-boundary review, IPC inventory, action/resource catalog, and redaction rules.

**Migration:** None.

**Tests:** Real PostgreSQL/Redis in CI, fake standards-compliant IdP, mandatory scenario skeletons, and log-canary scanner.

**Operations:** Reproducible server image, configuration validation, separate liveness/readiness contracts, and migration job design.

**Acceptance:** No PostgreSQL suite is skipped. ADRs and schemas are approved. Documentation paths match the source. P0 threat findings have owners.

**Rollback:** Documents/contracts only; prototype remains unchanged.

**Advance when:** Tenancy, identity, revocation, audit, and offline decisions are locked.

### Phase 1 — Production Identity and Authorization Vertical Slice

**Scope:** Hardened Electron OIDC, account switching/logout, required audience, provider compatibility checks, membership model, invitations/bootstrap, service identities, tenant-bound IAM repositories, permission boundaries, durable authz epochs, and a minimal admin workflow.

**Exclusions:** Broad clinical migration, SCIM, and complete offline editing.

**Prerequisites:** Phase 0 ADRs and an institutional test IdP.

**Components:** OIDC client/verifier, identity and session services, IAM APIs, policy evaluator, tenant directory, admin bootstrap page, and audit outbox.

**Data changes:** Identity, membership, group, policy-version, assignment, scope, invitation, service-identity, session, and epoch tables.

**Security:** State/nonce/PKCE, random callback port, exact trusted API origin, no cross-origin redirects, token revocation strategy, and step-up for sensitive administration.

**Migration:** Map current users/policies only in nonproduction; no implicit email-based account joining.

**Tests:** Malicious callback, token confusion, wrong audience/issuer, renderer URL manipulation, cross-tenant IAM access, explicit deny, epoch/cache failure, org-admin boundary, and M2M credentials.

**Operations:** IdP/JWKS health, revocation metrics, secure bootstrap, signing-key rotation, and incident runbooks.

**Acceptance:** Synthetic login-to-authorized-resource path succeeds. All identity/authorization P0 scenarios pass. Policy and membership revocation meet the agreed bound.

**Rollback:** Enterprise feature flag and additive DB migration; local mode remains available.

**Advance when:** Production-like identity, tenancy, and revocation are demonstrably fail-closed.

### Phase 2 — Tenant-Safe Shared Cases and Migration

**Scope:** Full server-side case schema, patients, consent, ownership, assignments, and sharing. Schema-per-tenant storage, optimistic concurrency, idempotency, durable change log/tombstones, online-first desktop adapter, migration preview, and cutover.

**Exclusions:** Other shared domains, CRDT collaboration, and general offline write synchronization.

**Prerequisites:** Phase 1 IAM and tenant repository framework.

**Components:** Case resource service, patient/consent service, sync feed, migration API/worker, and corrected desktop error states.

**Data changes:** Tenant clinical schemas, resource hierarchy, version history, idempotency records, and change sequence.

**Security:** Server-derived resource attributes, consent enforcement, RLS defense-in-depth, and uniform nondisclosure.

**Migration:** Staged, resumable, and non-destructive local-case import with validation and rollback.

**Tests:** Overlapping IDs in two real PostgreSQL tenants, pooled-connection leakage, unauthorized collection enumeration, delete tombstones, cursor snapshots, stale consent/note edits, migrations, and simulated network failures.

**Operations:** Per-tenant backup before cutover, migration telemetry, and queue throttling.

**Acceptance:** Shared case CRUD is tenant-safe, schema-valid, and conflict-safe. Migration completes without deleting the source. Network failures never appear as an empty dataset.

**Rollback:** Return the client to local authority using the preserved local backup. Uploaded tenant data is quarantined, not silently purged.

**Advance when:** Cases can be operated safely with real PostgreSQL under fault injection.

### Phase 3 — Administration, Access Governance, and Central Audit

**Scope:** Full admin console, group/policy lifecycle, invitations, access reviews, break-glass, central signed configuration, separated entitlements, and immutable audit search/export/legal hold.

**Exclusions:** General SCIM and SIEM integrations.

**Prerequisites:** Phase 2 resource scopes and audit outbox.

**Components:** Admin BFF/UI, access-governance service, policy/config service, audit publisher, immutable storage, and query index.

**Data changes:** Review campaigns, decisions, break-glass grants, policy approvals, signed snapshots, audit actor/resource/outcome schema, and retention/hold records.

**Security:** Tenant-admin permission boundaries, dual control, step-up authentication, and no tenant-admin access to platform operations.

**Migration:** Local audit remains local historical evidence; it is not relabeled as centrally authoritative.

**Tests:** Privilege escalation, self-approval, expired grants, audit tampering, publisher replay, legal hold, and tenant-safe export.

**Operations:** Audit-lag alerts, policy rollout/rollback, emergency-access review, and signing-key procedures.

**Acceptance:** All administrative changes are attributable, reviewable, and bounded. Acknowledged mutations cannot lose their audit records.

**Rollback:** Previous signed policy snapshot and policy versions can be reactivated. Audit is never rolled back or deleted.

**Advance when:** Institutions can operate access without database intervention.

### Phase 4 — Remaining Shared Domains, Offline Sync, and DR

**Scope:** Encrypted account-bound cache/outbox, reconnect processing, shared sessions/evidence/projects/patient lists, attachments/object storage, durable notifications, centralized backup/restore, and disaster recovery.

**Exclusions:** Unvalidated automatic clinical merges and broad external integrations.

**Prerequisites:** Stable case contracts, audit, and governance.

**Components:** Local encrypted SQLite cache, sync worker, object service, domain modules, backup coordinator, and restore tooling.

**Data changes:** Domain change logs, outbox/idempotency retention, attachment metadata, backup manifests, and recovery checkpoints.

**Security:** Offline retention controls, per-account keys, quarantine after deprovision, signed object URLs, malware scanning, and restore authorization.

**Migration:** Domain-specific preview/import pipelines. Never infer enterprise consent from a local flag without an approved mapping.

**Tests:** Restart-safe queueing, duplicate delivery, out-of-order notifications, deprovisioned-client reconnect, object authorization, and cross-tenant restore attempts.

**Operations:** PostgreSQL PITR, object versioning, immutable audit retention, and scheduled restore drills.

**Acceptance:** Queued writes survive restart, replay exactly once in effect, expose conflicts, and meet stated backup RPO/RTO.

**Rollback:** Stop new shared-domain writes, preserve server state, and export unresolved client queues for authorized recovery.

**Advance when:** Disconnected clinical work and recovery drills meet safety criteria.

### Phase 5 — Production Operations and Scalability

**Scope:** HA, load/failure testing, metrics/traces/logging, SLO alerting, canary releases, online migrations, capacity planning, support diagnostics, and supply-chain hardening.

**Exclusions:** New clinical capabilities.

**Prerequisites:** Representative institutional workloads and recovery tooling.

**Components:** Production deployment templates, ingress, autoscaling, observability, migration controller, signing/provenance, and operational dashboards.

**Data changes:** Compatible expand/contract migrations and capacity indexes.

**Security:** Secret scanning, SAST, signed artifacts, provenance, vulnerability SLAs, diagnostic redaction, and least-privilege operator access.

**Tests:** Load, soak, chaos, regional dependency failure, upgrade/downgrade compatibility, and no-PHI telemetry canaries.

**Operations:** Blue/green or canary rollout, N-1 client/API compatibility, rollback automation, and incident exercises.

**Acceptance:** Provisional SLOs pass under load and failover. Backup and release rollback are repeatedly demonstrated.

**Rollback:** Versioned application rollback with forward-compatible schema. Destructive contraction occurs only after the compatibility window.

**Advance when:** Operations can support production without engineering-only procedures.

### Phase 6 — Enterprise Integrations and Evidence

**Scope:** SCIM, external group mapping, SIEM, proxies/custom CAs, multiple IdPs, regional deployment, controlled FHIR/EHR integrations, governance exports, and formal evidence packages.

**Exclusions:** Claims that technical controls alone establish regulatory compliance.

**Prerequisites:** Stable IAM, consent, audit, tenancy, change management, and institutional ownership.

**Components:** Integration gateway, SCIM service, SIEM exporter, regional tenant directory, and evidence automation.

**Data changes:** Provisioning cursors, connector credentials/ownership, export manifests, and regional-placement controls.

**Security:** Workload identity, least-privilege connector scopes, egress policy, replay protection, reconciliation, and kill switches.

**Migration:** Per-integration staged rollout and reconciliation.

**Tests:** Provider compatibility, SCIM deprovision latency, SIEM loss/replay, proxy/certificate rotation, and connector tenant isolation.

**Operations:** Connector health, credential rotation, regional runbooks, and evidence-review cadence.

**Acceptance:** Each integration has an owner, threat model, reconciliation procedure, rollback, and audited least-privilege scope.

**Rollback:** Connector-specific disable/revoke paths without weakening core IAM or clinical-data availability.

## 14. Prioritized Implementation Backlog

### P0 — Architecture and Critical Controls

Implementation update (2026-08-27): items 2, 6, 7, 8, 12, 13, 14, and 17
have landed as one dependency-ordered slice. The app/server/frontend consume
`@modelforge/contracts`; IAM v2 includes identities, memberships,
invitations, and service principals; route code uses immutable tenant-bound
repositories; clinical PostgreSQL data is schema-per-tenant; payloads are
fully validated; case authorization uses server-stored resource attributes
and nondisclosure; the sync cursor is a transactional change feed with
tombstones; and local-to-shared migration is staged, resumable, previewed,
explicitly activated, and rollback-capable. Unit/HTTP suites and all three
TypeScript builds pass. The real PostgreSQL/Redis suites remain environment-
gated on `DATABASE_URL`/`REDIS_URL` and must run in CI before production use.

1. **Approve identity, tenancy, revocation, audit, and offline ADRs.** Size: M. Risk: Critical. Dependencies: Stakeholders. Components: Documentation and architecture. Verification: Signed decisions and threat model.
2. **Extract strict shared API/domain contracts.** **Implemented 2026-08-27.** Size: L. Risk: High. Dependencies: ADRs. Components: App, frontend, server. Verification: Contract and compatibility tests.
3. **Add OIDC state, nonce, random loopback port, timeouts, and full logout.** **Implemented (verified 2026-08-28 by direct code read).** Size: M. Risk: Critical. Dependencies: Provider contract. Components: Electron main. Verification: `app/src/shared-backend-auth.ts` — `constantTimeEqual` state check, per-attempt nonce verified against the ID token, port-0 random loopback listener, 5-minute authorization timeout. Full IdP-side logout/session-end not independently re-verified this pass.
4. **Remove renderer control of trusted API/issuer configuration.** Size: M. Risk: Critical. Dependencies: Signed config. Components: Main, preload, frontend. Verification: Token-exfiltration and SSRF tests.
5. **Require token audience/type and implement bounded revocation.** Size: L. Risk: Critical. Dependencies: IdP capabilities. Components: Server authentication. Verification: Token matrix and revocation-latency tests.
6. **Introduce identity, membership, invitation, and service-principal schema.** **Implemented 2026-08-27; real PostgreSQL verification pending.** Size: XL. Risk: Critical. Dependencies: IAM ADR. Components: Server and migrations. Verification: Real PostgreSQL lifecycle tests.
7. **Replace unscoped IAM repositories with TenantContext repositories.** **Implemented 2026-08-27.** Size: XL. Risk: Critical. Dependencies: Tenant design. Components: Server stores/routes. Verification: Compile-time API and penetration tests.
8. **Add schema-per-tenant clinical storage plus control-plane RLS.** **Implemented 2026-08-27; real PostgreSQL verification pending.** Size: XL. Risk: Critical. Dependencies: Tenant directory. Components: PostgreSQL and server. Verification: Pool reuse and overlapping-ID tests.
9. **Implement durable authorization epochs.** **Verified implemented (2026-08-28 by direct code read).** Size: L. Risk: Critical. Dependencies: IAM schema. Components: PostgreSQL, cache, policy. Verification: `store/caching-iam-store.ts` checks the durable epoch (migration `004_authorization_epochs.sql`) before trusting a cached compiled-policy decision, per §9's design.
10. **Version the action/resource catalog and add permission boundaries.** **Permission boundaries were already implemented (migration `005_permission_boundary.sql`, `guards.ts`'s `permissionBoundaryPolicyId`). The versioned action catalog itself — genuinely absent, confirmed by direct code read — implemented 2026-08-28.** Size: L. Risk: High. Dependencies: IAM model. Components: Policy evaluator. Verification: `server/src/domain/action-catalog.ts` — a canonical, versioned list of every action string the route layer actually checks (built from grepping every real `requirePermission`/`isPermissionAllowed` call site, not designed in the abstract). `routes/policies.ts` (POST/PATCH) and `routes/policy-versions.ts` (propose) now reject a submitted policy document referencing an action pattern that matches nothing in the catalog (400 `unknown_action`, listing exactly which patterns), catching a typo at authoring time instead of it silently never matching a real check. A new `GET /organizations/:organizationId/action-catalog` (gated on `iam:listPolicies`) exposes the catalog + a documentation-only resource-type-template list for the admin console's policy editor — no admin-console code changes were needed since its existing generic API-error surfacing already displays the server's message verbatim. Deliberately advisory only: never consulted by `requirePermission`/`isPermissionAllowed` at request time, so a gap in the catalog can never itself grant or deny a real request — the actual security decision stays entirely in `policy-evaluator.ts`. "Organization admin cannot gain platform rights" (this item's own verification criterion) was separately confirmed already true by construction: there is no platform-operator route surface in this codebase at all today — every route requires `requireOrgUser` first, which resolves a tenant-scoped principal against org-scoped resource strings, so even a `actions: ["*"]`/`resources: ["*"]` policy cannot reach another organization's resources. 11 new `action-catalog.test.ts` unit tests, 7 new `app.test.ts` integration tests (360/360 server tests passing, up from 342 — one pre-existing test's synthetic `"notPatientCase:*"` fixture action had to be swapped for a real catalog action, since it was never meant to be a real action and the new validation correctly caught that).
11. **Add immutable audit actor schema and transactional outbox.** **Verified implemented (2026-08-28 by direct code read).** Size: L. Risk: Critical. Dependencies: Audit design. Components: Server and PostgreSQL. Verification: migration `006_audit_log.sql`'s `AuditActor` schema; `audit-store.ts`'s `insertAuditEntry` writes in the same transaction as the mutation it describes (per that file's own doc comment) and P1 item 4's hash chain (migration `013`) makes it tamper-evident.
12. **Validate the complete patient/case/consent schema on the server.** **Implemented 2026-08-27.** Size: L. Risk: Critical. Dependencies: Shared contracts. Components: Server and app. Verification: Malformed and manipulated payload tests.
13. **Add resource-level authorization and nondisclosure.** **Implemented 2026-08-27.** Size: XL. Risk: Critical. Dependencies: Resource model. Components: Case service. Verification: Outsider and collection-enumeration tests.
14. **Replace case polling with a transactional change feed and tombstones.** **Implemented 2026-08-27; real PostgreSQL verification pending.** Size: XL. Risk: Critical. Dependencies: Case schema. Components: Server and PostgreSQL. Verification: Concurrent insert/delete cursor tests.
15. **Require idempotency and version preconditions for all writes.** Size: L. Risk: High. Dependencies: Contracts. Components: Server and app. Verification: Retry/restart and stale-edit tests.
16. **Correct UI offline/error/locked/conflict states.** Size: M. Risk: High. Dependencies: Error contract. Components: Frontend. Verification: Network failure never looks empty or encryption-locked.
17. **Implement staged local-to-shared migration.** **Implemented 2026-08-27; real PostgreSQL failure-injection pending.** Size: XL. Risk: High. Dependencies: Shared case service. Components: App, server, UI. Verification: Preview, resume, collision, and rollback tests.
18. **Run PostgreSQL and Redis suites in mandatory CI.** **Implemented (verified 2026-08-28).** Size: M. Risk: Critical. Dependencies: CI services. Components: Server CI. Verification: `.github/workflows/ci.yml` provisions real `postgres:16-alpine` and `redis:7-alpine` services with distinct migration-owner (`modelforge`) vs. restricted runtime (`modelforge_runtime`) roles. Still `describe.skipIf(!DATABASE_URL)` in this local dev environment only (no local Postgres/Redis available here — see `reference_modelforge_dev_env` memory), not in CI itself.
19. **Establish TLS, secrets, KMS, and production-configuration baseline.** Size: L. Risk: Critical. Dependencies: Infrastructure decisions. Components: Deployment and server. Verification: Startup fails on insecure configuration.
20. **Harden IPC, CSP, and MasterVault symlink handling.** **IPC sender validation and MasterVault symlink hardening implemented and tested 2026-08-28; CSP implemented but shipped report-only; sandboxing not attempted.** Size: L. Risk: High. Dependencies: Threat model. Components: Main, frontend, MCP. Verification: Renderer and symlink-escape tests.
    - IPC sender validation: `app/src/ipc/trusted-sender.ts` wraps `ipcMain.handle`/`ipcMain.on` once, centrally (not per-handler-file — ~20 `register*Ipc()` modules all get it automatically), rejecting any call whose `event.senderFrame` isn't `getMainWindow()`'s own main frame. 8 new tests (a fake `ipcMain` — nothing in this codebase unit-tests a real one). 845/845 (then 849/849 after CSP) app tests still passing.
    - MasterVault symlink handling: reading `mastervault-mcp-server/src/services/vault.ts` found this was **already fully implemented** (`confine()` for lexical traversal, `assertRealPathInside`/`isRealPathInside` for symlink-escape, applied to every read/write/list/search/move) — the roadmap's claim here was stale, matching the same doc-drift pattern found elsewhere this session (shared chat sessions, admin console). What was missing was test coverage: the package had **no test framework installed at all**. Added vitest + 14 adversarial tests creating real symlinks on disk (a file symlinked outside the vault, a directory symlinked outside the vault) and confirming read/write/list/search/move/append all correctly refuse or skip them, plus lexical `../` traversal and null-byte rejection — all 14 pass against the existing (unmodified) implementation. Also ran `npm audit fix` here (2 high + 1 moderate transitive vulnerability fixed; one moderate esbuild dev-server-only CVE left, inapplicable to this package's build-only esbuild usage). Wired into CI (`Test mastervault-mcp-server` step).
    - CSP: `app/src/csp.ts`, applied only in packaged mode (`app.isPackaged`) — dev mode's Vite server needs HMR's `'unsafe-eval'`/WebSocket, out of scope for a boundary that's about what ships to users. Shipped as `Content-Security-Policy-Report-Only`, not enforcing, and `script-src`/`style-src` allow `'unsafe-inline'` — both deliberate, disclosed limits: `frontend/`'s production build (`vite-plugin-singlefile`) inlines the *entire* JS/CSS bundle into one `<script>`/`<style>` tag in `index.html` (~5.3MB), and a hash-pinned CSP would need a real HTML parser at build time to extract that content correctly (a naive regex was tried and rejected — the bundle itself contains string literals that look like `<script>`/`</script>`, confirmed by inspecting the real build output, which would silently hash the wrong bytes). Every other directive is real and restrictive (`object-src none`, `base-uri none`, `frame-src none`, `form-action none`, `connect-src none` — this app's renderer never calls `fetch()`/`WebSocket` itself, confirmed by grep; all network access crosses the IPC bridge to the main process instead). Report-only because there was no way to live-launch the packaged Electron app in the environment this was built in (no xvfb, `apt-get install` hangs — see `reference_modelforge_dev_env` memory) to confirm the policy doesn't break something a static grep of ~4800 bundled modules could have missed. **Flip `REPORT_ONLY` to `false` in `app/src/csp.ts` after one real packaged launch shows zero violations in DevTools.**
    - Sandboxing (`webPreferences.sandbox: true`): not attempted. Same live-launch-verification gap, higher blast radius (sandbox mode restricts the preload script's Node API access — a wrong assumption here could break preload entirely, not just log a warning) — a real follow-up, not a silent scope-drop.

### P1 — Enterprise Operation

Status update (2026-08-28): items 1-8 have landed. Item 9 remains — its
signing/provenance half is explicitly out of this repository's authority
(no certificate/key-custody/HSM infrastructure built here, standing user
instruction — see item 3's own note below); its SAST/secret-scanning-gates
half is not certificate-related and is a legitimate next candidate.

1. Build the full tenant admin console. **Implemented 2026-08-27** — separate `admin-console/` web app (Vite+React+TS), all core IAM screens, permission-gated client-side UX.
2. Add approvals, access reviews, and break-glass. **Implemented 2026-08-27** — immediate-grant/mandatory-post-hoc-review break-glass to one per-org emergency policy; access-review campaigns with self-review rejection. Migration `011`.
3. Deliver signed central policy/configuration. **Implemented 2026-08-28, minus signing** — immutable `PolicyVersion` rows, dual-control propose/approve/reject/rollback (migration `012`), plain SHA-256 `contentHash` as an integrity/audit aid only. No cryptographic signing/key-generation/key-custody/HSM/certificate infrastructure was built, by explicit user instruction ("skip the certificate related things ... I'll handle these later") — this instruction applies to every item in this backlog that would otherwise require it, not just this one.
4. Build immutable audit ingestion, search, export, and legal hold. **Implemented 2026-08-28** — per-org SHA-256 hash chain (migration `013`, `UPDATE`/`DELETE` revoked from the runtime role), server-side search/pagination, CSV export, legal holds. Tamper-*evident*, not tamper-*proof* (no signing, same reason as item 3).
5. Add encrypted offline cache and durable outbox. **Implemented 2026-08-28** — OS-keychain-backed per-org cache, write-queue-and-flush-on-reconnect, `Idempotency-Key`-threaded replay. No structured conflict UI (minimal list-and-discard instead); not live-Electron-tested in this dev environment.
6. Add enterprise backup, PITR, and tenant-scoped restore. **Implemented 2026-08-28, minus real continuous PITR** (WAL-archiving infra is a named §19 operator decision) — on-demand tenant export + dual-control restore, `ON CONFLICT DO NOTHING` semantics, cross-tenant restore refused. Postgres fidelity suite never run against a real database in this dev environment.
7. Add the remaining shared clinical domains. **Partially implemented** — shared chat sessions shipped (migration `015`, `routes/sessions.ts`); evidence/projects/patient-list sharing (Phase 4 scope) remain absent.
8. Add production observability and SLO dashboards. **Implemented 2026-08-28** — `server/src/metrics.ts` (PHI-free Prometheus metrics: HTTP/authz-decision/audit-write latency, cache stats, process metrics), split `/health/live`+`/health/ready`, and an importable Grafana dashboard (`server/observability/grafana-dashboard.json`) wired to this document's §17 objectives. See `docs/OBSERVABILITY.md`. No actual Prometheus/Grafana/alerting deployment or SLO burn-rate alert rules — named operator/infra decisions.
9. Add artifact signing, provenance, SAST, and secret-scanning gates. **SAST and secret-scanning implemented 2026-08-28.** New `security` job in `.github/workflows/ci.yml`: gitleaks (secret scanning, full commit history) and Semgrep (`p/ci`+`p/owasp-top-ten`+`p/javascript`+`p/typescript`), both hard gates. Verified locally against this exact repository before wiring in — gitleaks found zero leaks across 121 commits; Semgrep's real findings (21 unpinned-Action supply-chain refs across every workflow, 2 `github`-context shell-injection spots in `release.yml`, a missing explicit AES-GCM `authTagLength` in `app/src/case-encryption.ts`, a missing Dependabot cooldown) were fixed rather than suppressed — see those files' own diffs. One rule (`direct-response-write`) is excluded as a confirmed false-positive class for a Fastify JSON API (assumes Express-style HTML rendering). Signing/provenance remain not started — real certificates/key-custody infrastructure, out of scope per the standing instruction above.

### P2 — Institutional Integration and Scale

Status update (2026-08-30): items 1 (SCIM Users, minus Groups), 2 (SIEM export, minus SIEM-product-specific wire formats), 3 (multiple-IdP compatibility — proxy and custom-CA turned out to need no application code), and 4 (institutional MCP registry — the "managed model" half already existed via the separate ClinicalAiGateway effort) implemented.

1. SCIM and external group reconciliation. **SCIM Users implemented 2026-08-28** — RFC 7643/7644 core Users provisioning (`routes/scim.ts`, `routes/scim-tokens.ts`, migration `016_scim_provisioning.sql`). Static bearer-token auth (not OIDC — provisioning precedes any real login). "Create user" maps onto the existing Invitation mechanism by explicit product decision (asked directly, given the security stakes of an identity-binding design) rather than a new identity-less User concept — see `docs/SCIM.md` for the full design and its one real, disclosed consequence: a SCIM resource's `id` is the Invitation's id while pending, and becomes the real User's id once accepted (a real IdP's filter-based reconciliation loop always converges regardless). Supports both real-world PATCH shapes (Azure AD path-based, Okta value-object) for deactivation/reactivation; DELETE never hard-deletes (suspends, matching this codebase's standing convention). Groups are explicitly out of scope for this slice (SCIM group-membership push would need to target a still-pending, Identity-less invitee, which has no mechanism yet). 9 new integration tests covering the full lifecycle including the id-transition behavior; 369/369 server tests passing (up from 360), typecheck/build clean.
2. SIEM export and institutional alert mapping. **Implemented 2026-08-30, as a pull API rather than a push/webhook** — `GET /organizations/:organizationId/audit/siem-export?since={sequence}&limit={n}` (`routes/audit.ts`), gated on its own new `audit:exportSiem` action rather than folded into `audit:read` (bulk/automated export to a system outside this server's trust boundary is a materially different capability than a human paging through the trail in the console). A connector polls forward through the org's own tamper-evidence `sequence` (already existed, migration `013`) and manages its own cursor between calls — no new migration, no per-connector server-side state, matching `routes/cases.ts`'s `?since=` change-feed contract exactly. Chose pull over push deliberately: this codebase has no existing outbound-to-arbitrary-host integration anywhere (metrics, health, and every other audit surface are all pull) — a push/webhook would have meant inventing webhook-secret management, retry/backoff, and a new egress surface this server would then own, for a delivery mechanism no evidence suggested was actually required; a pull model reuses the OIDC/tenant/authorization machinery already built instead. "Institutional alert mapping" is `server/src/audit-severity.ts`'s `classifyAuditSeverity()` — a three-level (critical/warning/info) classification attached to every exported event, built from the real action strings this codebase actually records (grepped from every `insertAuditEntry`/`AuditStore.record` call site first, not designed in the abstract, the same discipline `domain/action-catalog.ts` used for policy actions) rather than a specific SIEM product's severity scale (CEF/syslog codes) this repository has no authority to pick. One disclosed limitation: some genuinely security-relevant outcomes (a membership suspended, a user deactivated) are recorded as a generic `"membership.update"`/`"user.update"` with the real change only in `details`, not a distinct action string — the classifier can't see that without a larger, out-of-scope change to every principal-store call site; a consumer needing that distinction reads `details` directly from the export payload, which is included unredacted (see the file's own doc comment). 5 new `app.test.ts` integration tests (permission separation from `audit:read`, ascending cursor order with severity attached, no-overlap pagination, empty-result-when-caught-up, cross-tenant isolation) plus 4 `audit-severity.test.ts` unit tests. 575/575 server tests passing (up from 566 — the total has grown past P1 item 9's recorded count from other in-progress imaging/AI-gateway work this session didn't touch), typecheck/build clean. No admin-console UI added — this is a machine-polling endpoint for a SIEM connector, not a human-facing screen, matching `/metrics`'s own no-UI precedent; granting `audit:exportSiem` needs no console change either, since policies are already authored via the existing raw-JSON policy editor.
3. Proxy, custom CA, and multiple-IdP compatibility. **Multiple-IdP implemented 2026-08-30; proxy and custom CA need no application code at all.** Investigated first rather than assuming all three needed building: this Node 22 process's outbound calls (OIDC discovery, JWKS fetch) use the global `fetch`, which already honors `NODE_OPTIONS=--use-env-proxy` (verified directly — Node 22.23.2 in this environment recognizes the flag) plus the standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` variables, and separately honors `NODE_EXTRA_CA_CERTS` for an internal/self-signed CA — both are Node runtime capabilities, not something this service implements. Documented both in `server/README.md`'s new "Multiple identity providers, proxies, and custom certificate authorities" section and `.env.example`, rather than building bespoke proxy-agent/CA-bundle plumbing this codebase would then have to maintain.

   Multiple-IdP support is real new code, additive and backward-compatible: `OIDC_ADDITIONAL_ISSUERS` (optional, JSON array of `{issuer, audience, jwksUri?}`) lets an institution accept tokens from more than one IdP — every existing single-issuer deployment and every existing test needs no change. `auth/oidc-verifier.ts`'s new `decodeUnverifiedIssuer` reads a token's `iss` claim *without* verifying it, purely to pick which configured issuer's JWKS/audience to attempt real verification against; `auth/auth-plugin.ts`'s `createAuthPreHandler` does the actual selection and rejects with the same generic message for both "issuer not trusted" and "signature failed" (never letting a caller distinguish the two, which would otherwise let them enumerate trusted issuers). The load-bearing security property — that this selection step can never substitute for real verification — has a dedicated test proving a token which *claims* a trusted issuer's name but is signed by the wrong key is still rejected (`auth-plugin.test.ts`: "cannot be fooled by an unverified iss claim").

   25 new tests total (6 `decodeUnverifiedIssuer` unit tests, 9 `auth-plugin.test.ts` unit tests directly exercising the multi-issuer preHandler, 8 `config.test.ts` validation tests for `OIDC_ADDITIONAL_ISSUERS`, 3 `app.test.ts` end-to-end HTTP tests through a real `buildApp()`/`app.inject()` round trip with two live issuers configured) — 600/600 server tests passing (up from 575), typecheck/build clean.
4. Managed model/MCP registry and egress controls. **MCP registry implemented 2026-08-30; the "managed model" half already existed.** Investigated before building: `AiProviderRegistryStore` (`server/src/store/ai-provider-registry-store.ts`, migration `018`) already is a full institutional AI model registry — providers, provider-models with PHI-permitted/data-residency/retention flags, model artifacts, inference deployments, and an admin kill switch — built as part of the separate ClinicalAiGateway effort (`docs/CLINICAL_AI_GATEWAY.md`), not this backlog. What the roadmap's own capability matrix actually named as missing was the MCP half specifically: "Per-tool policy and audit exist [locally, in the Electron app's `agent-tools.ts`], but no institutional registry or centrally managed allowlist."

   Built `McpRegistryStore` (`server/src/store/mcp-registry-store.ts`, migration `020_mcp_registry.sql`) — organization-scoped (unlike the AI provider catalog's global-catalog-plus-tenant-approval split, since an MCP server is inherently institution-specific, not a shared cross-hospital fact), RLS-protected, in-memory+Postgres pair matching `AuditLegalHoldStore`'s exact template. Each entry: `name`, `transport` (stdio/http), `endpoint`, `allowedTools` ("*" or an explicit array — the same allow-everything-vs-explicit-list shape the Electron app's own local per-tool allowlist already uses, now centrally managed), `dataEgressPolicy` (none/metadata-only/unrestricted), and `status` (active/disabled — no hard-delete, matching `AiProviderRegistryStore`'s own retire-don't-delete convention and this codebase's broader standing pattern). New `mcpRegistry:list`/`mcpRegistry:manage` actions (separate, matching `iam:listUsers`/`iam:manageUsers`'s separation-of-duties shape) and full CRUD routes (`routes/mcp-registry.ts`).

   **Electron-side enforcement implemented 2026-08-30.** `app/src/managed-mcp-policy.ts` now fetches the selected organization's active registry before an MCP connection opens, binds HTTP entries to a normalized URL and stdio entries to the exact command-plus-arguments identity, filters the server-advertised tool list, and re-fetches immediately before every tool call so an already-connected server fails closed after disablement or allowlist revocation. Direct calls are checked independently of tool-list filtering. `dataEgressPolicy: none` blocks calls and resource/prompt payload operations; `metadata-only` permits only payload-free calls because the registry does not yet define a field-level metadata vocabulary; `unrestricted` preserves the existing per-call user-approval path. Standalone mode is unchanged when no enterprise organization is selected. The institutional server still never proxies MCP traffic — enforcement correctly lives at the Electron boundary where the traffic originates. Six focused policy tests plus the existing 21-test MCP client suite pass, and the app TypeScript build is clean.

   **Admin-console operation implemented 2026-08-30.** A permission-gated MCP Registry screen now exposes the server's list/create/update/enable/disable workflow, shows transport, exact endpoint identity, allowed tools, status, and egress posture, and validates the HTTP URL or canonical stdio invocation before submit. `mcpRegistry:list` and `mcpRegistry:manage` are separate UI capabilities, matching the server boundary. The admin-console API request contracts and form normalization have dedicated tests.

   8 new `app.test.ts` integration tests (permission separation, full CRUD lifecycle, schema validation rejecting a malformed `allowedTools`/`dataEgressPolicy`, status-filtered listing, 404 on unknown entry, cross-tenant isolation). 608/608 server tests passing (up from 600), typecheck/build clean.
5. HA, capacity, chaos, and canary automation. **Canary, capacity, post-shift observation, and fail-closed rollout decision gates started 2026-08-30** — `server/src/ops/canary-probe.ts` provides an infrastructure-neutral pre-promotion health/metrics gate; `capacity-runner.ts` adds bounded authenticated endpoint load; `post-shift-observer.ts` adds bounded, read-only authenticated observation with availability, p95, and consecutive-regression fail-fast gates; and `rollout-decision.ts` accepts fresh same-origin evidence to emit an explicit staged promote-or-rollback decision without executing arbitrary commands. All outputs are secret-free; remote and mutating load require separate opt-ins. Unit coverage includes warm-up recovery, failure/latency thresholds, URL/credential safety, hard bounds, authenticated traffic, stale/future/wrong-target evidence, safe traffic transitions, fail-fast regression, and secret/body/query non-disclosure. Deployment-specific traffic shifting and rollback actuation, rollback verification, distributed/soak testing, chaos/failover drills, and platform templates remain open.

### P3 — Later Strategic Capabilities

1. FHIR/EHR connectors.
2. Optional real-time collaborative merge model after clinical validation.
3. Regional/data-residency topology.
4. True E2E encrypted collaboration mode as a separate product decision.

## 15. Migration and Rollback Plan

1. **Preflight:** inventory local cases, encryption state, IDs, attachments, and schema versions. Create and verify an encrypted local backup.
2. **Preview:** show tenant, destination, counts, collisions, invalid records, consent mappings, and records that cannot be imported.
3. **Stage:** upload in resumable batches using stable migration and item idempotency keys. Staged rows remain invisible to normal users.
4. **Validate:** compare counts, hashes, required fields, relationships, and authorization visibility. Produce a signed reconciliation report.
5. **Cut over:** atomically activate the imported dataset and switch that profile to managed authority.
6. **Observe:** retain the local source read-only through an institution-defined rollback window.
7. **Roll back if required:** disable the imported view and reactivate the preserved local source. Never overwrite it with partially synchronized server data.
8. **Clean up:** only after explicit user/admin approval, successful backup verification, and resolution of all offline queues.

Local consent flags must not automatically become enterprise consent. The organization needs an approved semantic mapping or a new consent workflow.

## 16. Mandatory Enterprise Acceptance Scenarios

1. Two organizations use identical patient, case, group, and policy IDs in real PostgreSQL; neither can retrieve or mutate the other.
2. An outsider receives the same response for nonexistent and foreign resources.
3. An explicit deny overrides every direct, group, inherited, or wildcard allow.
4. Membership/policy revocation becomes effective within the declared bound even when Redis is unavailable.
5. Access, ID, refresh, service, and deliberately confused tokens are accepted or rejected according to their intended token type.
6. Renderer manipulation cannot alter issuer, audience, or API origin; obtain a token; invoke arbitrary privileged IPC; or cause server-side tenant switching.
7. Every clinical endpoint and DB query requires tenant context; static route inventory and property tests detect omissions.
8. Reused pooled PostgreSQL connections cannot retain the previous tenant context.
9. An organization admin cannot create platform privileges or delegate beyond the permission boundary.
10. Concurrent edits return a conflict and never silently overwrite, including consent, note, and review operations.
11. A network/backend failure is visibly distinct from an empty dataset, encryption lock, or authorization denial.
12. Offline queued writes survive process/device restart and replay exactly once in effect.
13. A deprovisioned user's queued edits are quarantined and cannot synchronize.
14. Acknowledged mutations cannot lose audit evidence during audit-store, network, or process failure.
15. Backup and restore preserve encryption and tenant isolation and reject cross-tenant restore targets.
16. Logs, telemetry, traces, diagnostics, and errors contain no tokens, secrets, authorization headers, raw request bodies, or PHI canary values.
17. Local mode starts and completes its workflows without an IdP, enterprise server, Redis, or PostgreSQL.
18. OAuth callback state/nonce mismatch, fixed-port interception, endpoint redirect, and issuer-substitution attacks fail closed.
19. Change-feed bootstrap plus concurrent mutation cannot skip a record; deletes always reach clients as tombstones.
20. Idempotency-key reuse with a different request hash is rejected.
21. Managed mode refuses plaintext token/cache-key fallback.
22. Every admin, break-glass, service-principal, and policy action has the correct actor, tenant, outcome, and policy-version audit context.

## 17. Provisional Production Objectives

- Authorization service availability: 99.95% monthly.
- Clinical API availability: 99.9% monthly.
- Authorization decision latency: p95 at or below 100 ms.
- Case read/write latency: p95 at or below 300/500 ms, excluding large objects.
- Membership/policy revocation: effective on the next protected request; absolute maximum 30 seconds.
- Token/session revocation: maximum 60 seconds, requiring a compatible provider capability.
- Connected synchronization acknowledgment: p95 at or below 5 seconds.
- Normal reconnect queue drain: 99% within 60 seconds.
- Audit durability: zero acknowledged mutation loss.
- Central audit arrival while connected: 99.9% within 5 minutes.
- Backup: provisional RPO at or below 15 minutes.
- Recovery: provisional RTO at or below 4 hours, proven by restore drills.

These objectives require institutional ratification. An IdP that cannot meet the selected revocation bound is not compatible with the production profile unless the institution explicitly accepts a different risk and compensating control.

## 18. Principal Risks and Mitigations

**Cross-tenant clinical disclosure** — Likelihood: Medium. Impact: Critical. Owner: Security and backend. Mitigation: Tenant-bound repositories, schema separation, RLS, and adversarial DB tests.

**OAuth callback injection/token exfiltration** — Likelihood: High. Impact: Critical. Owner: Desktop and security. Mitigation: State/nonce, trusted configuration, exact origin binding, and IPC hardening.

**Stale authorization after revocation** — Likelihood: High. Impact: Critical. Owner: IAM. Mitigation: Durable epochs and fail-closed checks.

**IdP lacks required logout/revocation behavior** — Likelihood: Medium. Impact: High. Owner: IAM and institution. Mitigation: Provider compatibility gate and documented bound.

**Caller-spoofed resource/context attributes** — Likelihood: High. Impact: Critical. Owner: IAM and clinical services. Mitigation: Server-loaded attributes and internal-only authorization API.

**Opaque clinical payload bypasses validation** — Likelihood: High. Impact: Critical. Owner: Clinical backend. Mitigation: Shared strict schemas and resource model.

**Synchronization skips changes or deletes** — Likelihood: High. Impact: High. Owner: Sync. Mitigation: Transactional change log, stable snapshots, and tombstones.

**Offline edit causes clinical conflict** — Likelihood: Medium. Impact: Critical. Owner: Product and clinical safety. Mitigation: Explicit conflict workflow and no automatic merge.

**Audit can be lost or rewritten** — Likelihood: High. Impact: Critical. Owner: Security and platform. Mitigation: Transactional outbox, immutable store, signed manifests, and legal hold.

**Migration duplicates or loses records** — Likelihood: Medium. Impact: Critical. Owner: Data migration. Mitigation: Idempotency, staging, reconciliation, and preserved source.

**Backup restore crosses tenants** — Likelihood: Low. Impact: Critical. Owner: Infrastructure. Mitigation: Tenant manifests, KMS context, and adversarial restore tests.

**Logs or diagnostics leak PHI/tokens** — Likelihood: Medium. Impact: Critical. Owner: Observability and security. Mitigation: Bounded schemas, redaction, and synthetic canary scanning.

**Tenant admin escalates to platform privilege** — Likelihood: Medium. Impact: Critical. Owner: IAM. Mitigation: Separate namespaces and permission boundaries.

**MCP/plugin filesystem or egress escape** — Likelihood: Medium. Impact: High. Owner: Desktop/MCP. Mitigation: Central allowlist, confinement fixes, and audit.

**Prototype/document drift misguides implementation** — Likelihood: High. Impact: Medium. Owner: Architecture. Mitigation: Phase 0 source-of-truth reconciliation and CI documentation checks.

**Self-hosted operational complexity** — Likelihood: High. Impact: High. Owner: Infrastructure. Mitigation: One supported topology first, automated deployment, and automated restore.

**Compliance expectations exceed technical controls** — Likelihood: Medium. Impact: Critical. Owner: Legal/compliance. Mitigation: Make no compliance claim without organizational and legal validation.

## 19. Decisions Requiring Explicit Ownership

**Product decisions**

- Offline read-only versus offline editing by role and resource type.
- Conflict-resolution UX and which clinical fields may be manually merged.
- Ownership, patient-list sharing, and department/project semantics.
- Organization creation and first-admin bootstrap policy.
- Local-to-managed rollback window and post-migration local retention.
- Whether real-time notifications are necessary beyond durable polling.

**Clinical-safety decisions**

- Consent meanings, revocation effects, and provenance.
- Whether locally captured consent can be migrated.
- Break-glass conditions, time limits, and retrospective review.
- Which actions must block when audit delivery or secure local storage is unavailable.
- Required data retention and deletion semantics.

**Legal/compliance decisions**

- Data residency and subprocessor constraints.
- Audit and clinical-record retention/legal-hold periods.
- Institutional administrator access to PHI.
- Export, deletion, and subject-right procedures.
- Acceptable authentication, session, and revocation bounds.
- Evidence required before making any regulatory claim.

**Infrastructure decisions**

- Supported IdPs and mandatory provider features.
- Schema-per-tenant versus database-per-tenant institutional tiers.
- KMS/HSM, object storage, PostgreSQL, and immutable audit products.
- Single-region and disaster-recovery topology.
- Proxy, custom certificate-authority, and air-gapped support.
- RPO/RTO, availability, and capacity targets.
- Backup custody and dual-control recovery roles.

## 20. Recommended First Implementation Milestone

Use one production-like institution, one IdP, two tenants, a minimal administrator, one synthetic case resource, real PostgreSQL, disabled Redis, and complete audit.

The slice must prove:

- Secure OIDC login and account switching.
- Server-derived active membership and tenant context.
- Tenant-bound repository and database enforcement.
- Explicit deny and platform/tenant privilege separation.
- Membership/policy revocation without relying on Redis.
- Uniform foreign-resource nondisclosure.
- Transactional case mutation and immutable audit outbox.
- Local mode operating without any enterprise dependency.

If this slice cannot prove tenant isolation and bounded revocation, additional enterprise features should not advance.
