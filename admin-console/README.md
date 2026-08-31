# ModelForge Admin Console

A separate, standalone web app for managing a ModelForge organization's IAM —
users, groups, policies, invitations, service principals, and the audit log —
against the `server/` API. Deliberately **not** part of the Electron
clinician app (`app/`/`frontend/`): per
`docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md` §5, this is meant to be its own
trust boundary, reusing `frontend/`'s component kit but not its shell.

## Running it

```bash
npm install
cp .env.example .env.local   # fill in VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_API_BASE_URL
npm run dev
```

The server this app talks to must have `ADMIN_CONSOLE_ORIGIN` set to this
app's own origin (see `server/.env.example`) — the API has no CORS support
at all otherwise, and every request here will be blocked by the browser
regardless of any other configuration.

Your identity provider needs a second, separate OAuth client registered for
this app (Authorization Code + PKCE, public client, no secret) — same
issuer as the Electron app's, different `client_id` and `redirect_uri`.

## What this is not (yet)

- **No step-up/MFA re-authentication, no separate admin OIDC audience.**
  This app's tokens carry the same `OIDC_AUDIENCE` the server already
  validates for every other caller — a stolen admin-console token and a
  stolen Electron-app token are equally powerful at the API layer; only the
  caller's own attached IAM policies happen to differ. Both are named as
  future admin-console hardening in `docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md`
  (line 216).
- **No persisted session.** Tokens are held in memory only — a page reload
  requires signing in again. No silent renewal either.
- **No backend pagination or search.** Every list endpoint this app calls
  returns its entire, unbounded result in one response (see `server/`'s own
  README for the full list of API gaps) — this app filters/paginates
  client-side over whatever it already fetched. The Audit screen in
  particular loads the organization's entire history in one request.
- **No delete for Users or Groups, no credential rotation for Service
  Principals** — these aren't UI omissions, the API has no such operations
  (Users/Groups only support suspend/edit; a service principal
  authenticates with its own externally-issued OIDC token, so ModelForge
  never has a credential to rotate in the first place).
- **No visual policy builder.** Policies are created/edited via a raw JSON
  textarea, validated client-side against the same schema the server
  enforces (`pages/policy-document-schema.ts`) before submit.

## Screens

The IAM and enterprise-governance surfaces have screens for Users,
Invitations, Groups, Policies, Service Principals, Audit, Break Glass,
Access Reviews, Backup, Inference, and the institutional MCP Registry. Each follows the same shape — a list with
client-side search where useful, create/edit via a `Dialog`, and every
create/edit action gated on the same `iam:*`/`audit:read` permission the
server itself requires (see `lib/authz/permissions.ts`) so the UI never
offers an action the API would just reject.

## Verification status

Unit-testable pieces (`lib/api/client.ts`, `lib/authz/permissions.ts`,
`lib/auth/in-memory-web-storage.ts`, `pages/policy-document-schema.ts`) are
covered by `npm test`, no real IdP or server needed. The scaffold and auth
flow were also exercised live against a real running dev server (see the
session that built this — caught and fixed a real bug: `signIn()`'s
`userManager.signinRedirect()` failure was originally never caught). The
actual OIDC Authorization Code + PKCE round trip against a live IdP, CORS
actually unblocking a real browser `fetch` against a real running server,
and the five non-Users screens' actual data flows against a real
authenticated session have **not** been executed in the environment this
was built in (no registered OIDC client, no real backend session to
authenticate) — confirm all three against a real IdP + deployed server
before relying on this for real administration.
