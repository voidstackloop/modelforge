# ModelForge v1.3.0 release validation

Date: 2026-08-31

## Result

The installed Windows release and the repository build passed the automated,
integration, container, and visual checks listed below. The validation recording
contains synthetic, PHI-free data and captures only the ModelForge application
window.

[Watch the compact release proof](assets/modelforge-v1.3.0-release-proof.mp4)

## Installed release walkthrough

The 3-minute, 655 KB H.264 recording demonstrates:

- local-only chat and the new-chat workflow;
- Runtime Manager detection and live telemetry for an NVIDIA RTX 4060;
- balanced, performance, efficient, and manual resource profiles;
- Download Center limits and concurrent-download controls;
- audit, privacy, encryption, and audit-backend status;
- a synthetic patient case and its inclusion controls;
- Evidence Library and Knowledge Graph navigation.

No AWS credential, AWS account identifier, prompt, patient identifier, or other
secret is visible in the recording or this report.

## Automated evidence

| Area | Result |
| --- | --- |
| Desktop application unit tests | 1,018 passed, 1 skipped across 78 files |
| Server default test mode | 650 passed, 84 skipped across 55 files |
| Server with isolated PostgreSQL and Redis | 731 passed, 3 opt-in live-adapter tests skipped across 55 files |
| Frontend tests | 101 passed |
| Admin console tests | 61 passed |
| MasterVault tests | 14 passed |
| Rust native tests | 80 passed |
| Playwright desktop E2E | 25 passed |
| Imaging CDK regression tests | 3 passed |

The Playwright suite covers approvals, audit persistence and backend migration,
backup/restore, signed central policy handling, cancellation, Download Center,
llama.cpp chat and agent tool gating, medication safety, onboarding, patient-case
backend configuration, response contracts, settings persistence, and
single-instance behavior.

Production builds/typechecks passed for the desktop application, server,
frontend, admin console, shared contracts, MasterVault, Rust native component,
E2E package, and imaging CDK. Frontend and admin lint also passed.

The development container stack was rebuilt and verified healthy. PostgreSQL,
Redis, the API, Keycloak, and the admin console all started successfully; the API
health endpoint returned `{"status":"ok"}` and the admin console returned HTTP
200.

## Defects corrected during validation

1. The server container could load a stale copied `@modelforge/contracts`
   package and fail during startup. The image now links the workspace contracts
   package after dependency installation.
2. The API health check did not reliably consume the response or terminate from
   the HTTP status. It now exits deterministically after consuming the response.
3. The PostgreSQL migration-audit test ordered same-timestamp events only by
   `created_at`. It now asserts the audit ledger's monotonic numeric sequence.
4. The imaging CDK stack contained a redundant exact-distribution KMS grant that
   created a CloudFormation dependency cycle. The stack now relies on the CDK
   OAC-generated, account-scoped distribution grant.
5. The dedicated CloudFront access-log bucket used bucket-owner-enforced object
   ownership, which is incompatible with CloudFront legacy standard logging. It
   now enables the required object-writer ownership while retaining public-access
   blocking. The PHI imaging bucket remains bucket-owner-enforced.
6. CloudFormation descriptions used unsupported punctuation. They now use the
   supported ASCII character set.

Regression tests protect the CloudFront log-bucket ownership, KMS grant shape,
and CloudFormation description character set.

## External deployment status

The imaging stack synthesized successfully after the fixes. Deployment reached
AWS and exposed the CloudFront logging and dependency-cycle defects above, but a
subsequent deploy is blocked before resource mutation because the account's CDK
bootstrap toolkit is version 28 and the current deployment requires version 30.
Upgrading the bootstrap stack changes account-level deployment IAM and therefore
requires explicit operator approval. No credential value was read or printed.

Production Compose configuration additionally requires deployment-specific
`OIDC_ISSUER` configuration; no value was invented for validation.

## Scope boundary

This run verifies all repository-owned automated suites and the installed
workflows listed above. Provider-dependent live imaging adapters, real clinical
data flows, real external model/provider credentials, and the final AWS resource
deployment require their respective controlled environments and are not claimed
as exercised here.
