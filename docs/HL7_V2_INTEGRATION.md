# HL7 v2 Integration

`server/src/hl7/` implements a from-scratch HL7 v2.x message parser/builder and one concrete
outbound message type (ORU^R01), exposed at
`GET /organizations/:organizationId/hl7/v2/DiagnosticReport/:reportId/oru-r01`
(`server/src/routes/hl7.ts`). This document says plainly what that is and is not, matching
[docs/FHIR_INTEGRATION.md](FHIR_INTEGRATION.md)'s own convention for this codebase's other
external-standard facade.

## What this is

- **`server/src/hl7/message.ts`** — a generic HL7 v2 ER7 ("pipe-and-hat") parser and builder:
  `parseHl7Message`/`buildHl7Message` (segments and fields; MSH's own encoding-character
  declaration — component `^`, repetition `~`, escape `\`, subcomponent `&` — is read from the
  message itself, never hardcoded), `getField`/`buildSegment` (1-indexed field access matching
  HL7's own numbering, e.g. `getField(msh, 9)` for MSH-9), `splitComponents`/`splitRepetitions`/
  `splitSubcomponents` (decompose a field further only where a caller needs to), and
  `escapeHl7Text`/`unescapeHl7Text` (the standard `\F\`/`\S\`/`\T\`/`\R\`/`\E\` delimiter-escaping
  mechanism, so real data containing `|`/`^`/`&`/`~`/`\` never corrupts message structure).
- **`server/src/hl7/oru-builder.ts`** — `buildOruR01`, mapping this system's own
  `DiagnosticReport`/`ImagingStudy` to a real, well-formed HL7 v2.5.1 ORU^R01 (unsolicited
  observation result) message: MSH (header) / PID (patient identification) / OBR (the report) /
  OBX (conclusion, conclusion code, critical flag). This is the direct HL7 v2 analog of
  `server/src/fhir/mappers.ts`'s `toFhirDiagnosticReport` — same source data, same disclosed
  limitations (see below), different wire format.
- **`server/src/hl7/inbound-parser.ts`** — `parseOruR01`: parses a raw inbound ORU^R01 message into
  `{messageControlId, patientIdentifier?, observations}`, where each observation is a real
  `LabResult`-shaped object (name/value/unit/referenceRange/observedAt, read from OBX-3/5/6/7/14).
- **`server/src/hl7/adt-parser.ts`** — `parseAdtMessage`: parses any ADT trigger event (A01/A04/A08/
  A28/...) into `{messageControlId, triggerEvent, patientIdentifier?}` uniformly, since every trigger
  event shares the same PID-based identity payload this codebase actually uses.
- **`server/src/hl7/ack-builder.ts`** — `buildAck`: the standard HL7 v2 general-acknowledgment
  response (MSH + MSA) a real receiver sends back for every message — used by `mllp-server.ts` below,
  and available to any other transport.
- **`server/src/hl7/ingestion.ts`** — `ingestInboundMessage`/`resolveIngestionJob`: the shared match/
  apply pipeline both the HTTP route and the MLLP listener call into. Detects ORU vs. ADT via MSH-9,
  matches the patient by exact equality against a case's own `patientId ?? id` (no fuzzy matching —
  the same "ambiguous or absent match always requires human review, never a guess" discipline
  imaging's own DICOM patient matching uses, `docs/IMAGING.md`), and only for an **unambiguous single
  match** applies it: an ORU's observations merge into that case's `labResults`; an ADT has no case
  field of its own to update once matched, so "applying" it just records the job — the audit trail of
  "this visit event was received and recognized." Every other outcome (no match, 2+ matches, or an
  applied-ORU hitting a concurrency conflict twice) creates a `pending-review` `Hl7IngestionJob` row
  (`packages/contracts/src/hl7.ts`) and touches no case data; `resolveIngestionJob` lets a reviewer
  apply it to a specific case (which, for an ambiguous job, must be one of the job's own recorded
  candidates — never an arbitrary id) or reject it with a reason.
- Five HTTP routes in `routes/hl7.ts`. The outbound one (`GET .../DiagnosticReport/:reportId/oru-r01`)
  reuses this codebase's *existing* IAM authorization exactly the way `routes/fhir.ts` does —
  `imagingStudy:view`/`diagnosticReport:view`, no new HL7-specific permission, identical 404 for
  absent and unauthorized. The inbound ones (`POST .../inbound/oru-r01/parse`, `POST
  .../inbound/ingest`, `GET .../inbound/jobs`, `POST .../inbound/jobs/:jobId/resolve`) have no single
  case/patient resource to reuse an existing action from — parsing is a stateless format conversion,
  ingestion matches across every case in the tenant — so they're gated by new `hl7:parseInbound`/
  `hl7:ingest`/`hl7:reviewIngestion` actions instead (403, not a disclosing 404, since there's no one
  resource to hide the existence of). A structurally invalid message returns 422, never a 500.
- **`server/src/hl7/mllp-server.ts`** — an opt-in MLLP (Minimal Lower Layer Protocol) TCP listener
  bound to exactly one pre-configured organization, feeding every received message into the same
  `ingestInboundMessage` pipeline above and replying with a real ACK/NACK. See "MLLP transport"
  below for its trust model and bounds.

## MLLP transport

`server/src/hl7/mllp-server.ts` is a real MLLP (Minimal Lower Layer Protocol) TCP listener —
`<VT>message<FS><CR>` framing, the transport almost every real HL7 v2 sender (a lab system, an
EHR interface engine) speaks. It is **off by default** and only starts when every one of
`HL7_MLLP_PORT`/`HL7_MLLP_ORGANIZATION_ID` is explicitly configured (`config.ts`'s `hl7Mllp`);
`HL7_MLLP_HOST` defaults to `127.0.0.1` (loopback-only) and must be explicitly widened.

**Trust model — read this before enabling it.** A raw TCP connection carries no bearer token, no
OIDC identity, nothing this codebase's IAM layer can check — HL7 v2/MLLP predates OAuth and is
conventionally trusted at the network layer instead (a private network segment, a VPN, an IP
allowlist, or mutual TLS the deployment's own infrastructure terminates — this module speaks plain
TCP with no TLS of its own). Consequently: **one listener serves exactly one pre-configured
organization** (`HL7_MLLP_ORGANIZATION_ID`) — there is no per-message routing to a tenant, since
there is no per-message identity to route by. A deployment integrating with more than one lab feed
needs more than one listener (a future generalization, not attempted here). Every message this
listener processes is attributed to a synthetic `system:hl7-mllp` audit actor, the same
`"system:<job-name>"` convention already used elsewhere in this codebase for automated action.

Every received message is fed into the same `ingestInboundMessage` pipeline the HTTP `POST
.../inbound/ingest` route uses, and replied to with a real ACK (`AA`) or NACK (`AE`/`AR`, via
`ack-builder.ts`) — `hl7/mllp-handler.ts` is the specific wiring, and is careful to never let a raw
internal error's text (which could carry connection strings or stack detail) reach the wire; only
an `Hl7ParseError`'s own already-safe message is ever quoted back.

DoS-conscious by construction: a bounded per-connection buffer (`maxMessageBytes`, default 1 MiB —
a sender that never completes a frame is disconnected, not accumulated forever), a per-connection
idle timeout (default 30s), and a cap on concurrent connections (default 50) — all overridable, none
unbounded by default.

**Not implemented**: TLS (the deployment's own network/proxy layer is expected to provide it if
needed — see the trust-model paragraph above), retry/redelivery semantics beyond MLLP's own
one-ACK-per-message, and multi-tenant routing (one listener, one organization, by design).

## What is deliberately NOT implemented (disclosed gaps)

- **Only ORU^R01 and ADT (any trigger event) are recognized.** No ORM (order), no other HL7 v2
  message type, inbound or outbound. Adding an outbound one means a new `*-builder.ts` file
  following `oru-builder.ts`'s own pattern; an inbound one means a new `*-parser.ts` file following
  `adt-parser.ts`'s, plus teaching `ingestion.ts`'s message-type detection about it.
- **Ingestion patient matching has no issuer concept.** Exact string equality against
  `PatientCase.patientId ?? id` only — `PatientCase` has no `(issuer, value)` pair the way imaging's
  `ImagingPatientIdentifier` does, so PID-3's own assigning-authority component (component 4) is
  read and stored on the job record for a reviewer's reference, but never used to disambiguate a
  match. A real, disclosed limitation of this system's domain model, not an oversight.
- **PID has no name or birth date** — same reasoning and same gap as `fhir/mappers.ts`'s
  `toFhirPatient`: this system's domain model has no structured field for either anywhere, so PID-5
  and PID-7 are left empty rather than fabricated.
- **OBR-4 (universal service identifier) is a local, uncoded text description**
  (`DX-REPORT^Diagnostic imaging report`), not a LOINC/CPT/local code — this system has no real
  terminology binding to draw one from, matching `fhir/mappers.ts`'s own `code.text`-only
  `CodeableConcept` for the same report.
- **Not validated against any receiving system's implementation guide, and not conformance-tested
  against a real HL7 v2 interface engine or EHR.** Real HL7 v2 integrations are conformance-tested
  per trading partner (every EHR vendor's HL7 v2 interface has its own quirks/extensions on top of
  the base standard) — this produces a spec-well-formed message, not a claim that any specific
  partner will accept it as-is.
- **`RESULT_STATUS`'s mapping from this system's `DiagnosticReport.status` to HL7 v2's result-
  status table (0085) is a best-effort nearest match**, not a one-to-one standard mapping — most
  notably `entered-in-error` maps to `W` ("wrong patient/wrong test," the nearest documented
  withdrawal reason in that table), since HL7 v2 has no generic "entered in error" code. See
  `oru-builder.ts`'s own `RESULT_STATUS` map for the complete, exact mapping.

## UI

`app/src/hl7-client.ts` (REST glue) + IPC handlers `hl7:listJobs`/`hl7:resolveJob`
(`ipc/shared-backend-handlers.ts`, exposed via `preload.ts`) back
`frontend/src/pages/Hl7Inbox.tsx` (nav: "HL7 Inbox") — an org-wide queue of ingestion jobs, filtered
by status (defaults to `pending-review`). Each job shows its message type, patient identifier, raw
message (collapsible), and match/apply status; a pending-review job gets resolve controls shaped by
its own `matchStatus`: an **ambiguous** match offers one button per `candidateCaseIds` entry (never
a free-text field — the same "must be one of the job's own recorded candidates" constraint
`ingestion.ts` enforces server-side is mirrored here, not just relied on as a backstop); a
**no-match** job needs a case id typed in, since there is nothing to choose from; **reject** always
requires a short reason, recorded on the job for the audit trail via `rejectionReason`.

## Extending this

A new outbound message type follows `oru-builder.ts`'s own shape: build each segment with
`buildSegment(id, {fieldNumber: value})`, escape any free-text field value with `escapeHl7Text`
before placing it, assemble the segment array in the message's own defined order, and serialize
with `buildHl7Message`. Give it its own test file proving round-trip parseability and correct field
placement, following `oru-builder.test.ts`'s own pattern — never assume a hand-built segment is
correct without parsing the built output back and checking specific field values.
