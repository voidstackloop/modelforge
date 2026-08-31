# Clinical Imaging

Status: **implemented and unit/integration tested** across the server,
Electron trust boundary, and React case workflow: ingestion, sharing,
activity, a bundled OHIF 3.12 viewer, scoped QIDO/WADO access, conservative
PS3.15 metadata de-identification, and explicit adapter verification. Live
S3/PACS tests remain environment-gated because no credentials/endpoints are
available here; pixel OCR/redaction also remains a disclosed review gate.
This document is the trust-boundary, patient-matching, and integration
reference every imaging source file's own comments point back to.

## The architecture decisions this was built against

These were specified up front, not discovered along the way — recorded here
so a future change can be checked against the original intent:

- Imaging is a **dedicated domain**, not a generic file-attachment feature
  bolted onto `patientCase`.
- Original DICOM pixel data lives **outside** patient-case JSON and outside
  the case change feed — never in `case_changes`, never synced as a JSON
  blob.
- **Schema-per-tenant** isolation for clinical metadata (one Postgres schema
  per organization, same as everything else in this codebase) and
  tenant-isolated object storage for pixel data (object keys are always
  prefixed by `organizationId`).
- **DICOMweb**: STOW-RS for ingestion, QIDO-RS-shaped search, WADO-RS-shaped
  retrieval, behind a swappable `DicomwebAdapter`.
- **FHIR-inspired** resource shapes: `ImagingStudy`, `DiagnosticReport`,
  `DocumentReference` — loose TypeScript/zod types matching FHIR's field
  names and cardinality where it mattered for this system, not a full FHIR
  server or FHIR REST API.
- DICOM images and their clinical report are **separate, linked, versioned
  resources** — a report is never embedded in or overwrites a study.
- This is a **review/collaboration viewer**, explicitly not a diagnostic
  device: every viewer surface must carry "Not validated for primary
  diagnosis."
- **Adapter-first**: prefer a real PACS/VNA behind `DicomwebAdapter`; a local
  development adapter exists for when there is no PACS.
- Original DICOM objects are **immutable**. Derived images, annotations,
  reports, thumbnails, de-identified copies, and AI outputs carry
  `ProvenanceRecord`s back to their source.
- **`StudyInstanceUID` is never a tenant boundary by itself** — every lookup
  is tenant-schema-scoped first, UID second. Two different hospitals can
  legitimately have studies with colliding UIDs (some PACS/modality
  combinations are not globally unique in practice); tenant isolation must
  hold regardless.
- **Application sync carries imaging metadata, reports, permissions, and
  tombstones — never pixel data.** The imaging change feed
  (`imaging_change_log` per tenant schema) only ever references
  study/report/shareGrant rows, mirroring `case_changes`'s own shape.

## Where the code lives

| Concern | Path |
|---|---|
| Shared contracts (zod schemas + types) | [`packages/contracts/src/imaging.ts`](../packages/contracts/src/imaging.ts) |
| Tenant schema migration | [`server/migrations/017_clinical_imaging.sql`](../server/migrations/017_clinical_imaging.sql) |
| Repository interface | [`server/src/store/imaging-store.ts`](../server/src/store/imaging-store.ts) |
| In-memory repository (tests, local dev without Postgres) | [`server/src/store/in-memory-imaging-store.ts`](../server/src/store/in-memory-imaging-store.ts) |
| Postgres repository | [`server/src/store/postgres-imaging-store.ts`](../server/src/store/postgres-imaging-store.ts) |
| Object storage (local AES-256-GCM + S3/SSE-KMS) | [`server/src/imaging/object-store.ts`](../server/src/imaging/object-store.ts) |
| DICOM parsing/validation | [`server/src/imaging/dicom-parse.ts`](../server/src/imaging/dicom-parse.ts) |
| Thumbnail generation | [`server/src/imaging/thumbnail.ts`](../server/src/imaging/thumbnail.ts) |
| Ingestion pipeline | [`server/src/imaging/ingestion.ts`](../server/src/imaging/ingestion.ts) |
| Background job queue | [`server/src/imaging/background-queue.ts`](../server/src/imaging/background-queue.ts) |
| DICOMweb adapter (local + PACS proxy) | [`server/src/imaging/dicomweb-adapter.ts`](../server/src/imaging/dicomweb-adapter.ts) |
| PS3.15 de-identification | [`server/src/imaging/deidentification.ts`](../server/src/imaging/deidentification.ts) |
| CDN delivery (CloudFront signing) | [`server/src/imaging/content-delivery.ts`](../server/src/imaging/content-delivery.ts) |
| Electron/OHIF credential gateway | [`app/src/ohif-viewer.ts`](../app/src/ohif-viewer.ts) |
| Case imaging UI | [`frontend/src/components/imaging-panel.tsx`](../frontend/src/components/imaging-panel.tsx) |
| HTTP routes | `server/src/routes/imaging-*.ts` |
| Integration/security tests | [`server/src/routes/imaging.integration.test.ts`](../server/src/routes/imaging.integration.test.ts) |

## Tenant isolation

Every imaging table lives inside the organization's own Postgres schema
(migration 017 extends the same `provision_tenant_clinical_schema` function
migration 015 established). `TenantImagingRepository` is always obtained via
`imagingStore.forTenant(context)` — there is no method anywhere that can
resolve a resource without a `TenantContext` naming the schema first. UID
lookups (`findStudyByUid`, `findInstanceByUid`, `findStudiesByPatientIdentifier`)
run inside that schema's own tables via the store's tenant-scoped
connection; two organizations with colliding `StudyInstanceUID`s cannot see
each other's rows, and `imaging.integration.test.ts`'s cross-tenant test
exercises exactly this at the HTTP layer, not just at the repository layer.

Object storage keys are always `${organizationId}/...` (see
`instanceObjectKey()` in `dicomweb-adapter.ts`) — a second, independent
isolation boundary in case an object-store credential or bucket policy is
ever shared across tenants at the infrastructure layer.

## Patient identity matching

Ingestion matches DICOM `PatientID` + `IssuerOfPatientID` **exactly**
against existing studies' own `patientIdentifier` in the same tenant schema
— never fuzzy/demographic matching (name, DOB, etc.), which is a real
patient-safety hazard (two different patients sharing a name and birth
year is not a rare event in a hospital's population). If the match resolves
to more than one distinct `caseId`, or conflicts with a case the uploader
already expected, the job is held as `review-required` with
`failureCategory: "ambiguous-patient-match"` — never auto-resolved. The
instance bytes are quarantined in object storage (not published, not
attached to any study) until a human resolves the job via
`POST .../imaging/ingestion/:jobId/resolve` with either
`{decision: "attach", caseId}` — which publishes the held bytes to the
human-chosen case, attributing the resulting study to the resolving
reviewer — or `{decision: "reject"}`, which discards them without ever
creating a study. Resolution requires `imagingStudy:ingest`, never re-runs
the automatic ambiguity check (a human overriding it is the entire point),
and deletes the quarantine object either way, so a job cannot be resolved
twice (`409` on a second attempt).

## Ingestion pipeline

`POST /organizations/:organizationId/imaging/ingestion` accepts **one DICOM
instance per request**, raw binary body (`Content-Type: application/dicom`
or `application/octet-stream`), not multipart STOW-RS. This is a disclosed
scoping decision (see `imaging-ingestion.ts`'s and
`dicomweb-adapter.ts`'s own doc comments): a real STOW-RS
`multipart/related` parser is meaningful additional surface area that adds
no security-relevant behavior over "authenticate, validate, ingest one file,
repeat" for every caller this codebase actually has today (the Imaging-tab
upload flow, or a PACS forwarder). `ProxyDicomwebAdapter` still builds a real
multipart envelope for the *outbound* call to an actual external PACS.

Stages (`ingestion.ts`): size check → quarantine job row → DICOM structural
validation (`dicom-parse.ts`: transfer syntax, required identifiers,
Rows/Columns/NumberOfFrames bounds against a decompression-bomb-style
attack) → patient matching → find-or-create study/series by UID →
immutability check (a re-sent SOPInstanceUID with identical bytes is a
no-op; different bytes under the same UID is rejected, never silently
overwritten) → store original bytes via the tenant's `DicomwebAdapter` →
create instance/series/study rows → record provenance → publish. Every
failure path records a **closed-vocabulary** `failureCategory`
(`IngestionFailureCategory` in `imaging.ts`) — never file content, parsed
tag values, or any other PHI-shaped free text. Thumbnail generation runs
**after** the HTTP response, through a small bounded-concurrency queue
(`background-queue.ts`), so a burst of uploads can't spawn unbounded
parallel work and thumbnailing never delays the response an interactive
caller is waiting on.

`MAX_UPLOAD_SIZE_BYTES` (512 MiB) is enforced twice: as the route's own
Fastify `bodyLimit` (rejects an oversized body with `413` before it is even
fully buffered) and again inside `ingestOneInstance` as defense in depth.

## Authorization

Every imaging action is a normal policy-catalog action
(`server/src/domain/action-catalog.ts`): `imagingStudy:view`,
`imagingStudy:manageAccess`, `imagingStudy:ingest`,
`imagingInstance:retrieve`, `imagingAnnotation:create`,
`diagnosticReport:{view,author,sign,acknowledgeCritical}`,
`imagingShare:manage`, `imagingDeidentification:{request,review}` —
evaluated by the same policy engine as every other resource in this system,
nothing imaging-specific about the evaluator itself.

Resource-scoped routes (study, report, annotation, share) build a condition
context from `ImagingResourceAttributes` (owner, assigned users, sensitivity,
workspace, department, caseId) exactly like `routes/cases.ts` does for
`patientCase`, and return **identical 404s** for "does not exist" and
"exists but you cannot view it" — `imaging.integration.test.ts` asserts the
response bodies are byte-identical, not just both 404. Ingestion itself
(`imagingStudy:ingest`) is an org-wide action, not resource-scoped — there is
no existing study to check against at upload time — so a caller lacking it
gets an ordinary `403`, matching the same pattern `routes/scim-tokens.ts`
uses for other org-wide administrative actions.

## Viewer sessions

A viewer session is a short-lived (30 minute), server-issued, hashed bearer
token scoped to exactly one study and optionally a subset of its
series/instances — never a permanent object URL, never a raw credential, and
never passed as a query parameter (query strings end up in access logs and
browser history; the token is header-only). `routes/imaging-dicomweb.ts` is
the *only* consumer of this token — it is not usable against any OIDC-gated
route, and an OIDC bearer token is not usable against the DICOMweb routes.
Authorize-then-issue: `POST .../viewer-sessions` checks
`imagingStudy:view` then `imagingInstance:retrieve` before minting anything.
A session scoped to one study/series cannot retrieve an instance from a
different one — `imaging.integration.test.ts`'s direct-object-reference
test confirms this returns the same 404 as a nonexistent instance id.

## Sharing (item 9/10/11)

Three modes on `POST .../imaging/studies/:studyId/shares`
(`imagingShare:manage` required):

- **`internal`** — an explicit `recipientUserId` in the same organization.
- **`cross-organization`** — an explicit `recipientUserId` +
  `recipientOrganizationId`.
- **`external-portal`** — no OIDC identity at all. The response returns a
  `linkToken` and a separately-delivered `verificationCode` **once**, both
  hashed at rest; both must be presented together at
  `POST .../imaging/external-access/:linkToken` (deliberately not behind
  `authPreHandler`). A wrong code and a wrong token produce the **identical**
  404 — no signal to an attacker about which one was wrong. `allowDownload`
  is schema-enforced `false` for external-portal shares
  (`imagingShareGrantSchema`'s own `.refine()` in `imaging.ts`), not just a
  route-layer check.

Every grant is scoped to an exact study/series/instance/report — there is no
"this patient's imaging in general" grant shape. Revocation
(`POST .../shares/:shareGrantId/revoke`) always does two things in the same
transaction-equivalent handler: marks the grant revoked, and revokes every
viewer session issued from it. `imaging.integration.test.ts` proves this is
immediate (the very next WADO request with that session's token gets `401`)
and scoped (an unrelated internal session keeps working).

## Diagnostic reports

Immutable, versioned rows (`routes/imaging-reports.ts`). `POST .../amend`
never edits a row in place — it creates a new row with `previousVersionId`
pointing at the prior version, mirroring this codebase's existing
`PolicyVersion` pattern. Sign (`diagnosticReport:sign`) and critical-result
acknowledgement (`diagnosticReport:acknowledgeCritical`, `400` if the report
isn't actually flagged critical) are separate, explicitly attributed
actions, not implicit side effects of create/amend.

## What's implemented

- Contracts, tenant migration (validated against the real PostgreSQL grammar
  via `libpg-query`, not run against a live database — see "Known gaps"),
  in-memory and Postgres repositories.
- Local (AES-256-GCM encrypted-at-rest filesystem) and S3 (SSE-KMS) object
  storage, behind one `ImagingObjectStore` interface.
- `LocalDicomwebAdapter` (wraps the object store) and `ProxyDicomwebAdapter`
  (real STOW-RS/QIDO-RS/WADO-RS calls to an external PACS via `fetch`) behind
  one `DicomwebAdapter` interface, swappable per organization via
  `RouteDeps.createDicomwebAdapter`.
- Full ingestion pipeline with quarantine, structural validation,
  decompression-bomb-shaped bounds checks, exact patient matching,
  immutability enforcement, PHI-safe failure recording, and asynchronous
  thumbnailing.
- Resource-level authorization with identical-404 nondisclosure, wired
  through the existing policy engine and action catalog.
- Viewer sessions, all three sharing modes, DICOMweb-shaped retrieval.
- Case-level Imaging tab, multi-file upload, least-privilege sharing dialog,
  one-time external access details, recent ingestion activity, and an
  "Awaiting patient-match review" queue where a clinician attaches a held
  ambiguous upload to the case or rejects it.
- Official prebuilt `@ohif/app` 3.12 distribution embedded in the case UI.
  An Electron custom-protocol gateway retains the raw viewer token in main,
  injects it only as an upstream `Authorization` header, and closes the
  local capability when the iframe closes. The renderer receives only a
  random local gateway id, never the backend bearer token.
  Only the official prebuilt static `dist` is vendored under
  `app/vendor/ohif-dist`; its main bundle SHA-256 is
  `a075c65e1867a9eb5de67ece2a220d3bb9a3a5b8fab01250ac59d7afca6bea8f`.
  The npm dependency tree is deliberately not shipped: it introduced 50
  transitive advisories, including archive tooling the runtime viewer does
  not use. Production npm audits are clean after this packaging change.
- OHIF-compatible QIDO study/series/metadata and WADO-URI endpoints, each
  constrained to the exact study/series/instance scope of the viewer session.
- Conservative PS3.15 Basic Application Confidentiality Profile processing:
  patient identifiers are replaced, UIDs consistently remapped, dates
  removed or retained by profile, private tags removed, immutable derived
  Part 10 artifacts written, and provenance recorded. A separate reviewer
  must approve uncertain candidates; the requester cannot self-approve.
- CloudFront delivery for pixel data (opt-in): authorize-then-sign, 60-second
  custom-policy signed URLs bound to one object, `307` redirect, and fully
  opaque object keys so no DICOM identifier reaches a CDN access log. Off by
  default — see "AWS infrastructure" above.
- Startup wiring for S3/SSE-KMS, CloudFront, and PACS proxy modes plus an
  authenticated live verification endpoint. Storage verification performs a random,
  PHI-free write/read/delete round trip. PACS verification performs QIDO-RS
  and explicitly reports STOW/WADO as `not-run`.
- Diagnostic report workflow: create, immutable amend/correct, sign,
  critical-result acknowledgement.
- Annotations and a generic provenance ledger for every derived artifact.
- Clinical AI request integration for reviewed de-identification jobs. The
  case workspace can select an approved job, and the gateway re-authorizes the
  study/retrieval scope before adding a PHI-minimized manifest and immutable
  study citation to the request envelope. Raw DICOM bytes, storage keys, and
  viewer tokens never cross into the text provider adapter.
- Imaging-specific automated tests (object store, DICOM parsing,
  thumbnailing, ingestion pipeline, in-memory repository) plus 10 HTTP-level
  integration/security tests (`imaging.integration.test.ts`) covering the
  full ingest→view→retrieve path, cross-tenant isolation, identical-404s,
  immediate share-grant revocation, replayed/scoped viewer-session
  rejection, anti-enumeration on external access, and re-ingestion
  immutability. All pass; see "Tests run" below.

## What's still not implemented

Disclosed explicitly rather than silently left out — per the original
instruction not to create placeholders for critical security behavior
without saying so:

- **Automated pixel OCR/redaction is not claimed.** Metadata de-identification
  is implemented. If Pixel Data exists and `BurnedInAnnotation` /
  `RecognizableVisualFeatures` do not both establish a safe value, or the
  `clean-pixel-data` profile is requested, the derivative remains
  `pending-review`. Pixel bytes are unchanged and provenance records
  `pixelDataModified: false`. This prevents an unvalidated CV placeholder
  from silently approving an unsafe export.
- **`retain-safe-private` has no deployment-specific private-tag allow-list.**
  It currently takes the conservative result and removes all private tags.
  A site must define and validate its vendor-specific safe allow-list before
  any private element is retained.
- **Server-side GPU/CPU/RAM-aware scheduling through "the existing resource
  orchestrator."** That orchestrator
  (`app/src/resource-orchestrator.ts`) lives in the Electron desktop app and
  arbitrates local GPU/VRAM contention for on-device model inference — it
  has no meaning in this Fastify server process, which never touches a GPU.
  What the server-side pipeline actually needed (bounded concurrency,
  background-priority scheduling so thumbnailing never blocks an
  interactive request, isolated failure per job) is implemented in
  `background-queue.ts`; see that file's own doc comment for the full
  reasoning. If a server-side GPU-bound imaging feature (e.g. an AI pre-read)
  is added later, that is the point to revisit whether a heavier scheduler
  is warranted.
- **Legal hold / retention / backup integration** (item 20) with the
  existing `tenant-backup-store.ts`/audit-legal-hold infrastructure.
  Imaging tables are included in a tenant schema backup/restore only by
  virtue of being ordinary tables in that schema (`pg_dump`-style backup
  already captures them); no imaging-specific retention policy or legal-hold
  enforcement has been added.

## Known gaps / unverified paths

- **`PostgresImagingStore` has never run against a real Postgres instance**
  in this environment (no live database available here). Its SQL was
  statically validated against the real PostgreSQL grammar via `libpg-query`
  (a WASM binding to the actual Postgres parser) — 49 of 55 statements parse
  directly; the remaining 6 use dynamically-built `SET` clauses and were
  manually reviewed instead. This is real confidence in syntactic
  correctness, not a substitute for running the real migration and the
  store's own integration tests against a live database before production
  use.
- **`ProxyDicomwebAdapter` has not been exercised here against a real
  PACS/VNA.** It is built to the documented STOW-RS/QIDO-RS/
  WADO-RS wire shapes; validate against your actual PACS vendor before
  relying on it — vendor DICOMweb implementations vary in strictness.
- **`S3ImagingObjectStore` has not been exercised here against a real AWS
  account.** SSE-KMS + checksum parameters are set per the AWS SDK v3
  documentation; no live bucket/KMS key was available to verify against in
  this environment. `live-adapters.test.ts` runs the real probes when the
  required environment variables and credentials exist; all cases were
  skipped here because S3, PACS, and CloudFront configuration are absent.
- **CloudFront delivery has not been exercised against a real
  distribution.** The signing implementation is verified cryptographically
  offline — `content-delivery.test.ts` generates an RSA keypair, signs, and
  confirms the signature with `crypto.verify()`, so the RSA-SHA1 output and
  the custom-policy document are known correct. What that cannot prove is
  that CloudFront *accepts* them, which depends on distribution
  configuration (trusted key group, OAC, matching key pair id) that no
  amount of local testing can stand in for. Before relying on CDN delivery,
  run the environment-gated live test in `live-adapters.test.ts`: it fetches
  a probe object with a signature expecting `200` and without one expecting
  `403`, which together confirm both that delivery works and that the
  bucket is not publicly readable. Until that has been run against the real
  distribution, treat CloudFront mode as unverified and leave the
  `IMAGING_CLOUDFRONT_*` variables unset — the server then streams through
  the origin, which is fully tested.

## AWS infrastructure (S3 + CloudFront)

Pixel data is large: a single CT or MR study runs 100 MB - 2 GB across
hundreds of instances, and an OHIF viewer fetches them lazily in parallel.
Streaming all of that through the Fastify process is both a throughput
bottleneck and a denial-of-service surface, so a production deployment puts
CloudFront in front of the S3 imaging bucket. **This is opt-in.** With no
CloudFront configuration the server streams every byte itself
(`OriginStreamContentDelivery`), which is the default and the only mode the
local development setup uses.

### How authorization survives the CDN

The security model does not change when CloudFront is enabled, because the
CDN is only ever reached *after* the same checks the proxy path runs:

1. The viewer presents its session token to
   `GET .../imaging/wado/instances/:instanceId`.
2. The route resolves the session, confirms the instance exists, confirms it
   is inside the session's study/series/instance scope, and confirms the
   session grants `view` — the identical sequence as before, in the same
   order.
3. **Only then** is a CloudFront URL signed, bound by a custom policy to
   that one object path and expiring in 60 seconds.
4. The route replies `307` with that `Location` and no body.

`imaging.integration.test.ts` asserts the negative cases directly: an
out-of-scope instance, a nonexistent instance, an anonymous request, and a
revoked session each return their normal `404`/`401` **with no `Location`
header at all** — a regression that signed before authorizing would show up
as a working CDN link and fail those tests.

Signed URLs are deliberately capped at 60 seconds (300 s hard maximum) even
though the viewer session lasts 30 minutes. A viewer session is revocable
server-side; an issued signature is not, so it gets the much tighter bound.

### No DICOM identifiers in URLs

CloudFront and S3 both write full request paths to access logs, which live
outside this application's own PHI-safe audit trail. Object keys are
therefore built entirely from server-generated opaque UUIDs
(`instanceObjectKey` in `dicomweb-adapter.ts`) — `{organizationId}/{studyId}/
{seriesId}/{uuid}.dcm`. No SOPInstanceUID, accession number, or patient
identifier ever appears in a key, and therefore never in a CDN URL, a
browser history entry, or an infrastructure log line. This is safe because
keys are write-once: `storeInstance` returns the key, the instance row
persists it, and retrieval reads it back — nothing re-derives a key from
DICOM values.

### Required AWS resources

| Resource | Requirement |
|---|---|
| S3 bucket | Block Public Access fully on; versioning on; default encryption SSE-KMS with the CMK below; bucket policy allowing **only** the CloudFront distribution via Origin Access Control |
| KMS CMK | Customer-managed, with rotation enabled. Grant `kms:Decrypt`/`kms:GenerateDataKey` to the server's task role, and `kms:Decrypt` to the CloudFront OAC service principal |
| CloudFront distribution | Origin Access Control (not legacy OAI); `ViewerProtocolPolicy: https-only`; a **trusted key group** holding the public half of the signing key; access logging to a separate log bucket |
| CloudFront key pair | RSA 2048. Public half uploaded to CloudFront as a public key in the trusted key group; private half supplied to the server as `IMAGING_CLOUDFRONT_PRIVATE_KEY` |
| Server task role | `s3:PutObject`/`GetObject`/`DeleteObject` on the bucket prefix, plus the KMS grants above. **No** `s3:PutBucketPolicy` or any CloudFront mutation permission |

Two properties are worth stating explicitly because they are easy to get
wrong and silently insecure: the bucket must not be publicly readable (OAC
is what lets CloudFront read it), and the distribution must require signed
URLs (an untrusted-key-group distribution serves everything to everyone).
The environment-gated live test in `imaging/live-adapters.test.ts` checks
both — it fetches a probe object with a signature expecting `200`, then
without one expecting `403`.

### Configuration

```
IMAGING_S3_BUCKET=modelforge-imaging-prod
IMAGING_S3_KMS_KEY_ID=arn:aws:kms:eu-west-1:...:key/...
IMAGING_S3_REGION=eu-west-1
IMAGING_S3_KEY_PREFIX=            # optional
IMAGING_CLOUDFRONT_DOMAIN=d111111abcdef8.cloudfront.net
IMAGING_CLOUDFRONT_KEY_PAIR_ID=K2JCJMDEHXQW5F
IMAGING_CLOUDFRONT_PRIVATE_KEY=   # base64 of the PEM private key
```

All three CloudFront variables are required together, and require S3 —
`config.ts` rejects a partial configuration at startup rather than
silently degrading to origin streaming with inert CDN settings. AWS
credentials come from the normal SDK provider chain (task role in
production; never static keys in env).

### On RSA-SHA1

CloudFront's signed-URL protocol mandates RSA-SHA1 and rejects SHA-256
signatures. That is AWS's protocol, not a choice this code makes. The
scheme's security here does not rest on SHA-1 collision resistance: the
server is the only party producing policies, policies are entirely
server-controlled (no attacker-influenced content to collide against), and
the validity window is 60 seconds. Flagged so a future reader or auditor
does not read it as an oversight.

## Migration and deployment

1. Run `server/migrations/017_clinical_imaging.sql` after 001–016. It
   extends `provision_tenant_clinical_schema` (replaces the function,
   idempotent) and adds a new `provision_tenant_imaging_tables` function,
   then backfills every already-provisioned organization's schema — no
   manual per-tenant step needed.
2. Server dependencies (`dicom-parser`, `dcmjs`,
   `@aws-sdk/client-s3`) are installed. The Electron viewer uses the
   versioned official prebuilt OHIF static distribution in
   `app/vendor/ohif-dist`, copied into packaged resources; no OHIF Node
   dependency tree is shipped. Nothing extra is needed for the
   local-filesystem-backed default.
3. Local persistent mode requires `IMAGING_LOCAL_ROOT` and a stable
   32-byte-base64 `IMAGING_ENCRYPTION_KEY`. Without the key, startup warns
   and uses a random development key that cannot survive restart.
4. S3 mode requires `IMAGING_S3_BUCKET`, `IMAGING_S3_KMS_KEY_ID`, and
   `IMAGING_S3_REGION` together; `IMAGING_S3_KEY_PREFIX` is optional. AWS
   credentials use the normal SDK provider chain.
5. PACS proxy mode requires HTTPS `IMAGING_PACS_BASE_URL` and
   `IMAGING_PACS_AUTH_HEADER`. Partial or plaintext configuration fails at
   startup.
6. CloudFront delivery requires `IMAGING_CLOUDFRONT_DOMAIN`,
   `IMAGING_CLOUDFRONT_KEY_PAIR_ID`, and `IMAGING_CLOUDFRONT_PRIVATE_KEY`
   together, plus S3 — see "AWS infrastructure" above for the distribution,
   OAC, and key-group requirements. Omit all three to stream through the
   origin.
7. After deployment, call authenticated
   `POST /organizations/:id/imaging/integrations/verify` and retain the
   result as deployment evidence. It reports storage read/write/delete,
   PACS QIDO reachability, and CDN signing capability. Note that
   `contentDelivery.edgeDelivery` is always `not-run` — proving CloudFront
   actually serves the signed URL requires the environment-gated live test
   (below), not a server self-check.

## Tests run

```
cd server && npm run typecheck   # clean
cd server && npm test            # 455 passed, 78 skipped
cd app && npm run build          # clean
cd app && npm test               # 851 passed, 1 skipped
cd frontend && npm run build     # clean
cd frontend && npm test          # 100 passed
```

Imaging-specific: `object-store.test.ts` (9), `dicom-parse.test.ts` (12),
`thumbnail.test.ts` (4), `ingestion.test.ts` (16, including manual
ambiguous-match resolution), `in-memory-imaging-store.test.ts` (13),
`content-delivery.test.ts` (10 — CloudFront signatures verified against a
locally-generated RSA keypair with `crypto.verify()`, not shape-checked),
`imaging.integration.test.ts` (16 HTTP-level security tests, 4 of them
covering CDN delivery and its negative authorization cases),
`deidentification.test.ts` (real Part 10 rewrite), and `ohif-viewer.test.ts`
(token excluded from renderer URL, injected only into the upstream header)
— all passing.

Skipped, with reasons: `postgres-*.test.ts` (7 files) and
`create-cache.redis.test.ts` need a live Postgres/Redis, neither available
in this environment — CI provisions both. `live-adapters.test.ts` (3 tests)
is environment-gated on real S3, PACS, and CloudFront configuration; all
three were unset here.

## Remaining regulatory / clinical / security review

- This is explicitly **not validated for primary diagnosis**. The Imaging
  tab and OHIF modal both render that label; regulatory validation of the
  software as a diagnostic device remains outside this implementation.
- Metadata de-identification is implemented, but it is not a blanket
  compliance certificate. Pixel safety remains a human-review control as
  described above, and approved derivatives need deployment-specific SOPs.
- **HIPAA/regulatory sign-off on the patient-matching logic** (exact
  PatientID+Issuer match, ambiguous-match hold) should be reviewed by
  clinical/compliance stakeholders before go-live — this was implemented per
  the spec's own explicit instruction ("never fuzzy/demographic matching").
  The resolution workflow is implemented, audited, and surfaced in the
  Imaging tab, but who is authorized to resolve a held match, and on what
  evidence, is a deployment-specific clinical SOP this codebase cannot
  decide.
- **Encryption key management** for `LocalFilesystemImagingObjectStore` is
  development-only (random key per process, lost on restart — by design, so
  a locally-encrypted dev volume is never mistaken for a durable production
  store). Production deployment must use `S3ImagingObjectStore` with a real
  KMS key and a real key-rotation policy, neither of which exists yet.
- **Business associate / vendor agreements** for any external PACS or AWS
  account this is pointed at are an organizational, not a code-level,
  requirement — out of scope for this document.
