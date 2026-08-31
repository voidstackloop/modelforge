# ADR 0001: Clinical tenant isolation

- Status: Accepted
- Date: 2026-08-27
- Owners: Enterprise architecture and security

## Decision

Clinical patient/case data uses one generated PostgreSQL schema per organization. Shared IAM/control-plane metadata remains in shared tables with `organization_id`, composite scoping, tenant-bound repository transactions, and PostgreSQL row-level security.

An opaque organization UUID maps through the server-owned tenant directory to a validated identifier of the form `tenant_<32 lowercase hex characters>`. Client input is never used as a SQL identifier. Every clinical repository is constructed from an immutable `TenantContext`; application-facing methods contain no organization-id argument.

## Consequences

- A missing or incorrect row filter cannot cross from one organization's clinical schema into another.
- Clinical migrations and backups must iterate tenant schemas.
- Pooled connections must set tenant state inside a transaction and clear it before reuse.
- The migration/runtime database roles remain separate in production. Runtime can use provisioned schemas and cannot bypass RLS.
- IAM metadata is not PHI and keeps a single migration path, but RLS and tenant-bound repository APIs provide defense in depth.

## Rejected alternatives

- Shared clinical tables plus RLS: lower operational cost, but one missing policy on a future PHI table would be a silent cross-tenant leak.
- Application filtering only: relies on every query author remembering the invariant and is not an acceptable PHI boundary.
