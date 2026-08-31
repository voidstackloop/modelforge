# ADR 0002: Membership and principal model

- Status: Accepted
- Date: 2026-08-27
- Owners: Enterprise architecture and identity

## Decision

Organization access is modeled with separate first-class concepts:

- `Identity`: one verified OIDC issuer-plus-subject identity.
- `Membership`: the identity's tenant-local lifecycle, provisioning source, start/expiry, and active/suspended/deprovisioned state.
- `Invitation`: a pending, expiring, single-use membership offer whose token is stored only as a SHA-256 digest.
- `ServicePrincipal`: a non-human OIDC workload identity with its own lifecycle, policy attachments, permission boundary, and audit identity.

The existing `User` record remains the tenant-local human profile/policy compatibility projection. Authentication never creates membership implicitly. Invitation acceptance or an audited administrator/bootstrap operation creates it explicitly.

## Consequences

- Pending people and non-human callers are not encoded as fake active users.
- Membership revocation is independent from the external identity provider account.
- A partially provisioned IAM-v2 identity without a membership fails closed.
- Human and service-principal authorization share policy evaluation while retaining distinct audit principal types.

## Rejected alternative

Users-only conventions were rejected because they cannot safely represent pending invitations, non-human credentials, provisioning provenance, expiry, or deprovisioning without another schema retrofit.
