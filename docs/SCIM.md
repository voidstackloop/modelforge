# SCIM Provisioning

Status: **P2 backlog item 1** ("SCIM and external group reconciliation") of
`docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md`. Implements the core of SCIM 2.0
(RFC 7643/7644) Users provisioning — enough for a real institutional IdP
(Okta, Azure AD, OneLogin, ...) to automatically create, deactivate, and
reactivate accounts as people join and leave the organization's directory.
Groups are explicitly out of scope for this slice — see below.

## The one design decision worth understanding before touching this code

**A SCIM "create user" call creates an `Invitation`, not a new user record.**
This was a deliberate product decision, not an implementation shortcut —
asked directly rather than guessed at, given the real security stakes of an
identity-binding mechanism. The alternative (making `externalSubject`
optional on `User` and auto-binding a real OIDC login to a pre-provisioned
record by matching email) is how real Okta/Azure AD SCIM+OIDC integrations
usually work, but it needs a schema/store migration and new login-time
resolution logic with genuine account-takeover-adjacent risk if the
matching logic has a bug. Reusing the existing, already-tested Invitation
mechanism was chosen as the smaller, safer path.

**The consequence**: a SCIM resource's `id` is the `Invitation`'s id while
the invitation is pending. Once the invitee actually logs in and accepts
(via the normal `POST /organizations/:id/invitations/:id/accept` flow), the
resource becomes a real `User`/`Membership` with a **different** id. A
persistent SCIM client's own reconciliation loop — `GET
.../Users?filter=userName eq "..."`, which is what every real IdP actually
polls with for idempotent sync, not a remembered id from months ago —
always converges on the truth. A client that specifically cached the old
pending-invitation id would see it 404 after acceptance. This is disclosed
here and in `routes/scim.ts`'s own doc comment, not silently glossed over.

## Authentication

SCIM endpoints (`/scim/v2/organizations/:organizationId/...`) are
authenticated with a **static bearer token**, never OIDC — SCIM
provisioning happens *before* a real login, so there is no `sub` claim yet
to verify against. An org admin holding `scim:manageTokens` creates a token
via `POST /organizations/:id/scim-tokens` (OIDC-authenticated, like every
other admin route) — the plaintext secret is shown exactly once in that
response and never retrievable again (`GET .../scim-tokens` returns
metadata only). Paste it into the IdP's SCIM connector configuration as its
bearer token.

## Token delivery for a SCIM-created invitation

`POST /scim/v2/organizations/:id/Users` returns a non-standard
`modelforgeInviteToken` field alongside the standard SCIM User
representation — the plaintext acceptance token the invitee needs to call
`POST .../invitations/:id/accept`. SCIM itself has no concept of "a secret
the provisioning target needs delivered out of band," and a SCIM
connector has no mechanism to relay a response field to the actual human
being provisioned (it just syncs directory state). The organization is
responsible for actually getting this to the invitee — most IdPs' SCIM
connectors surface the raw response in their own provisioning/request logs
for exactly this kind of operational need. This is the same operational
reality as an admin-console-created invitation (also delivered out of
band, by design — this codebase has no built-in email sender for either
path), just automated instead of a human copying a token out of a browser.

## What's implemented

- `GET/POST /scim/v2/organizations/:id/Users` — list (with
  `filter=userName eq "value"`, pagination via `startIndex`/`count`) and
  create.
- `GET/PUT/PATCH/DELETE /scim/v2/organizations/:id/Users/:id`.
- `GET /scim/v2/organizations/:id/ServiceProviderConfig` and
  `/ResourceTypes` — lightweight discovery endpoints several IdP
  setup wizards fetch before the first real Users call.
- PATCH supports both real-world shapes for deactivation: Azure AD's
  path-based `{op:"replace", path:"active", value:false}` and Okta's
  value-object `{op:"replace", value:{active:false}}`. Any other operation
  in the payload is a documented no-op (RFC 7644 §3.5.2 treats an
  unrecognized attribute as valid, not an error).
- **DELETE never hard-deletes** — matching this codebase's standing
  convention elsewhere (MasterVault's soft-delete-only design,
  tenant-backup's non-destructive restore). It has the same effect as
  PATCH/PUT with `active=false`: revoke a still-pending invitation, or
  suspend an existing membership. The user record itself is never removed.
- SCIM uniqueness semantics: creating a `userName` that already resolves
  to an existing user or pending invitation is `409` with
  `scimType: "uniqueness"`, not a silent duplicate.
- Every SCIM-driven mutation is audited (`scimToken.create`/`.revoke`,
  plus the normal `invitation.create`/`user.update`/etc. entries the
  underlying operations already produce), attributed to
  `scim:<tokenId>` as the actor.

## What's explicitly out of scope for this slice

- **Groups.** SCIM group-membership push would need a way to apply a
  grant to a still-pending (Identity-less) invitee, which does not exist.
  Not attempted.
- **Full SCIM filter grammar** (RFC 7644 §3.4.2.2's and/or/not, other
  operators, complex attribute paths). Only `userName eq "value"` is
  supported — the one expression every real institutional IdP actually
  sends for idempotent sync. An unsupported filter is rejected with `400`,
  not silently ignored (which could return an unfiltered list a client
  might mistake for "no matches").
- **Bulk operations** (`ServiceProviderConfig` correctly reports
  `bulk.supported: false`).
- **PUT-based rename of a still-pending invitation.** There is no
  `PrincipalStore.updateInvitation` method; PUT only ever acts on
  `active`. Renaming an already-accepted user via PUT does work (the
  normal `updateUser` path).
- **SCIM's `PATCH .../Groups`, `emails[type=...]` multi-value semantics,
  and custom schema extensions.** Not modeled.

## Setup

1. In the admin console (or via `POST /organizations/:id/scim-tokens`
   directly), create a SCIM token with `scim:manageTokens`.
2. Configure the institution's IdP SCIM connector with base URL
   `https://<host>/scim/v2/organizations/<organizationId>` and the token
   as its bearer credential.
3. Assign people to the relevant directory group in the IdP; its SCIM
   connector will call `POST .../Users`.
4. Retrieve `modelforgeInviteToken` from the IdP's own SCIM request log
   and deliver it to the invitee through whatever channel the institution
   already uses.
5. Deprovisioning (removing someone from the directory group, or
   disabling their IdP account) triggers `PATCH`/`DELETE` automatically —
   no manual action needed on this side.
