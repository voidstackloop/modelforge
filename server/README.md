# ModelForge Medical — IAM server

A standalone backend service providing identity-aware, AWS-IAM-style
authorization for a ModelForge Medical enterprise deployment: organizations,
users, groups, and JSON policy documents, evaluated through a single
`/authz/check` primitive (and, now, real patient-case CRUD endpoints that
call the same evaluator in-process before every read/write) other services
and an admin console are meant to build on.

**Relationship to the wider plan**: this implements
[docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md](../../docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md)
§4 (auth — generic OIDC relying party, now with a working Electron Settings
UI too — see "Electron client" below), §5 (admin console — IAM-style RBAC
via real JSON policy documents, not a fixed role enum), and §1/§2 (a real
backend service, with both in-memory and Postgres implementations for
*both* `IamStore` and `CaseStore` — see "Persistence" below). It does
**not** implement §3 (real-time sync/CRDT), §6 (deployment topology/infra),
or §7 (encryption — case data here is stored as plaintext server-side, see
"Known gaps").

## What this is not

- **Not an identity provider.** This service authenticates nobody — every
  request must already carry a valid OIDC access token from an external IdP
  (Cognito, Keycloak, or any spec-compliant provider). See
  `src/auth/oidc-verifier.ts`. Building a login screen, MFA, or password
  reset flow here would directly contradict
  [docs/ENTERPRISE_READINESS_ASSESSMENT.md](../../docs/ENTERPRISE_READINESS_ASSESSMENT.md)
  §2.1's standing decision to delegate authentication entirely to an
  external IdP.
- **Persistence has both an in-memory and a Postgres implementation for
  each store, deliberately disclosed as untested-by-execution for the
  Postgres side.** `IamStore` (control-plane metadata), `CaseStore`
  (patient cases), `PrincipalStore` (identity/membership), and
  `CaseMigrationStore` (staged imports) have in-memory and Postgres paths.
  Postgres uses shared RLS-protected tables for IAM metadata and one schema
  per organization for PHI-bearing case data. Both
  interfaces are the same swappable-seam pattern this monorepo already uses
  for `app/src/patient-cases-store.ts`'s `PatientCasesBackend` and
  `app/src/medical-safety.ts`'s `MedicationSafetyProvider`.
- **The Electron client is wired to this service end to end, including a
  Settings UI.** `app/src/shared-backend-auth.ts` (OIDC PKCE, reusing
  `app/src/mcp-oauth.ts`'s loopback-redirect shape),
  `app/src/shared-backend-client.ts` (org discovery/bootstrap/selection —
  `GET /me`, `POST /organizations`), and
  `app/src/shared-patient-cases-backend.ts` (a real `PatientCasesBackend`
  calling this server's `/organizations/:id/cases` endpoints) all exist and
  are tested. `frontend/src/pages/AuditPrivacy.tsx`'s
  `SharedBackendConnectionSection` drives configure → connect → pick-an-
  organization end to end from the renderer — see that component's own doc
  comment. **Not verified**: this component has not been exercised in a
  running Electron window in the environment it was built in (no display
  available) — see "Known gaps."
- **Hybrid tenant isolation is implemented.** Clinical data routes through
  a validated schema-per-organization directory. IAM/control-plane metadata
  remains in shared tables, protected by tenant-bound repositories and RLS.
  See ADR 0001 and migrations 008-009.
- **Case data has no server-side encryption at rest** — `InMemoryCaseStore`
  holds plaintext JSON in process memory; a real deployment behind
  `DATABASE_URL` would need Postgres-level encryption (TDE, encrypted
  volumes) configured by whoever operates it, since this service does
  nothing itself here. This is exactly the trade-off
  docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §7 names explicitly (server-managed
  keys, not end-to-end) — not silently assumed away.

## Persistence

`IamStore` (`src/store/iam-store.ts`) has two implementations, selected by
whether `DATABASE_URL` is set:

- **`InMemoryIamStore`** (default) — everything lost on restart. Good for
  local development and this package's own test suite.
- **`PostgresIamStore`** (`src/store/postgres-iam-store.ts`) — real,
  parameterized-query SQL against the schema in `migrations/001_init.sql`
  (run automatically at startup via `src/store/migrate.ts`, idempotent).
  Uses **shared tables with an `organization_id` column**, not
  schema-per-tenant — a deliberate simplification for this specific
  metadata (org/user/group/policy *documents*, not PHI), distinct from the
  architecture plan's schema-per-tenant default for patient-case data.
  **Not run against a real Postgres instance in the environment this was
  built in** — `src/store/postgres-iam-store.test.ts` is a real integration
  suite (TRUNCATE-based fixture reset, cascade-delete checks, the works),
  gated on `DATABASE_URL` and skipped (not failed) when it's absent. Run it
  for real before trusting this in production:
  ```bash
  DATABASE_URL=postgres://user:pass@localhost:5432/modelforge_iam npm test
  ```

`CaseStore` (`src/store/case-store.ts`) is exposed only through a
`TenantCaseRepository`. `InMemoryCaseStore` keeps independent tenant maps;
`PostgresCaseStore` resolves the tenant through `TenantDirectory` and uses
the schema created by `migrations/009_tenant_clinical_schemas.sql`.
Application-provided schema names are never interpolated into SQL.

`PrincipalStore` models OIDC identities separately from memberships, pending
invitations, and service principals. Its Postgres implementation is backed by
`migrations/007_identity_membership.sql`; the shared control-plane tables are
protected by the policies in `008_control_plane_rls.sql` and are reached
through a tenant-bound repository/connection.

### Role separation (migration-owner vs. runtime)

`008_control_plane_rls.sql`'s `tenant_isolation` policies only have teeth
against a role that is both `NO BYPASSRLS` *and* not the owner of the
tables it queries — Postgres exempts table owners from row-level security
by default, regardless of `BYPASSRLS`. With a single role for everything
(the default — see below), RLS is enabled but inert; it becomes a real,
enforced second layer of defense only once the application connects as a
separate, restricted role.

- **`DATABASE_URL`** — always where migrations run (`src/store/migrate.ts`
  via `src/index.ts`). Needs owner-level rights: `CREATE SCHEMA`, `CREATE
  FUNCTION` (the `SECURITY DEFINER` provisioning function in
  `009_tenant_clinical_schemas.sql`), `ALTER DEFAULT PRIVILEGES`.
- **`RUNTIME_DATABASE_URL`** (optional) — when set, the application's own
  long-lived connection pool uses *this* URL instead, once migrations
  (against `DATABASE_URL`) have finished. When unset — every deployment
  before this variable existed — `DATABASE_URL` is used for both, exactly
  as before: one role does everything, and RLS remains inert.

To actually enable enforcement, create a role named exactly
`modelforge_runtime` before running migrations —
`migrations/010_runtime_role_grants.sql` conditionally grants it (and
every future tenant schema `009`'s provisioning function creates) exactly
what it needs, and is a complete no-op if this role doesn't exist:

```sql
CREATE ROLE modelforge_runtime WITH LOGIN PASSWORD '...'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
GRANT CONNECT ON DATABASE modelforge_iam TO modelforge_runtime;
```

then set `RUNTIME_DATABASE_URL` to that role's connection string. See
`.github/workflows/ci.yml`'s "Create restricted runtime database role" step
for the exact statements CI runs, and
`src/store/postgres-rls.test.ts` for the adversarial tests (cross-tenant
read/write/join attempts, pooled-connection tenant-context reuse, the
runtime role's own privilege bounds) that only run meaningfully once both
`DATABASE_URL` and `RUNTIME_DATABASE_URL` point at real, distinct roles —
gated and skipped otherwise, for the same reason a superuser connection
can't be used to prove RLS works.

## Caching

`CachingIamStore` (`src/store/caching-iam-store.ts`) sits between the
routes and `IamStore` when caching is enabled (default) — every
authenticated request resolves the caller's `User` record and full
effective policy set at least once (`requireOrgUser` →
`findUserByExternalSubject`; `requirePermission`/`/authz/check` →
`resolveEffectivePolicies`), and against `PostgresIamStore` each of those
is a real round trip. See `src/cache/` for the implementation; this
section is the operational summary.

### Backends

- **In-memory (`MemoryCache`, default)** — per-process, lost on restart.
  Fine for local development and a single-instance deployment.
- **Redis (`RedisCache`, `REDIS_URL` set)** — shared across every instance
  of this service, so a write on one instance is visible to every other
  instance's next read instead of each carrying its own cold cache.
  `docker compose up -d redis` (`docker-compose.yml`, this directory) runs
  one locally.

Both implement the same `Cache<V>` interface (`src/cache/cache.ts`) and the
same generation-tagged-key correctness scheme — see that file and
`redis-cache.ts`/`memory-cache.ts`'s doc comments for the full detail. They
differ in a few ways that can't be made equivalent:

| | MemoryCache | RedisCache |
|---|---|---|
| Capacity bound | `maxSize` (LRU-evicted) | none — Redis's own `maxmemory`/`maxmemory-policy` |
| Expired-entry reclaim | proactive periodic sweep + lazy on read | Redis's own internal TTL expiry |
| Stampede coalescing | per-process | per-process only (not cross-instance) |
| Invalidation failure | cannot fail | can fail (Redis unreachable) → **degraded mode**, below |

Since `RedisCache` never enforces a size cap itself, a deployment running
against Redis should configure Redis's own `maxmemory` and
`maxmemory-policy` (e.g. `volatile-lru`, since every key this service
writes already carries a TTL) rather than relying on this process to
bound memory.

### Negative caching

Every `T | null` lookup here (`getUser`, `getOrganization`, `getGroup`,
`getPolicy`) caches a *found* result but never a miss — with one
deliberate exception: `findUserByExternalSubject`, called on every request
to an org-scoped route. An authenticated caller with no account in the
target organization is a real, repeating request pattern (an outsider
retrying, or a caller pointed at the wrong org), not a one-off — so that
miss is cached too, at a much shorter TTL (`CACHE_NEGATIVE_TTL_MS`,
default 5s, vs. `CACHE_TTL_MS`'s default 30s) than a found user.
`createUser`/`updateUser` invalidate it through the exact same cache key
and mechanism as a positive result — no separate invalidation path exists
or is needed. See that method's doc comment in `caching-iam-store.ts` for
the full reasoning, including why every other id lookup deliberately does
*not* do this (their ids are server-generated UUIDs a legitimate caller
only ever has after the entity exists).

### Why a policy or group change clears the whole effective-policy cache

`resolveEffectivePolicies` depends on a user's own policies *and* every
policy attached to every group it belongs to. There's no reverse index
from a policy or group back to the users it affects, and building one (to
narrow invalidation to just the affected users) would trade a rare,
already-cheap admin write for correctness risk on the read side that
matters far more: this is an authorization cache, and an incorrectly-
narrowed invalidation would leak a stale `Allow`/`Deny` decision to a
request that has nothing to do with the write that just happened. Given
that trade, a group or policy mutation invalidates the entire
`effectivePolicies` cache namespace; a user update invalidates only that
one user's entry (unambiguous — no index needed). Group/policy writes are
rare admin operations; `/authz/check` is not, so this favors correctness
on the hot path over narrowing the cost of the cold one.

### Stampede coalescing

A burst of concurrent requests all missing on the same freshly-expired (or
never-cached) key join a single in-flight load instead of each issuing
their own backing-store query — see each `Cache<V>` implementation's doc
comment for how this stays safe under a concurrent invalidation (a caller
never coalesces onto a load that started before an invalidation its own
request arrived after).

### Failure mode: Redis unreachable

If Redis becomes unreachable, every cache **read** degrades to a cache
miss (correctness-neutral — the request just falls through to the store,
slower but never stale). If Redis becomes unreachable during a
**write-invalidation** (a policy revoked, a user suspended, mid-outage),
that specific cache namespace enters a **degraded** state: every read
bypasses the cache entirely (never risking serving what might still be the
pre-invalidation value) until a generation-bump operation actually
succeeds again. Recovery is automatic and needs no operator action —
retried opportunistically on the next read to that namespace, and
proactively as soon as the shared Redis connection reports healthy again
(the `ready` event, `src/cache/create-cache.ts`). This only protects the
process that observed the failure; a multi-instance deployment relies on
the shared Redis `INCR` itself (one counter, not one per process) for
cross-instance consistency.

### Failure mode: Redis restored from a stale backup

"Unreachable" isn't the only failure shape — an operator can also restore
Redis from a backup taken *before* a revoking mutation, which silently
undoes that mutation's own cache-invalidation call along with everything
else, potentially resurrecting a stale `Allow` under its original key. This
is exactly what "Redis outage cannot preserve an allow decision"
(docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md's P0 item 9) is about: an outage
alone already can't (see above); a full data rollback is the harder case
this section covers.

`resolveEffectivePolicies` closes it with a durable, per-organization
authorization epoch (`IamStore.getAuthorizationEpoch`, bumped by
`updateGroup`/`updatePolicy`/`deletePolicy` atomically with their own
mutation — see that method's doc comment). The cached value is tagged with
the epoch it was computed under; every read compares that tag against the
current epoch, fetched through `CachingIamStore`'s own small
`authorizationEpochs` cache — deliberately **always in-process, never
Redis-backed**, so the comparison target can't be rolled back along with
the rest of Redis. A resurrected stale entry's tag reads as older than the
current epoch and is recomputed rather than served. That epoch cache's own
TTL (2s, `EPOCH_CACHE_TTL_MS`) bounds how long this specific failure mode
could still serve a stale decision — not zero, but a small, fixed window
after what is already a rare, deliberate operational event, not an
ongoing exposure.

### Observability

`CachingIamStore.stats()` returns per-sub-cache `{hits, misses, size,
loads, coalesced, loadTimeMsTotal, evictions, expirations, invalidations,
redisErrors, degraded}` (`src/cache/cache.ts`'s `CacheStats`) — counts
only, never a cached key or value, so it's safe to log or expose without
risk of leaking a subject identifier, user id, or policy document. This
service logs one structured line (`{"event":"cache_stats", ...}`) per
sub-cache every 5 minutes (`src/index.ts`), plus an immediate line
whenever a Redis-backed cache enters or leaves degraded mode
(`{"event":"cache_degraded"|"cache_recovered", ...}`) and on every caught
Redis operation failure (`{"event":"cache_redis_error", ...}`) — grep for
these in production logs to correlate a degraded-cache period with what
Redis itself was doing.

These same `stats()` numbers are also exposed as Prometheus gauges on `GET
/metrics` (`src/metrics.ts`), alongside HTTP/authorization-decision/
audit-write latency histograms and audit-write outcome counts — see
[docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md) for the full metric
list, the importable Grafana dashboard at `server/observability/`
`grafana-dashboard.json`, and how each panel maps to the roadmap's §17
provisional SLOs. `/metrics` is unauthenticated by default (every metric it
reports is a bounded-label aggregate, never a caller- or tenant-identifying
value) — set `METRICS_TOKEN` for a second layer if an operator wants one.
There's still no separate authenticated *diagnostic* endpoint beyond this —
a route that could return raw per-key cache state was judged more new
attack surface than this cache layer alone warrants; `stats()` remains
available programmatically to any future tool that wants it on demand.

### Configuration

See `.env.example` for the full list (`CACHE_DISABLE`, `CACHE_TTL_MS`,
`CACHE_NEGATIVE_TTL_MS`, `REDIS_URL`). `CACHE_TTL_MS` and
`CACHE_NEGATIVE_TTL_MS` are validated at startup — a malformed or
out-of-range value (non-numeric, negative, or outside the [1s, 1h] /
[100ms, `CACHE_TTL_MS`] bounds respectively) fails loudly with a
`ConfigError` rather than silently producing a cache that never expires or
expires every entry immediately. Every other numeric env var (`PORT`,
`POOL_MAX`, `POOL_*_TIMEOUT_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`)
gets the same treatment, for the same reason — a typo'd value fails startup
instead of silently becoming `NaN` somewhere downstream.

`loadConfig` (`src/config.ts`) also refuses to start against insecure
production-shaped configuration:

- **`OIDC_ISSUER` must be HTTPS**, unless it's an explicit
  `http://localhost` / `http://127.0.0.1` / `http://[::1]` address (local
  development only) — a plaintext issuer makes JWKS/discovery tamperable in
  transit, a direct path to accepting forged tokens. Same policy
  `app/src/shared-backend-auth.ts`'s `isAllowedRemoteUrl` already applies
  client-side, applied here too.
- **`DATABASE_URL`, when set, may not explicitly disable TLS**
  (`sslmode=disable`/`sslmode=allow`) **against a non-loopback host** — an
  unset `sslmode` is left alone (most providers and every local setup work
  correctly without spelling it out); this only rejects an unambiguous
  opt-out of transport security against a real network destination.
- **Each entry in `OIDC_ADDITIONAL_ISSUERS`, when set, must also be HTTPS**
  (same bar as `OIDC_ISSUER`) and must not duplicate `OIDC_ISSUER` or
  another entry — see "Multiple identity providers, proxies, and custom
  certificate authorities" above.

Neither check is a substitute for docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md's
P0 item 19 (TLS/secrets/KMS/production-configuration baseline) — there's no
secrets manager or KMS integration here, and Fastify itself still expects
TLS to be terminated in front of it (a reverse proxy, per `TRUST_PROXY`'s
own doc comment) — this is the narrow, unilaterally-safe slice of that item:
failing startup on the specific insecure configurations above, matching
that item's own "Verification: Startup fails on insecure configuration."

## Running it

```bash
npm install
cp .env.example .env   # fill in OIDC_ISSUER and OIDC_AUDIENCE at minimum
npm run dev            # tsx watch, http://localhost:4000
```

`npm test` runs the full suite (251 tests as of this writing, plus 53 more
gated on `DATABASE_URL`/`REDIS_URL` — see "Persistence" above and
`src/cache/create-cache.redis.test.ts`) — the policy evaluator, the
in-memory store, OIDC token verification, and full request/response
integration tests (including patient-case CRUD and its authz gating) against
a real `fastify.inject()`-driven app instance, all using a locally generated
RSA keypair (no real IdP or network call needed to run the tests; see
`src/app.test.ts`). CI (`.github/workflows/ci.yml`'s `server` job) runs the
whole suite against real Postgres and Redis service containers, so the
gated suites above are actually exercised on every push/PR, not just when a
developer happens to run them locally.

`npm run build && npm start` builds to `dist/` and runs the compiled output.

## Identity: generic OIDC, not one vendor

`OIDC_ISSUER` and `OIDC_AUDIENCE` (both required) point at any
spec-compliant OIDC provider — Cognito User Pools, Keycloak, or anything
else. `src/auth/oidc-verifier.ts` verifies a bearer token's signature
(against the issuer's JWKS, resolved via `OIDC_JWKS_URI` directly or OIDC
discovery), issuer, audience, and expiry. Nothing here is Cognito- or
Keycloak-specific — this is deliberate, per
docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §4's decision to decide the actual
IdP per deployment topology rather than hard-code one.

`OIDC_AUDIENCE` is required, not just recommended, specifically because
this is a *generic* relying party: without checking `aud`, a validly-signed
ID token — or an access token minted for a completely different client of
the same IdP — would verify successfully here (same issuer, same signing
key, a real `sub` claim) and be treated as a genuine access token for this
API. `aud` is the portable, spec-defined way (RFC 7519 §4.1.3) to rule that
out without coupling this service to one provider's own token-type claim
(e.g. Cognito's `token_use`).

The verified token's `sub` claim becomes `User.externalSubject` — the only
thing tying a `User` record to a real identity. This service never stores a
password or any other credential.

### Multiple identity providers, proxies, and custom certificate authorities

(docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md P2 item 3: "proxy, custom CA, and
multiple-IdP compatibility.")

**Multiple IdPs.** Set `OIDC_ADDITIONAL_ISSUERS` to a JSON array of
`{issuer, audience, jwksUri?}` objects to accept tokens from more than one
IdP at once — e.g. migrating between providers, or federating a legacy
on-prem provider alongside a new cloud one. `OIDC_ISSUER`/`OIDC_AUDIENCE`
remain required and always trusted; this is purely additive. Each issuer
still needs its own real, HTTPS discovery/JWKS endpoint and a distinct
issuer string — a token is routed to the right issuer's keys by its own
(unverified) `iss` claim, but that routing is never itself the security
check: `src/auth/oidc-verifier.ts`'s `verifyAccessToken` independently
re-validates the real signature and issuer against whichever issuer got
selected, so a token that merely *claims* a trusted issuer without actually
being signed by it is rejected the normal way. Example:

```bash
OIDC_ADDITIONAL_ISSUERS='[{"issuer":"https://idp-b.example-hospital.org","audience":"modelforge-iam-server-b"}]'
```

**HTTP(S) proxy.** This process's outbound calls (OIDC discovery, JWKS
fetch) use Node's global `fetch`. If your network requires all outbound
traffic through a corporate proxy, set `NODE_OPTIONS=--use-env-proxy` (Node
≥ 22) and the standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` environment
variables — no application code or configuration here is needed, since this
is a Node runtime capability that applies to every outbound HTTPS call this
process makes.

**Custom/internal certificate authority.** If your IdP (or anything else
this process calls over HTTPS) presents a certificate issued by an internal
or self-signed CA, set `NODE_EXTRA_CA_CERTS=/path/to/your-ca-bundle.pem` —
again a Node runtime capability, not something this service implements or
needs to. Do not disable certificate validation (`NODE_TLS_REJECT_UNAUTHORIZED=0`)
as a substitute for this: that disables validation for every TLS connection
this process makes, including to your database and object storage.

## Authorization: real IAM-style JSON policy documents

A `Policy` is a named JSON document of statements, not a fixed role enum:

```json
{
    "version": "2026-01-01",
    "statements": [
        {
            "sid": "AllowCaseViewInCardiology",
            "effect": "Allow",
            "actions": ["patientCase:view"],
            "resources": ["organization:org-1/*"],
            "condition": { "StringEquals": { "user:department": "cardiology" } }
        }
    ]
}
```

- **Actions/resources** support `*` as a wildcard (`patientCase:*`,
  `organization:org-1/*`) — matched by `src/domain/policy-evaluator.ts`'s
  `matchesPattern`, a fixed pattern language, never a policy-author-supplied
  regex (that would make a policy document a code-injection-shaped surface
  instead of a data-shaped one).
- **Conditions** support `StringEquals`/`StringNotEquals` against a context
  map. `user:id` and `user:organizationId` are always injected server-side
  by `src/routes/guards.ts`'s `requirePermission` *after* any caller-supplied
  context, so a caller can never override its own resolved identity by
  sending a context key with the same name.
- **Evaluation semantics are AWS IAM's**: default deny (nothing matched →
  deny), and an explicit `Deny` statement always overrides any number of
  matching `Allow` statements, regardless of order or which policy they're
  in. See `src/domain/policy-evaluator.test.ts` for the full behavior matrix.
- **Policies attach to a `User` directly, to a `Group` the user belongs to,
  or both** — `IamStore.resolveEffectivePolicies` unions and de-duplicates
  across both before evaluation.
- **A `User` can optionally carry a permission boundary**
  (`permissionBoundaryPolicyId`, another AWS IAM concept) — a single policy
  that caps what their own policies (direct + via groups) can ever grant,
  regardless of how permissive those are. The effective decision is Allow
  only if *both* the identity's own policies and the boundary allow it; see
  `src/domain/policy-evaluator.ts`'s `evaluateWithBoundary`. Useful for
  safely delegating `iam:managePolicies` to a sub-admin without risking
  them (or anyone they grant access to) exceeding a defined ceiling.
  Setting or changing it is gated behind `iam:managePolicies`, same as
  `policyIds` (see the table below). **Fails closed**, not open: if the
  referenced policy is later deleted, the reference is left dangling on
  purpose (no foreign key at the storage layer) so
  `src/routes/guards.ts`'s `resolveEffectivePoliciesWithBoundary` denies
  that user everything rather than silently treating a vanished boundary
  as no boundary at all. `POST /organizations/:id/authz/check` — documented
  below as "the primitive every other service is meant to call" — goes
  through this same resolution, not a bare policy evaluation, so it never
  gives a different answer than every other route already enforces for the
  same user.

## Bootstrapping the first admin

`POST /organizations` is the one deliberate exception to "every other
endpoint requires an existing account with the right permission": creating
an organization requires only a valid bearer token (any authenticated
identity), because no organization exists yet for a permission check to be
scoped against. The caller automatically becomes that organization's admin,
via a `builtin: true` policy (`src/domain/builtin-policies.ts`) granting
`*` on `organization:{id}` and `organization:{id}/*` — scoped to that one
organization only, never wider. Every other route requires the caller to
already hold an account with the relevant `iam:*` permission in the target
organization; there is no self-service sign-up path beyond that one
bootstrap case.

## API surface

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | Original combined probe (kept for back-compat) — DB-aware, same as `/health/ready` below |
| GET | `/health/live` | none | Liveness probe — never depends on Postgres; "this process can answer HTTP" only |
| GET | `/health/ready` | none | Readiness probe — DB-aware; `503 degraded` when configured `healthCheck` fails |
| GET | `/metrics` | none (optional `METRICS_TOKEN`) | Prometheus exposition — see [docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md) |

Before promoting a candidate deployment, build the server and run the platform-neutral canary gate with `CANARY_BASE_URL=https://candidate... npm run ops:canary`. It verifies liveness, database-aware readiness, Prometheus metrics, consecutive success, and readiness p95, then emits a machine-readable JSON decision. See `docs/CANARY_RELEASES.md` for configuration and scope limits.
| POST | `/organizations` | bearer token only | Bootstrap: creates org + admin user + admin policy |
| GET | `/organizations/:id` | account in org | |
| GET | `/me` | bearer token only | Every org membership + effective policy names for this identity |
| GET/POST | `/organizations/:id/users` | `iam:listUsers`/`iam:manageUsers` | Setting `policyIds`/`permissionBoundaryPolicyId` also requires `iam:managePolicies` |
| PATCH | `/organizations/:id/users/:userId` | `iam:manageUsers` | 404 if the user id belongs to a different org; same extra `iam:managePolicies` gate as above |
| GET/POST | `/organizations/:id/invitations` | `iam:listUsers`/`iam:manageUsers` | Pending membership is first-class; acceptance binds the authenticated identity |
| POST | `/organizations/:id/invitations/:invitationId/accept` | bearer token + invite token | Activates the membership; invitation tokens are stored hashed |
| GET/POST | `/organizations/:id/service-principals` | `iam:listUsers`/`iam:manageUsers` | Non-human callers have distinct credentials and membership lifecycle |
| PATCH/DELETE | `/organizations/:id/service-principals/:principalId` | `iam:manageUsers` | Disable, rotate metadata, or revoke a service principal |
| GET/POST | `/organizations/:id/groups` | `iam:listGroups`/`iam:manageGroups` | |
| PATCH | `/organizations/:id/groups/:groupId` | `iam:manageGroups` | |
| GET/POST | `/organizations/:id/policies` | `iam:listPolicies`/`iam:managePolicies` | |
| PATCH/DELETE | `/organizations/:id/policies/:policyId` | `iam:managePolicies` | Deleting a builtin policy is 400 |
| POST | `/organizations/:id/authz/check` | account in org | The enforcement primitive — `{action, resource, context?}` → `{effect, matchedStatement?}` |
| GET | `/organizations/:id/cases?since={cursor}` | `patientCase:view` | Snapshot-consistent high-water feed; returns upserts and tombstones, filtered per resource |
| GET | `/organizations/:id/cases/:caseId` | `patientCase:view` | A denied case is indistinguishable from an absent case (`404`) |
| POST | `/organizations/:id/cases` | `patientCase:create` | `409` + current on id collision. Optional `Idempotency-Key` (see below) |
| PUT | `/organizations/:id/cases/:caseId` | `patientCase:edit` | Requires `If-Match`; changing access attributes also requires `patientCase:manageAccess` |
| DELETE | `/organizations/:id/cases/:caseId` | `patientCase:delete` | `If-Match` optional; `412` + current on mismatch, `404` if already gone. Already idempotent via the 404 convention — no `Idempotency-Key` support needed |
| POST | `/organizations/:id/case-migrations` | `patientCase:migrate` | Start/resume an idempotent staged local-to-shared migration |
| GET | `/organizations/:id/case-migrations/:migrationId` | `patientCase:migrate` | Inspect resumable state and the stored validation preview |
| PUT | `/organizations/:id/case-migrations/:migrationId/batches` | `patientCase:migrate` | Upload idempotent batches; same item key with different data is `409` |
| POST | `/organizations/:id/case-migrations/:migrationId/validate` | `patientCase:migrate` | Full-schema validation plus collision preview; staged rows stay invisible |
| POST | `/organizations/:id/case-migrations/:migrationId/activate` | `patientCase:migrate` | Atomically exposes validated rows and emits change-feed events |
| POST | `/organizations/:id/case-migrations/:migrationId/rollback` | `patientCase:migrate` | Hides imported rows and emits tombstones so clients converge |
| GET | `/organizations/:id/audit` | `audit:read` | Immutable audit trail (see below) — own action, not folded into any `iam:*`/`patientCase:*` permission |
| GET/POST | `/organizations/:id/scim-tokens` | `scim:manageTokens` | Manage SCIM bearer tokens for external IdP provisioning — see [docs/SCIM.md](../../docs/SCIM.md) |
| DELETE | `/organizations/:id/scim-tokens/:tokenId` | `scim:manageTokens` | Revoke a SCIM token |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/organizations/:id/Users[/:userId]` | SCIM bearer token (not OIDC) | RFC 7643/7644 provisioning — see [docs/SCIM.md](../../docs/SCIM.md) |

**`Idempotency-Key`** (POST/PUT only, `src/routes/idempotency.ts`): a
client-generated token identifying one logical write attempt. Resending the
same key with an identical body replays the original response instead of
re-running the write — the case this matters for is PUT: a client whose edit
succeeded server-side but never saw the response (dropped connection,
timeout) would otherwise retry with its now-stale `If-Match` and get a
spurious `412` indistinguishable from a real concurrent edit. Resending the
same key with a *different* body is rejected `409 idempotency_key_reused`
rather than silently running either version. Fully opt-in — omitting the
header behaves exactly as if it didn't exist. Records are kept 24h
(`InMemoryIdempotencyStore`/`PostgresIdempotencyStore`). Server-side support
only: nothing in `app/`'s client currently generates/retries with a key
(there's no offline-queue/retry loop yet to reuse one across attempts) — see
`docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md`'s "Offline edit and reconnect"
flow for the client-side half this sets up for.

**Audit log** (`src/store/audit-store.ts`): every IAM mutation
(organization/user/group/policy create/update/delete) and every case
write/delete records an entry — who (`actorExternalSubject`, plus
`actorUserId` once a User record exists), what (`action`, a fixed
`<resource>.<verb>` vocabulary like `"policy.delete"`), and which record
(`targetType`/`targetId`). Immutable: no update or delete method is exposed
by this store, by design. On Postgres, the audit row is written inside the
*same transaction* as the mutation it records (`insertAuditEntry`, called
with the mutation's own `PoolClient`) — a rolled-back mutation writes no
audit row, and a committed mutation can't fail to produce one; this is the
"transactional outbox" property
docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md's P0 item 11 asks for. The
in-memory mode has no transactions to join (nothing here does), so the
same guarantee holds trivially: `InMemoryIamStore`/`InMemoryCaseStore`
append the entry synchronously, in the same call, right alongside the
in-memory mutation itself — one shared `InMemoryAuditStore` instance is
passed to both (see `index.ts`) so IAM and case mutations merge into one
chronological trail, the same thing Postgres mode gets from both stores
writing into the same `audit_log` table. **Not included**: a publisher
that ships entries to an external system — nothing reads this table today
except `GET /organizations/:id/audit` itself; wiring a real "outbox" (a
process that tails new rows and forwards them) is separate work with no
concrete external destination yet to build against.

Every non-bootstrap, non-`/me` route requires an active first-class
membership for the authenticated human or service principal
(`src/routes/guards.ts`). A valid OIDC token without a membership gets
`403`, not a silent empty result and not auto-provisioning. A narrow legacy
fallback remains for pre-migration `User` rows that do not yet have an
`Identity`; once an identity exists the new membership model fails closed.

## Known gaps in this slice

- **No server-side encryption of case data** (see "What this is not"
  above) — `InMemoryCaseStore` holds plaintext in process memory,
  `PostgresCaseStore` stores plaintext JSONB (`patient_cases.data`); a real
  deployment needs Postgres-level encryption (TDE, encrypted volumes)
  configured by whoever operates it. This is the server-managed-keys
  trade-off docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §7 names explicitly,
  not silently assumed away.
- **`PostgresIamStore`, `PostgresCaseStore`, `PostgresCaseMigrationStore`,
  and `postgres-rls.test.ts`'s role-separation/RLS penetration tests are
  untested against a real database in this environment** (see
  "Persistence" and "Role separation" above) — the SQL has been reviewed
  carefully, including the Postgres-documented interaction between RLS and
  FK-triggered cascade deletes (`deleteOrganization`'s cleanup relies on
  cascades bypassing RLS rather than being blocked by it), but none of it
  is proven by execution. Run with `DATABASE_URL` (and, for the
  role-separation tests specifically, `RUNTIME_DATABASE_URL` pointed at a
  real `modelforge_runtime` role) before trusting any of this in
  production.
- **Role separation has no retroactive-grant path for an already-populated
  database** — `010_runtime_role_grants.sql`'s `ALTER DEFAULT PRIVILEGES`
  only covers tables created *after* `modelforge_runtime` exists. Every
  environment this ships to today (CI, any fresh deployment) creates the
  role before the first organization is bootstrapped, so the gap doesn't
  arise there; an operator turning on role separation against an existing,
  already-populated database needs to run the equivalent `GRANT`s by hand
  once, against each existing tenant schema, first.
- **Staged case migration has no persisted reconciliation report or
  rolled-back-data retention policy** — `activate()` now re-checks for a
  destination that changed since validation (concurrent case creation)
  before applying anything, and a failed activation/rollback attempt
  cleans up after itself (see `in-memory-case-migration-store.ts`'s and
  `postgres-case-migration-store.ts`'s doc comments), but there is no
  durable, queryable record of *what a completed activation actually did*
  beyond the migration's own `preview` snapshot, and no scheduled cleanup
  of `rolled-back` migrations' staged data — both are real features, not
  bugs, and need their own design pass.
- **`SharedBackendConnectionSection` (the Settings UI) has not been
  visually verified in a running Electron window** — no display was
  available in the environment it was built in. It typechecks cleanly and
  its underlying calls (`app/src/shared-backend-auth.ts`,
  `app/src/shared-backend-client.ts`,
  `app/src/shared-patient-cases-backend.ts`) are unit-tested against a
  mocked `fetch`, but the component itself — state transitions,
  form-then-connect-then-pick-organization flow, error rendering — has
  only been read-reviewed, not clicked through.
- **Version threading from the Electron UI is now real, but only for
  edits/deletes made through `PatientCaseDetail.tsx`/`PatientCases.tsx`** —
  both screens now pass the case's loaded `version` through
  `patientCases:update`/`patientCases:delete` and surface a
  `CaseWriteConflictError` as a toast + automatic reload rather than
  silently overwriting a concurrent edit. `grantConsent`/`revokeConsent`/
  `addClinicalNote`/`reviewClinicalNote` remain intentionally
  version-unaware (see `app/src/patient-cases-store.ts`'s doc comments on
  each — they're additive/append operations, not whole-record overwrites,
  so there is no "base snapshot" to protect).
- **No refresh-token handling, logout, or session concept** — this service
  only ever verifies a bearer token per request; session lifecycle is
  entirely the IdP's responsibility, consistent with delegating
  authentication to it.
- **No request logging beyond Fastify's own, or production TLS
  termination** — assumed to sit behind a reverse proxy/load balancer in any
  real deployment, not configured here. (Rate limiting *is* configured —
  see the API surface section above and `.env.example`'s `RATE_LIMIT_*`.)
- **The audit log (see "Audit log" above) has no publisher/outbox consumer
  and no hash-chaining** — every mutation is durably recorded and readable
  via `GET /organizations/:id/audit`, but nothing ships those entries
  anywhere external yet, and entries aren't cryptographically chained
  against tampering. The aggregated, hash-chained audit stream
  docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §3/§5 describes is a further,
  not-yet-built piece on top of this one.
- **Workspace and department are authorization attributes, not independent
  directory objects yet.** Case resources carry workspace, department,
  ownership, assignment, and consent attributes and policies can constrain
  all of them. CRUD/lifecycle management for workspace and department
  entities remains outside this slice.
