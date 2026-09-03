# SMART App Launch (client role)

This is the complement to `docs/FHIR_INTEGRATION.md`'s SMART section. That document covers this
server acting as a SMART **resource server** (an external app presenting a SMART-scoped token to
*this* server's own FHIR facade). This document covers the opposite direction: this server acting
as a SMART **client**, launched from — or reaching out to — an *external* EHR's FHIR server to
obtain a patient-scoped access token. The two are independent capabilities that happen to share the
SMART App Launch spec; neither depends on the other.

## What this is

A standard SMART App Launch **public client**, authorization_code + PKCE (S256) only — never a
confidential client, never `client_secret`. Four pieces:

- `server/src/smart-launch/discovery.ts` — resolves an EHR's own
  `{fhirBaseUrl}/.well-known/smart-configuration` (distinct from the OIDC discovery
  `auth/oidc-verifier.ts` uses for ModelForge's own IdP) to find its `authorization_endpoint`/
  `token_endpoint`.
- `server/src/smart-launch/pkce.ts` — S256 code verifier/challenge and CSRF `state`, one pair per
  launch session.
- `server/src/smart-launch/service.ts` — `createLaunchSession` (validates the target issuer and
  `redirectUri` against an org-configured allowlist, builds the authorization URL) and
  `completeLaunchCallback` (single-use: exchanges the code for a token, encrypts it, marks the
  session completed).
- `server/src/smart-launch/token-crypto.ts` — AES-256-GCM at rest, the exact envelope format
  (`iv || authTag || ciphertext`) already used by `imaging/object-store.ts`. Keyed by
  `SMART_LAUNCH_ENCRYPTION_KEY` (32 bytes, base64); the token-exchange route 503s if it isn't set,
  rather than ever encrypting with no real key (`routes/deps.ts`'s own doc comment on
  `smartLaunchEncryptionKey`).

Routes (`server/src/routes/smart-launch.ts`), all org-scoped under
`/organizations/:organizationId/smart/...`:

| Route | Gate | Purpose |
|---|---|---|
| `PUT .../trusted-issuers` | `smartLaunch:manage` | Register an EHR issuer + its `client_id` + allowed `redirectUris` |
| `GET .../trusted-issuers` | `smartLaunch:manage` | List them |
| `POST .../trusted-issuers/delete` | `smartLaunch:manage` | Remove one |
| `POST .../launch-sessions` | `smartLaunch:use` | Start a launch: discover, validate, return an authorization URL |
| `POST .../launch-sessions/:state/callback` | `smartLaunch:use` | Exchange the code, store the encrypted token |
| `GET .../sessions` | `smartLaunch:use` | List the caller's own completed launches |
| `POST .../sessions/:sessionId/revoke` | `smartLaunch:use` | Delete a caller's own stored token |

Persistence: `store/smart-launch-store.ts` (interface), `in-memory-smart-launch-store.ts`,
`postgres-smart-launch-store.ts` (`smart_trusted_issuers`/`smart_launch_sessions`/
`smart_launch_tokens` tables, migration `026_smart_launch.sql`, provisioned per-tenant the same
way every other clinical domain is). A public API response never carries a secret — internal
session/token shapes (with `codeVerifier`/`encryptedAccessToken`/etc.) are stripped down to
`publicLaunchSession`/`publicToken` before ever reaching a route handler's `reply.send`.

## The design decision this was built against

**Every SMART launch route requires an already-authenticated ModelForge session first.** This was
an explicit choice (not a default): a launch never creates or auto-provisions a ModelForge
identity, and there is no unauthenticated redirect entry point anywhere in this flow — every route
sits behind the exact same bearer-token `authPreHandler` every other route in this API uses. A
launch — EHR-initiated (`launch` token present) or standalone — only *attaches* a patient-scoped
external token to a clinician's existing session; it never establishes who that clinician is. This
avoids a second, harder trust problem (verifying an EHR-asserted identity claim and mapping it to a
ModelForge principal) that a from-scratch SSO/auto-provisioning design would require, and keeps the
blast radius of a compromised or misconfigured trusted-issuer entry to "an authenticated clinician
can fetch data from an EHR they already had reason to talk to," not "an unauthenticated caller can
reach ModelForge at all."

Other decisions:

- **Exact-match `redirectUri` allowlisting per trusted issuer**, not a prefix or pattern match —
  the open-redirect/code-theft guard `service.test.ts` exercises directly.
- **Single-use `state`.** A launch session can only ever be completed once; a second callback with
  the same `state` is rejected (`session_not_pending`), matching the OAuth spec's replay guidance.
- **10-minute session TTL** (`SESSION_TTL_MS` in `service.ts`) between starting a launch and
  completing its callback.
- **A non-2xx token endpoint response is wrapped, never passed through.** `completeLaunchCallback`
  raises `SmartLaunchCallbackError` with a fixed `token_exchange_failed` message — an EHR's raw
  error body (which can carry internal detail) is never included in any response or thrown message,
  per `service.test.ts`'s own "never leaking the raw response body" test.
- **`smartLaunch:manage` vs `smartLaunch:use` are separate actions**, mirroring every other
  admin-config-vs-use split in `domain/action-catalog.ts` (e.g. `aiGateway:manageProviders` vs
  `aiGateway:invoke`): configuring which EHRs are trusted is a materially different privilege from
  using an already-trusted one.

## What is deliberately NOT implemented (disclosed gaps)

- **No FHIR proxy.** Once a token is stored, nothing in this server uses it to actually fetch data
  from the EHR's FHIR API. `GET .../sessions` returns the token's metadata (`patientId`, `scope`,
  `hasRefreshToken`, expiry) for a caller to use with their own tooling — this server does not act
  as a pass-through proxy to the EHR's endpoints. Building that would mean re-deriving this
  server's own FHIR-read authorization logic (`docs/FHIR_INTEGRATION.md`) for a completely
  different, externally-hosted, non-ModelForge-shaped dataset — out of scope here.
- **No automatic token refresh**, despite storing `refresh_token` (encrypted, when the EHR returns
  one). `hasRefreshToken` is exposed so a caller knows one exists; nothing currently uses it. A
  launch session simply expires when the EHR's own `expires_in` elapses, requiring a fresh launch.
- **Public client only.** No `client_secret` / confidential-client support. This avoids a second
  secrets-management problem (client secret storage, rotation, per-issuer scoping) in this pass;
  every trusted issuer is assumed to support public-client PKCE, which most modern EHR sandboxes
  (Epic, Cerner/Oracle Health, SMART Health IT reference server) do.
- **No EHR-initiated launch's `iss`/`launch` query-param redirect endpoint.** An EHR's own "launch
  this app" click normally lands on a fixed redirect URL carrying `?iss=...&launch=...`; this
  server has no such unauthenticated landing route (per the design decision above — there is no
  unauthenticated entry point at all). Consuming an EHR-initiated launch today means: the
  ModelForge UI captures the `launch` token from wherever it lands, and calls
  `POST .../launch-sessions` with it as an already-authenticated clinician, exactly like a
  standalone launch. There is no server-side handling of the EHR's actual `iss=`/`launch=` redirect
  itself.
- **No `aud` validation beyond echoing it.** The authorization URL includes `aud=<issuer>` per the
  SMART spec's confused-deputy guidance, but this server does not independently verify the EHR
  actually enforced it — that enforcement lives entirely on the EHR side.
- **Not validated against a SMART/Inferno conformance test suite.** Built to the spec's
  authorization_code + PKCE flow as documented, not run against Da Vinci/Inferno or any EHR
  sandbox's own certification suite.

## UI

`app/src/smart-launch-client.ts` (REST glue, same pattern as `imaging-client.ts`) and
`app/src/smart-launch-flow.ts` (`runSmartLaunch`) drive the flow from the Electron main process —
the latter mirrors `mcp-oauth.ts`'s own established loopback-redirect pattern exactly: a transient
`http://127.0.0.1:51824/smart/callback` listener (a different port from MCP OAuth's own 51823, so
the two can never collide), `shell.openExternal` to hand the user to the EHR's login in their
system browser, then a single-use capture of `?code=&state=` before the listener closes itself.
`state` is checked against the session this process itself started (defense in depth — the server
enforces it independently) before ever calling back. The IPC surface
(`smartLaunch:listTrustedIssuers`/`upsertTrustedIssuer`/`deleteTrustedIssuer`/`listSessions`/
`revokeSession`/`start`) is registered in `ipc/shared-backend-handlers.ts` alongside imaging/
clinicalAi's own handlers, exposed via `preload.ts`. `smartLaunch:start` follows the same
catch-and-return-`{error}` shape as `mcp:startOAuthFlow`/`sharedBackend:connect` (both also
long-running, user-interaction-gated flows), rather than rejecting the IPC call, so a timeout or a
closed browser tab surfaces as an ordinary inline error, not an unhandled-rejection crash.

The renderer page is `frontend/src/pages/ExternalEhr.tsx` (nav: "External EHR"): trusted-issuer
admin (register/remove — the API's own `smartLaunch:manage` gate is the actual enforcement; the
form itself isn't hidden from anyone, matching every other admin-shaped control already in this
app, e.g. `imaging-panel.tsx`'s `ShareDialog`), a launch trigger (pick a trusted issuer, click
Launch), and the caller's own active-session list with revoke. `GET .../smart/trusted-issuers` was
relaxed server-side to accept `smartLaunch:use` as well as `smartLaunch:manage` specifically to make
this page's launch dropdown possible — a clinician has to see which EHRs are configured to pick one,
and none of that data (issuer URL, public `client_id`, redirect URIs) is secret in a PKCE-only,
no-`client_secret` design. Only the trusted-issuer PUT/delete routes stay `smartLaunch:manage`-only.

## Extending this

Adding a FHIR proxy on top of a stored token would need: a new route that decrypts the token
(`token-crypto.ts`), makes the request server-side, and re-applies this server's own IAM +
data-minimization discipline to whatever comes back — never just relaying the EHR's raw response,
since that would bypass every governance layer `docs/CLINICAL_AI_GATEWAY.md` and
`FHIR_INTEGRATION.md` already established. Adding refresh-token use means a background or
on-demand refresh path in `smart-launch/service.ts`, re-encrypting the new access token and
updating `expiresAt` — the store schema already has everything needed (`encryptedRefreshToken`);
only the refresh call itself is unbuilt.
