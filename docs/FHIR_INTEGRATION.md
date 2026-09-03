# FHIR R4 Integration

`routes/fhir.ts` exposes a **read-only FHIR R4 facade** over data this system already stores and
protects — clinical cases (`patient_cases`) and clinical imaging (`docs/IMAGING.md`). It is not a
general-purpose FHIR resource server, not a new persistence layer, and not a certified/validated
FHIR implementation of any kind. This document says plainly what it is and is not, so a future
session (or an integration partner) never has to infer scope from route names alone.

## What this is

Four FHIR R4 resource types, each mapped from an existing internal shape close enough to map
faithfully without inventing data:

| FHIR resource      | Mapped from                              | Interactions          |
|---------------------|-------------------------------------------|------------------------|
| `Patient`           | `PatientCase` (`packages/contracts/src/index.ts`) | `read` |
| `ImagingStudy`      | `ImagingStudy` + its series (`imaging.ts`) | `read` |
| `DiagnosticReport`  | `DiagnosticReport` (`imaging.ts`)         | `read` |
| `DocumentReference` | `DocumentReference` (`imaging.ts`)        | `search-type` only (see below) |

- `GET /organizations/:organizationId/fhir/r4/metadata` — a `CapabilityStatement` that advertises
  exactly these interactions and nothing more (`server/src/fhir/capability-statement.ts`).
- `GET /organizations/:organizationId/fhir/r4/Patient/:caseId`
- `GET /organizations/:organizationId/fhir/r4/ImagingStudy/:studyId`
- `GET /organizations/:organizationId/fhir/r4/DiagnosticReport/:reportId`
- `GET /organizations/:organizationId/fhir/r4/DocumentReference?studyId=...` — a `searchset`
  `Bundle`, not a by-id read: the underlying store (`store/imaging-store.ts`) has no
  `getDocumentReference(id)`, only `listDocumentReferencesForStudy`, so that is the honest surface
  to expose rather than inventing a lookup path the data layer doesn't have.

Every response is `application/fhir+json`. Mapping logic lives in `server/src/fhir/mappers.ts` and
is pure/unit-tested (`mappers.test.ts`) independently of the routes; route wiring and authorization
enforcement are covered by `routes/fhir.integration.test.ts`.

## The architecture decisions this was built against

- **Reuse the existing IAM authorization, don't invent a parallel FHIR permission model.** A FHIR
  resource is just a different JSON *shape* of data this server already protects — never a
  different trust boundary. `GET .../Patient/:caseId` enforces `patientCase:view` with the exact
  same `conditionContext` `routes/cases.ts` uses; `GET .../ImagingStudy/:studyId` and
  `.../DiagnosticReport/:reportId` enforce `imagingStudy:view`/`diagnosticReport:view` the same way
  `routes/imaging-studies.ts`/`routes/imaging-reports.ts` do. No new IAM actions were added.
- **Identical response for absent and unauthorized**, matching every other resource in this API: a
  case/study/report that doesn't exist and one that exists but the caller can't see both return a
  404 `OperationOutcome`. The `DocumentReference` search endpoint follows the same principle in its
  own idiom — an empty `Bundle` either way, since a search endpoint returning 404 isn't meaningful
  and a non-empty-vs-empty status-code difference would itself leak existence.
- **No new persistence.** Every mapper reads from the store interfaces that already exist
  (`CaseStore`, `ImagingStore`) at request time. There is no FHIR-shaped database table, no sync
  job, no cache — a `Patient` resource is exactly as fresh as the `PatientCase` it was read from a
  moment before.

## What is deliberately NOT implemented (disclosed gaps)

- **No write API.** `POST`/`PUT`/`PATCH`/`DELETE` on any FHIR resource do not exist. Every write
  still goes through the native routes (`POST /cases`, `POST .../imaging/studies/:id/reports`,
  etc.) — FHIR is a read projection on top of them, not an alternate write path.
- **No other R4 resource types.** No `Observation`, `Condition`, `MedicationStatement`,
  `Encounter`, `Practitioner`, `Organization`, `Consent`, `AllergyIntolerance`, or anything else —
  this system has no internal model for most of these yet, and mapping to them would mean
  fabricating clinical data that was never actually captured, which is worse than not exposing the
  resource at all.
- **`Patient` has no `name` or `birthDate`.** This system has no structured field for either
  anywhere in its domain model — `PatientCase.demographics.age` is a free-text string, not a
  `birthDate`. Omitting these FHIR fields was chosen deliberately over fabricating a
  probably-wrong value; see `mappers.ts`'s own doc comment.
- **`Patient.gender` is a heuristic best-effort mapping**, not a validated coded value — sourced
  from `demographics.sex`, a free-text field this system never constrained at entry time. See
  `mapSexToFhirGender` in `mappers.ts` for the exact (small, disclosed) mapping table.
- **No search beyond the one `DocumentReference?studyId=` case.** No `_include`, `_revinclude`,
  chained search, `Patient?identifier=`, or any other FHIR search parameter grammar. Every other
  resource is by-id `read` only.
- **No resource versioning / `vread` / `_history`.** `Meta.lastUpdated` is populated; `Meta.versionId`
  is not, and there is no `/History` interaction.
- **SMART App Launch is partially implemented — discovery + scope/launch-context enforcement
  only, no launch redirect flow.** `GET .../fhir/r4/.well-known/smart-configuration`
  (`server/src/fhir/smart-configuration.ts`) republishes the external IdP's own
  `authorization_endpoint`/`token_endpoint` (resolved once at startup via
  `resolveAuthorizationServerMetadata` in `auth/oidc-verifier.ts` — this server is a SMART
  *resource server*, never its own authorization server, matching the standing "delegate auth
  entirely to an external IdP" decision). When a verified bearer token carries a `patient/*.read`
  -shaped SMART scope **and** a `patient` launch-context claim, every FHIR read route
  (`server/src/fhir/smart-scopes.ts`'s `resolveSmartLaunchContext`/`deniedBySmartLaunchContext`)
  additionally confines that caller to the one patient named by the claim — denied identically
  (404) to absent/unauthorized. A plain OIDC token with no SMART scope is completely unaffected;
  existing IAM authorization remains the only gate for it, unchanged. **Not implemented**: this
  server has no EHR-launch redirect endpoint (`GET .../launch?iss=&launch=`), no standalone-launch
  initiation, no PKCE enforcement (it issues no tokens itself), no dynamic client registration, and
  does not itself validate that a scope was actually granted by the IdP for this specific
  client/purpose beyond trusting the token's signature — same trust already placed in every other
  claim on an accepted token. **This is the resource-server side only.** The complementary
  client-role capability — this server launching *into* an external EHR's own FHIR API as a SMART
  client (authorization_code + PKCE, token storage, no redirect-flow initiation gap) — is a
  separate, independent feature; see [docs/SMART_LAUNCH.md](SMART_LAUNCH.md).
- **No terminology validation.** `Coding.system`/`code` values (e.g. the DICOM modality codes on
  `ImagingStudy`) are passed through from what this system already stores; nothing here validates
  them against an actual DICOM/SNOMED/LOINC code system.
- **Not validated against a FHIR conformance test suite** (e.g. Touchstone, Inferno) and makes no
  claim of US Core, IPS, or any other FHIR implementation guide conformance — it is a plain R4
  JSON shape only.
## Extending this

Adding a new mapped resource type means: a schema in `packages/contracts/src/fhir.ts`, a pure
`toFhirX` mapper in `server/src/fhir/mappers.ts` with its own unit tests, a route in
`routes/fhir.ts` that reuses the *existing* IAM action for that underlying resource (never a new
one), an entry in `capability-statement.ts`'s advertised interactions, and an integration test.
Resist adding a resource type for data this system doesn't actually have a real field for yet —
follow the `Patient.name`/`birthDate` precedent above and simply omit the field, or don't add the
resource until the underlying data exists.
