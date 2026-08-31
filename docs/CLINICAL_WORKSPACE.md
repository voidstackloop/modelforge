# Clinical workspace (ModelForge Medical)

This document is the detailed reference for everything specific to **ModelForge
Medical** — the clinical layer built on top of the general-purpose Modelforge
chat/agent client. If you're looking for how the underlying Electron app is put
together, start with [Architecture](ARCHITECTURE.md); for the generic tool-calling
system, [Agent mode](AGENT_MODE.md). This document assumes both as background and
covers only what's specific to the clinical workspace: Patient Cases, Evidence
Library, Knowledge Graph, Clinical Assistant's safety layer, Audit & Privacy
(including encryption and session locking), and the MCP integrations built for
medical use (Graphify, BioMCP, DICOM MCP) plus the client rework that preceded them.

## Contents

- [Product boundary](#product-boundary)
- [Navigation map](#navigation-map)
- [Clinical Assistant](#clinical-assistant)
- [Patient Cases](#patient-cases)
- [Evidence Library](#evidence-library)
- [Knowledge Graph](#knowledge-graph)
- [Audit & Privacy](#audit--privacy)
- [Encryption at rest](#encryption-at-rest)
- [Automatic session locking](#automatic-session-locking)
- [Medical MCP integrations](#medical-mcp-integrations)
- [MCP client architecture](#mcp-client-architecture)
- [Data model reference](#data-model-reference)
- [IPC surface reference](#ipc-surface-reference)
- [File storage layout](#file-storage-layout)
- [Testing this layer](#testing-this-layer)
- [Known limitations](#known-limitations)

## Product boundary

ModelForge Medical is a **clinical decision-support, medical research, and
documentation assistant** for physicians, clinical staff, medical researchers, and
medical students. It is deliberately **not**:

- An autonomous diagnostician — every clinically relevant answer is structured as
  "possible interpretations," never a single settled diagnosis, and every
  model-generated message carries a **"Not verified"** badge (`frontend/src/pages/Chat.tsx`,
  the `MessageBubble` component).
- A prescriber — the app places no orders and submits nothing on a clinician's
  behalf; every tool call (built-in or MCP) still requires per-call human approval.
  See [Agent mode](AGENT_MODE.md) for that approval model in full.
- A certified HIPAA/HITRUST/FDA-compliant system. Local-first storage, an audit
  trail, encryption at rest, and session locking are real privacy *controls* —
  none of them are a compliance *certification*. See [Known limitations](#known-limitations).

## Navigation map

The sidebar's **Clinical** group (`frontend/src/components/layout.tsx`) adds four
routes on top of the base app's Chat/Settings/Compare/etc.:

| Route | Page | Purpose |
|---|---|---|
| `/cases` | `pages/PatientCases.tsx` | List, create, delete patient cases |
| `/cases/:caseId` | `pages/PatientCaseDetail.tsx` | Structured case fields, per-field context selection, conflict warnings |
| `/evidence` | `pages/EvidenceLibrary.tsx` | Add-by-URL evidence source library |
| `/knowledge-graph` | `pages/KnowledgeGraph.tsx` | Per-case concept graph (conditions/allergies/medications) |
| `/audit` | `pages/AuditPrivacy.tsx` | Audit trail, encryption management, session-lock settings, retention |

Clinical Assistant itself is the existing `/` and `/chat/:sessionId` routes
(`pages/Chat.tsx`) — it wasn't given a new route, only a safety layer layered on top
(below).

## Clinical Assistant

### Structured response contract

Every message sent from Clinical Assistant carries a system-prompt addendum,
`CLINICAL_RESPONSE_CONTRACT` (`frontend/src/pages/Chat.tsx`), requiring exactly
eight sections in order whenever the answer is clinically relevant:

1. Summary
2. Known patient facts
3. Assessment or possible interpretations
4. Missing information
5. Red flags and urgent concerns
6. Suggested next clinical steps
7. Evidence and citations
8. Uncertainty and limitations

This is a *prompt*, not a guarantee — a model can still fail to follow it. That's
why the safety-critical pieces below (emergency detection, drug-conflict warnings)
run as plain code, independent of anything the model says.

A deterministic, non-model check backs this specific guarantee too:
`checkResponseContractCompliance` (`frontend/src/lib/clinical-constants.ts`, built
from the same `RESPONSE_CONTRACT_SECTION_HEADINGS` array used to construct the
prompt text above, so the two can never drift apart) inspects a completed
assistant message for the eight required headings. If the response clearly
attempted the structured format (at least one heading present) but silently
dropped one or more of the rest, `ResponseContractNotice` (`Chat.tsx`) renders a
warning naming exactly which sections are missing. A short, non-clinical reply
with no headings at all is left alone — it never claimed to follow the contract,
so flagging it would be noise, not signal. Runs entirely client-side (plain string
matching, no IPC) since it only needs the constant it's defined next to.

### Clinical modes

A dropdown in the composer toolbar (`CLINICAL_MODES` in `Chat.tsx`) prepends a
mode-specific instruction on top of the response contract:

| Key | Label | Instruction focus |
|---|---|---|
| `none` | General | No addition (default) |
| `soap` | SOAP note | Subjective/Objective/Assessment/Plan |
| `differential` | Differential diagnosis support | Ranked possible interpretations, not a single diagnosis |
| `medicationReview` | Medication review | Interactions, duplication, dosing concerns |
| `dischargeSummary` | Discharge summary | — |
| `patientEducation` | Patient education | Plain-language, no unexplained jargon |
| `researchReview` | Research/literature review | Summarize literature/guidelines, cite sources |

### Emergency red-flag detection

`app/src/medical-safety.ts`'s `checkForEmergencyFlags(text)` scans the **user's own
message** — before any model call — for plain-language emergency phrasing:
difficulty breathing, stroke symptoms (facial droop, slurred speech, sudden
weakness/numbness), severe chest pain, anaphylaxis, major bleeding, loss of
consciousness, active self-harm risk, overdose. A match sets `emergencyFlags` state
in `Chat.tsx`, rendering a persistent, dismissible banner
(`EMERGENCY_BANNER_TEXT`) telling the user to contact emergency services — this
banner's appearance **never depends on, or waits for, a model response**; it's
computed and shown before the message is even sent to a model. Reached via
IPC `medicalSafety:checkEmergency` (deterministic regex matching, no model call —
see [`medical-safety.test.ts`](../app/src/medical-safety.test.ts) for the exact
pattern list and what does/doesn't trigger it).

### Allergy / medication conflict warnings

`checkMedicationConflicts(allergies, medications)` in the same file runs
deterministic keyword/synonym matching against a Patient Case's recorded allergies
and medications, behind a swappable `MedicationSafetyProvider` seam (built-in
seed-list provider by default):

- **Allergy matches**: a small synonym table (`ALLERGY_CLASS_SYNONYMS`) maps common
  allergy classes (penicillin, sulfa, NSAID) to their member drug names.
- **Known interaction pairs**: a small demonstration list (`KNOWN_INTERACTIONS`,
  e.g. warfarin+aspirin, MAOI+SSRI, sildenafil+nitrate) — explicitly **not** a
  licensed clinical drug-interaction database (First Databank, Lexicomp, Multum).

The check returns a structured `MedicationSafetyResult` (provider identity,
`status` — `"demonstration"` / `"clinically-authoritative"` / `"unavailable"` /
`"failed"` — a timestamp, the warnings, and static limitations text), not a bare
warnings array, so a zero-length result can never be conflated with "verified
safe." `PatientCaseDetail.tsx` renders four distinct states from it: matches
found (clinician-review banner, labeled with the provider and its limitations),
checked with no matches ("No matches found by \<provider\>; this is not a
clinical interaction check"), unavailable/failed (explicit failure banner, never
collapsing to a clean result), and not applicable (no allergies or medications
recorded yet). Reached via IPC `patientCases:checkConflicts`, validated against
`medicationConflictCheckInputSchema` at the IPC boundary.

### Transmission preview before a remote send

Sending to a remote provider (anything not in `LOCAL_PROVIDERS` — i.e. not
in-process llama.cpp or a managed local MLX/ROCm/vLLM runtime) while a patient case is attached or
files are attached triggers a native `confirm()` dialog listing exactly what's
about to leave the device and to which provider, **before** the request fires
(`handleSend` in `Chat.tsx`). Declining aborts the send entirely — nothing is sent
silently.

### PHI redaction (opt-in)

A checkbox in the composer ("Redact identifiers before sending"), shown only when
the selected model is a remote provider, runs `medicalSafety.redact(content)`
(`redactIdentifiers` — regex patterns for email, phone, SSN, MRN, DOB) on the fully
assembled outgoing content **before** the transmission-preview dialog, so the
confirmation the user sees already reflects the redacted text and the redaction
count. Off by default — this is pattern-based scrubbing, not clinical-grade
de-identification (HIPAA Safe Harbor requires far more: free-text narrative
mentions of names, locations, rare ages, device identifiers, etc., none of which
regex can reliably catch).

### Untrusted-content framing

Attached files and RAG-retrieved content are wrapped with an explicit
`UNTRUSTED_CONTENT_PREAMBLE` (`Chat.tsx`, `buildMessageContent`) telling the model
this is reference material to inform its answer, never an instruction to follow —
a mitigation (not an elimination) of prompt injection via an imported clinical
document. Patient-case field content is **not** wrapped this way, since it's
clinician-typed, trusted input, not imported/untrusted content.

### Case attachment and context selection

A dropdown in the composer lets the user attach one Patient Case to the current
message. Only the fields the user has explicitly marked `includeInContext: true`
on that case (see [Patient Cases](#patient-cases)) are pulled in — via
`patientCases:buildContext` — and prefixed as `Patient case context
(clinician-entered, fields explicitly included by the user):` ahead of the user's
own message text.

## Patient Cases

`app/src/patient-cases-store.ts` + `app/src/schemas.ts` (`patientCaseSchema`).

### Structured fields

Every clinical field on a `PatientCase` is a `CaseField<T> = { value: T;
includeInContext: boolean }` — the `includeInContext` flag is what the "user
controls exactly which fields are sent" requirement is actually built on; nothing
is included in a model prompt unless that flag is explicitly `true`, and it
defaults to `false` on every new case and every new field.

| Field | Type | Notes |
|---|---|---|
| `demographics` | `CaseField<{age?, sex?, notes?}>` | |
| `presentingComplaint` | `CaseField<string>` | |
| `symptomsTimeline` | `CaseField<string>` | |
| `vitalSigns` | `CaseField<string>` | Free text, e.g. `"BP 122/78, HR 76, RR 16, Temp 37.0°C, SpO2 98%"` |
| `conditions` | `CaseField<string[]>` | |
| `allergies` | `CaseField<string[]>` | Feeds the conflict checker |
| `medications` | `CaseField<string[]>` | Feeds the conflict checker |
| `labResults` | `CaseField<LabResult[]>` | `{id, name, value, unit?, referenceRange?, observedAt?}` |
| `imagingAndReports` | `CaseField<string>` | |
| `clinicalNotes` | `ClinicalNote[]` | `{id, author: "clinician" \| "model-inference", text, createdAt}` — provenance-tagged, never blended |
| `attachments` | `AttachmentRef[]` | `{id, name, mimeType?, addedAt}` |
| `consentNote`, `enteredBy` | `string?` | Plain text — no verified-identity system behind `enteredBy` (see [Known limitations](#known-limitations)) |

### Persistence backend (configuration boundary)

Every business-logic function (`createCase`, `updateCase`, `grantConsent`, `addClinicalNote`,
etc.) reads/writes through `getPatientCasesBackend()` rather than a concrete storage
implementation — a `PatientCasesBackend` interface (`{ name, label, scope: "local" |
"shared", limitations, isAvailable?, readAll, writeAll }`) a real deployment could
register a second implementation behind (Settings → Audit & Privacy → "Patient case
storage backend"), the same registry/select/fail-safe-fallback shape as
`medical-safety.ts`'s `MedicationSafetyProvider`. Only `localPatientCasesBackend` —
this file's own encryption-aware local JSON store — is registered today; there is no
networked client, auth/identity, or credential handling anywhere in this codebase.
`getAllCasesForMigration()` / `overwriteAllCases()` (used by the encryption
setup/disable/rotate-passphrase flows) deliberately always operate on the local file
regardless of which backend is active — at-rest encryption is a local-storage concern
a shared backend would handle its own way, not something this migration path applies
to a backend it knows nothing about.

### Case isolation

Every read goes through `getCase(id)` / `listCases()`, which never does a raw array
index or unfiltered scan — a caller can only ever get back the one case it asked
for. This is the actual guarantee behind "one patient's data never leaks into
another case's context." See `patient-cases-store.test.ts`'s "isolates cases from
one another" test.

### `buildContextForCase`

The single choke point that assembles a model-prompt-ready text block: iterates
every field, includes a line only if `includeInContext` is true and the field is
non-empty, and returns both the text and the list of included field labels (so the
transmission preview can show exactly what was included in plain language, not
just a raw diff).

## Evidence Library

`app/src/evidence-store.ts` + `app/src/schemas.ts` (`evidenceSourceSchema`).

Add-by-URL only — deliberately, to avoid presenting unreviewed live search results
as vetted medical evidence. `addSourceFromUrl(url)`:

1. Validates the URL is `http(s)://` (rejects anything else, e.g. `file://`).
2. Fetches the page (15s timeout) and extracts only what it can honestly find: the
   `<title>` tag and a `<meta name="description">` tag. **Never fabricates** a
   title, author, or date it couldn't find — a missing title falls back to the
   URL's path, never an invented string.
3. Guesses `organization` and `sourceType` (`peer-reviewed` / `guideline` /
   `reference-database` / `other`) from a small table of known domains
   (`KNOWN_ORGANIZATIONS`: PubMed/NCBI, NIH, WHO, CDC, FDA, Cochrane, UpToDate) —
   this is a UI convenience default, not a claim that every page on that domain is
   peer-reviewed.

Sources added here are what `checkCitations` (`medical-safety.ts`) can cross-check
a model's inline citation markers (`[1]`, `(Smith, 2020)`) against — a marker with
no matching known source is flagged as unverified rather than trusted at face
value. (This citation-checking function exists and is tested; it is not yet wired
into Clinical Assistant's message rendering — see [Known limitations](#known-limitations).)

## Knowledge Graph

`frontend/src/pages/KnowledgeGraph.tsx` — intentionally simple and honest about
what it is: a **per-case concept graph**, not a medical knowledge base. Nodes are
built directly from a case's `conditions` / `allergies` / `medications` fields
(rendered via the existing Mermaid diagram support), with every node's provenance
listed in a table below the diagram (which case field it came from). No
UMLS/SNOMED/RxNorm linkage, no inferred relationships — it shows only what's
directly on the case.

For anything richer (building a real knowledge graph from a folder of documents,
papers, or imaging reports, and letting Clinical Assistant query/path/explain it),
the page links to connecting **Graphify** as an MCP server — see
[Medical MCP integrations](#medical-mcp-integrations).

## Audit & Privacy

`app/src/audit-log-store.ts` + `app/src/schemas.ts` (`auditEventSchema`),
UI at `frontend/src/pages/AuditPrivacy.tsx`.

### What's logged

Every `AuditEvent` has `id`, `timestamp`, `actionCategory`, and optional
`targetType` / `targetId` / `detail`. The categories:

| Category | Recorded when |
|---|---|
| `case-created` / `case-updated` / `case-deleted` / `case-viewed` | Patient Cases CRUD (`patient-cases-handlers.ts`) |
| `model-call-local` / `model-call-remote` | Every chat send, split by whether the provider is local or remote |
| `mcp-tool-call` | Every MCP tool call — approved, auto-approved, or denied (see below) |
| `export` / `data-deleted` / `settings-changed` | Data export, deletions, and settings changes such as enabling encryption |

`mcp-tool-call` events additionally carry `mcpServerId`, `mcpServerName`,
`mcpToolName`, `approvalOutcome` (`"approved" | "auto-approved" | "denied"`), and
`durationMs` — recorded from `Chat.tsx`'s `respondToToolCall`, which measures wall
time around the tool execution and calls `window.api.audit.record(...)` regardless
of whether the call was approved, auto-approved (via a trust profile — see
[MCP client architecture](#mcp-client-architecture)), or denied.

### What's deliberately never logged

**No field on `AuditEvent` carries a tool call's actual arguments or result.**
`detail` is documented as "short, non-clinical" and callers are responsible for
keeping it that way — the store itself doesn't (and structurally can't) inspect it
for clinical content, but nothing in the codebase puts clinical narrative into it.
This is a deliberate design constraint: the audit trail's whole purpose is
accountability (who did what, when, was it approved), and turning it into a second
place PHI could leak from would defeat that purpose.

### Retention

Settings → Audit & Privacy offers **30 days / 90 days / 1 year / forever**
(`AppSettings.auditLogRetentionDays`). Purging happens both on write (`recordEvent`)
and on read (`listEvents`), so lowering the retention window takes effect
immediately rather than waiting for the next recorded event. This sits on top of a
fixed `MAX_EVENTS = 5000` hard cap that always applies regardless of the
age-based setting.

## Encryption at rest

`app/src/case-encryption.ts`, IPC in `app/src/ipc/encryption-handlers.ts`, UI in
`AuditPrivacy.tsx`'s `EncryptionSection`.

### Threat model

Protects every store that can hold real clinical detail against **someone with
filesystem access but not the passphrase**: a stolen laptop that's powered off, a
backup tool, a synced folder. It does **not** protect against an attacker with
control of the running, unlocked app — that's narrowed by
[session locking](#automatic-session-locking), not eliminated by it.

**Covered stores** — one passphrase, one enabled/unlocked state, one "Enable
encryption" toggle for all three:

| Store | What's encrypted |
|---|---|
| `patient-cases.json` (`patient-cases-store.ts`) | The whole file (allergies, medications, conditions, notes) |
| `sessions.json` (`sessions-store.ts`) | The whole file — chat messages routinely carry the same clinical detail typed or pasted in |
| `rag.db` (`rag-db.ts`) | Per-column: `chunks.text`, `chunks.heading`, `documents.name`, `collections.name` |

**Deliberate exceptions in `rag.db`**, documented in `rag-db.ts` rather than left
implicit: `documents.path` / `collections.folder_path` stay plaintext because both
are SQL equality-lookup and uniqueness keys — AES-GCM's random IV makes identical
plaintext encrypt differently every time, which breaks exact-match lookups entirely
without a separate deterministic/blind-index scheme; a filename is a real but
materially smaller leak than the full extracted text of the document. `chunks.embedding`
stays plaintext because it isn't human-readable and similarity search must compute
against it directly — encrypting it would mean decrypting every row on every query
for no confidentiality gain.

**Not covered**: exported files (`data-transfer.ts`) are plaintext by construction —
encrypting every store and then exporting undoes that protection at the point of
export. Evidence sources (public reference URLs, not patient-specific) and the audit
log (deliberately carries no clinical content — see `audit-log-store.ts`) are out of
scope by design.

### How it works

- **AES-256-GCM**, key derived from a user passphrase via `crypto.scryptSync`
  with a random 16-byte salt.
- The **passphrase itself is never stored anywhere, in any form.** Only the salt
  (safe to store — its job is defeating rainbow tables, not being secret) and a
  **verifier** — an HMAC of a fixed message, computed with the derived key —
  persist to `case-encryption-config.json`. A passphrase check is "derive the key,
  recompute the HMAC, compare to the stored verifier" — the passphrase is compared
  to nothing; only its *derived key's fingerprint* is.
- The derived key lives **only in main-process memory**, only while the session
  considers itself unlocked. Nothing persists it across an app restart — every
  fresh launch starts locked if encryption is enabled.
- **Two physical files**, never both authoritative at once: `patient-cases.json`
  (plaintext) and `patient-cases.enc.json` (an envelope of `{ivHex,
  ciphertextHex, authTagHex}`). Switching modes always deletes the now-stale file
  — enabling encryption deletes the plaintext copy after the encrypted one is
  written; disabling does the reverse. Stale plaintext is never left lying around
  next to a freshly-encrypted copy, or vice versa.

### Flows (all in `encryption-handlers.ts`, orchestrating `case-encryption.ts` + `patient-cases-store.ts` + `sessions-store.ts` + `rag-db.ts`)

Every flow below reads **all three** covered stores under the old mode/key, changes
the key/mode, then writes all three back under the new one — so enabling, disabling,
or rotating always moves patient cases, chat sessions, and RAG content together and
can never leave them in mixed states.

| Action | What happens |
|---|---|
| **Setup** | Read existing (plaintext) cases + sessions + RAG content → `caseEncryption.setup(passphrase)` (new salt/key/verifier, unlocks) → re-write all three (now encrypted) → audit `settings-changed` |
| **Unlock** | Derive key from stored salt, compare verifier — no state change to any store |
| **Lock** | Clear the in-memory key only — files untouched, unreadable again until unlock |
| **Disable** | Verify passphrase (which also unlocks) → read all three (decrypts with current key) → clear encryption config → re-write all three (now plaintext) → audit |
| **Change passphrase** | Verify old passphrase → read all three (decrypts with *old* key) → rotate to new salt/key/verifier → re-write all three (encrypts with *new* key) → audit |

`rag-db.ts`'s `getAllContentForMigration()`/`overwriteAllContent()` touch only the
encrypted content columns — never embeddings — so changing encryption state never
requires re-embedding anything.

Reading or writing any covered store while encryption is enabled but locked throws
`CaseDataLockedError` rather than silently returning an empty list — an empty case
list and "you haven't unlocked it" must never look the same to a caller.
`PatientCases.tsx` / `PatientCaseDetail.tsx` check `encryption:status` before
listing/loading and render a `<CaseLockScreen>` passphrase prompt instead of case
content whenever locked. For RAG, `Chat.tsx` aborts a send whose attached-folder
query fails (rather than silently sending without the context the user attached) and
`Settings.tsx` distinguishes "case data is locked" from "no folders indexed yet".

## Automatic session locking

`frontend/src/lib/use-case-auto-lock.ts` (DOM/timer wiring, mounted once in
`layout.tsx`) + `frontend/src/lib/case-auto-lock.ts` (pure decision logic,
unit-tested separately from the timer wiring).

- Configurable timeout in Settings → Audit & Privacy: Never / 5 / 15 (default) /
  30 / 60 minutes (`AppSettings.caseAutoLockMinutes`).
- Implemented as **polling against wall-clock time since last activity** (checked
  every 30s) rather than one long `setTimeout`, specifically because a laptop
  sleep/wake cycle doesn't reliably advance a suspended `setTimeout` delay across
  platforms — polling against `Date.now()` is self-correcting regardless of
  suspend/resume.
- Listens for `mousemove` / `mousedown` / `keydown` / `touchstart` / `scroll` /
  `wheel` to reset the "last activity" timestamp.
- A no-op whenever encryption isn't enabled (nothing to poll for) — re-checks its
  config whenever a custom `modelforge:encryption-status-changed` event fires
  (dispatched by `AuditPrivacy.tsx` after any encryption-state-changing action),
  so turning encryption on mid-session arms the timer without requiring an app
  restart.
- On firing: calls `encryption:lock`, then dispatches `modelforge:case-locked` —
  `PatientCases.tsx` / `PatientCaseDetail.tsx` listen for this and immediately
  swap to the lock screen if the user is already on one of those pages when
  auto-lock fires, rather than only discovering it on next navigation.

This locks **case data specifically**, not the whole application — chat history,
Settings, and every other page remain reachable. There is no separate whole-app
lock independent of case encryption; see [Known limitations](#known-limitations).

## Medical MCP integrations

Settings → MCP Servers offers one-click **quick-add presets**
(`frontend/src/lib/mcp-presets.ts`) for three MCP servers, each verified against
its own upstream documentation before being hardcoded — none of the command
strings or tool names below are guessed.

| Preset | Command | What it gives the model |
|---|---|---|
| **[Graphify](https://github.com/graphify-ai/graphify)** | `graphify <path-to-folder> --mcp` | query/path/explain over a folder of documents/papers/case attachments — this project's own knowledge-graph tool, confirmed via `.claude/skills/graphify/SKILL.md`'s documented `--mcp` flag |
| **[BioMCP](https://github.com/genomoncology/biomcp)** | `biomcp serve` | PubMed, ClinicalTrials.gov, MyVariant.info — public databases, no API key |
| **[DICOM MCP](https://github.com/ChristianHinge/dicom-mcp)** | `uvx dicom-mcp <path-to-config.yaml>` | Connection verification, study/series/patient/instance metadata queries, report-text extraction — scoped, see below |

All three require their own CLI installed first — the quick-add button only
*prefills* the command into the existing manual "Add MCP server" form (filling in
any `<placeholder>`, e.g. a folder path, is left to the user); it never installs or
connects anything without an explicit review-and-click step.

### DICOM MCP scoping

The upstream `dicom-mcp` server's own tool catalog includes `move_series` and
`move_study` (DICOM C-MOVE — transfers studies between nodes). ModelForge Medical
hard-blocks both via `McpServerConfig.blockedTools`, enforced in **two places**:

1. `filterBlockedTools()` (`app/src/mcp-client.ts`) removes any blocked tool name
   from the connection's tool list at connect time, before it's ever returned by
   `getConnectedTools()` — so a blocked tool never reaches the model's tool
   catalog or the approval card in the first place. Filtering is logged
   (`logger.warn`) rather than silent, since a server offering a blocked name (or,
   on reconnect, a *new* move-shaped tool) is exactly the "don't blindly trust the
   server's self-reported tool list" case this exists for.
2. `callMcpToolStructured()` independently re-checks `conn.config.blockedTools`
   before dispatching *any* call — defense in depth, not just "hidden from the
   list."

Both layers are exercised in `mcp-client.test.ts`'s `blockedTools` describe block
against a real (stub) MCP server that actually offers a `move_series` tool.

The upstream project's own README states plainly: *"DICOM-MCP is not meant for
clinical use, and should not be connected with live hospital databases or
databases with patient-sensitive data. Doing so could lead to both loss of patient
data, and leakage of patient data onto the internet."* This exact text is carried
as `warningBanner` on the preset, and surfaced in **two places**: in Settings when
adding the preset, and — via the same field, threaded through
`Chat.tsx`'s `mcpServerInfoForCall` — on every tool-approval card for any of this
server's tools, so the warning is unavoidable at the point a tool call is actually
about to run, not just once at setup.

### No image pixel data reaches a model

`buildStructuredResult()` (`mcp-client.ts`) is the single place every MCP tool
result passes through before becoming the text a model sees. An `image` or
`audio` content block is **only ever summarized as `[image content, image/png]`**
— its raw base64 `data` is never copied into the text output. This is enforced
generically (for any MCP server, not DICOM-specific code) and locked in by
`mcp-client.test.ts`'s "never forwards raw image content data" test, which asserts
a real base64 payload from a stub tool never appears in the structured result's
`.text`.

## MCP client architecture

Before adding DICOM MCP, the entire MCP client (`app/src/mcp-client.ts`) was
rebuilt from a hand-rolled JSON-RPC implementation onto the official
`@modelcontextprotocol/sdk`. This section is the detailed reference for that
rework; each piece below is independently unit-tested (see
[Testing this layer](#testing-this-layer)).

| Concern | Where | What it does |
|---|---|---|
| **Transport** | `mcp-client.ts` — `Client` + `StdioClientTransport` / `StreamableHTTPClientTransport` | Official SDK, both transports. Protocol version negotiation happens inside the SDK's own `connect()` (validates the server's returned version against `SUPPORTED_PROTOCOL_VERSIONS`, throws on mismatch) rather than a hardcoded, unchecked version string. |
| **Schema validation** | `mcp-schema-validation.ts` | AJV, compiled and cached per server+tool at connect time. Full JSON Schema support (`$ref`/`oneOf`/`pattern`/`enum`/nested schemas) — the previous implementation only checked top-level `required`/`type`. An uncompilable schema is treated as "no validator" (permissive) rather than crashing the connection. |
| **Resources / prompts** | `mcp-client.ts` — `listResources`, `listResourceTemplates`, `readResource`, `listPrompts`, `getPrompt` | Thin wrappers over the SDK client. Not yet wired into any model-facing tool — backend plumbing only (see [Known limitations](#known-limitations)). |
| **Structured results** | `mcp-client.ts` — `callMcpToolStructured` / `buildStructuredResult` | Preserves `structuredContent`, MIME types, and resource links instead of flattening everything to a lossy string. `callMcpTool` (the model-facing entry point) still returns plain text for backward compatibility — the structured version is for audit logging and future UI. |
| **Trust profiles** | `McpServerConfig.trustProfile.autoApprovedTools`, `frontend/src/lib/tool-approval.ts`'s `trustedMcpToolNames` | Per-tool-name allowlist a user builds one tool at a time in Settings — **never** a blanket "trust this server" flag. `Chat.tsx` seeds the session's `autoApprovedTools` set with the flattened list on load, so a trusted MCP tool auto-resolves exactly like an already-approved built-in tool. |
| **Progress / cancellation** | `mcp-client.ts`'s `McpToolCallOptions` (`signal`, `onProgress`); `app-state.ts`'s `activeMcpToolRequests` map; IPC `mcp:cancelTool`; `preload.ts`'s `agent.executeToolWithProgress` | A progress bar + Cancel button render on the approval card only for an *executing* MCP tool call (built-in tools have no server-side progress support, so they're unaffected). Cancellation turns into the SDK's `notifications/cancelled`, not just a client-side give-up. |
| **OAuth 2.1 + PKCE** | `mcp-oauth.ts` | Implements the SDK's `OAuthClientProvider` interface — the SDK itself does PKCE generation, RFC 9728/8414 discovery, and RFC 8707 resource-indicator scoping (so a token obtained for one server is never reusable against another); this module only supplies storage (via the existing `secrets-store.ts`, namespaced per server) and the browser/redirect plumbing (a loopback HTTP listener on `127.0.0.1:51823`, opened only while a flow is in progress). |
| **PHI transmission preview (MCP)** | `Chat.tsx`'s `ToolApprovalCard` rendering, gated on `mcpServerInfoForCall(call)?.transport === "http"` | Same pattern as the model-call transmission preview — shown only for http-transport (remote) MCP servers, since a stdio server is a local child process. |
| **Audit + case binding** | `AuditEvent`'s `mcpServerId`/`mcpServerName`/`mcpToolName`/`approvalOutcome`/`durationMs` fields; `Chat.tsx`'s `respondToToolCall` | Every MCP tool call — approved, auto-approved, or denied — is audited with the currently-attached patient case as `targetId`, never the call's actual arguments/result. |
| **Untrusted descriptions** | `ToolApprovalCard`'s `mcpServerInfo` block | Renders the server's own tool description in a visibly separate "server-provided, unverified" block, alongside `readOnlyHint`/`destructiveHint` annotations if the server declared them — never treated as trusted UI text or as an instruction. |

## Data model reference

Full Zod schemas live in `app/src/schemas.ts`; TypeScript interfaces are mirrored
in `frontend/src/types/electron.d.ts` for the renderer (main-process types in
`app/src/*.ts` are the source of truth). Key schemas added for the clinical layer:

- `patientCaseSchema` / `patientCasesFileSchema`
- `auditEventSchema` / `auditLogFileSchema`
- `evidenceSourceSchema` / `evidenceSourcesFileSchema`
- `mcpServerConfigSchema` — extended with `trustProfile`, `auth`, `blockedTools`, `warningBanner`
- `appSettingsSchema` — extended with `caseAutoLockMinutes`, `redactBeforeRemoteSend`, `auditLogRetentionDays`

## IPC surface reference

All channels below follow the same pattern as the base app (see
[Architecture](ARCHITECTURE.md#process-model)): registered in
`app/src/ipc/*-handlers.ts`, called from `main.ts`'s `registerIpcHandlers()`,
bridged in `preload.ts`, typed in `frontend/src/types/electron.d.ts`.

| Namespace | Channels |
|---|---|
| `patientCases` | `list`, `get`, `create`, `update`, `delete`, `buildContext`, `checkConflicts` |
| `audit` | `list`, `clearAll`, `record` |
| `evidence` | `list`, `addFromUrl`, `delete` |
| `medicalSafety` | `checkEmergency`, `redact` |
| `encryption` | `status`, `setup`, `unlock`, `lock`, `disable`, `changePassphrase` |
| `mcp` (extended) | `cancelTool`, `startOAuthFlow`, `hasOAuthTokens`, `clearOAuthCredentials` — in addition to the base app's `connect`/`disconnect`/`status`/`isMastervaultBuiltinAvailable`/`pickMastervaultVault` |

## File storage layout

All under Electron's `userData` directory, through the same atomic-write/
corruption-recovery helpers (`json-store.ts`) described in
[Architecture: persistence pattern](ARCHITECTURE.md#persistence-pattern), except
where noted:

| File | Contents | Encrypted? |
|---|---|---|
| `patient-cases.json` | Patient cases (plaintext mode) | No |
| `patient-cases.enc.json` | Patient cases (encrypted mode) — `{ivHex, ciphertextHex, authTagHex}` envelope | Yes (AES-256-GCM) |
| `sessions.json` / `sessions.enc.json` | Chat sessions — same two-file plaintext/encrypted pattern, same passphrase | Yes when enabled |
| `rag.db` | RAG index (SQLite, not `json-store.ts`) — indexed text/headings/document+collection names encrypted per-column when enabled; paths and embeddings deliberately not (see [Encryption at rest](#encryption-at-rest)) | Partially, when enabled |
| `case-encryption-config.json` | `{enabled, saltHex, verifierHex}` — never the passphrase itself | N/A (not sensitive) |
| `evidence-sources.json` | Evidence Library entries | No (public reference material by design) |
| `audit-log.json` | Audit trail (deliberately no clinical content — see [Audit & Privacy](#audit--privacy)) | No |

Exactly one of `patient-cases.json` / `patient-cases.enc.json` is ever
authoritative at a time — switching encryption modes always deletes the
now-stale one (see [Encryption at rest](#encryption-at-rest)).

## Testing this layer

Every module described above has a corresponding `*.test.ts` next to it
(`app/src/*.test.ts`), following the same Vitest pattern as the rest of the app
(see [Development: testing](DEVELOPMENT.md#testing)) — run with `npm test --prefix app`.
Notably:

- `mcp-client.test.ts` spawns a **real, tiny stub MCP server**
  (`app/src/test/fixtures/stub-mcp-server.cjs`), built with the same official SDK
  the client uses server-side, so tests exercise a genuine wire-protocol
  round-trip rather than a hand-mocked transport — including progress
  notifications, cancellation, and the `blockedTools`/image-content-filtering
  guarantees above.
- `case-encryption.test.ts` covers the crypto primitives directly (setup, lock,
  unlock with correct/incorrect passphrase, key rotation, tamper detection via
  GCM's auth tag) independent of the store layer; `patient-cases-store.test.ts`'s
  "encryption at rest" block covers the store-level migration flows (plaintext →
  encrypted → back to plaintext, locked-state errors).
- `medical-safety.test.ts` and `evidence-store.test.ts` use only synthetic
  fixtures — no real patient data anywhere in the test suite.
- Frontend-side pure logic (`case-auto-lock.ts`'s `shouldAutoLock`,
  `tool-approval.ts`'s `trustedMcpToolNames`) is unit-tested separately from the
  DOM/timer wiring that calls it, since component-level rendering isn't otherwise
  tested in this codebase (see [Development: testing](DEVELOPMENT.md#testing)).

Playwright e2e (`e2e/tests/*.spec.ts`) has not been extended for the clinical
layer or run against it in this environment — see [Known limitations](#known-limitations).

## Known limitations

Also documented in the [README](../README.md#limitations-and-what-still-needs-external-authority);
repeated here with the specific code pointers:

- **Drug-interaction/allergy checking** (`KNOWN_INTERACTIONS`,
  `ALLERGY_CLASS_SYNONYMS` in `medical-safety.ts`) is a small demonstration list,
  not a licensed clinical database.
- **`checkCitations`** (`medical-safety.ts`) is wired into Clinical Assistant's
  rendering via `CitationCheckNotice` (`Chat.tsx`) — an unverified citation marker
  or an uncited clinical claim is flagged inline under the message. (Superseded
  limitation: earlier revisions of this document described this as unwired; that
  is no longer accurate.)
- **MCP resources/prompts** (`listResources`/`readResource`/`listPrompts`/`getPrompt`
  in `mcp-client.ts`) are backend-only plumbing — no IPC/UI exposes them yet, and
  no model-facing tool can trigger a resource read. DICOM MCP's report retrieval
  currently goes through `extract_pdf_text_from_dicom` (a regular tool call), not
  a resource read.
- **No clinician identity/authentication system** — `enteredBy` and audit actor
  context are plain text, not a verified identity. Session locking narrows *when*
  case data is accessible, not *by whom*.
- **No whole-app lock** — session locking (above) is scoped to case-encryption
  state specifically; chat history, Settings, and every other page stay reachable
  regardless of the case-data lock state.
- **No regulatory certification of any kind.**
- **Accessibility**: ad hoc `aria-*` labeling, no full WCAG 2.2 AA audit
  performed on the clinical pages.
- **No literature-search API integration** (e.g. PubMed live search) — Evidence
  Library is add-by-URL only, by design.
- **PHI redaction** (`redactIdentifiers`) is regex pattern matching, not
  clinical-grade de-identification — a "0 redacted" result is not confirmation
  the text was actually clean.
- **Playwright e2e** has not been extended to cover the clinical layer, and
  wasn't run in the environment this was built in (no GUI available).

## Clinical AI workspace

The case detail view now has a **Clinical AI** tab backed only by the shared
enterprise server. It provides task templates, explicit per-request data scope,
approved-model selection, a pre-flight destination/scope preview, purpose-bound
consent capture, selection of reviewed de-identified imaging manifests,
structured evidence/uncertainty/follow-up rendering, immutable
accept/reject/correct/escalate review controls, and request/transformation
provenance. Access tokens remain in Electron main; the renderer uses narrow IPC
methods and never receives a server credential.

This is not available in local-only case storage because the governance state
(tenant approval, consent, request envelope, audit, and review) belongs to the
shared server. Pixel bytes are not sent through this text-model workflow; see
`docs/CLINICAL_AI_GATEWAY.md` for that deliberate boundary.

## See also

- [Architecture](ARCHITECTURE.md) — the base Electron app's process model, IPC
  bridge, and persistence pattern
- [Agent mode](AGENT_MODE.md) — the full built-in tool catalog, workspace
  sandboxing, and the general (non-medical-specific) tool-approval model
- [Development](DEVELOPMENT.md) — running, testing, building, packaging
