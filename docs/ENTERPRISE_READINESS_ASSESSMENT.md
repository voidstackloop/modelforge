# Enterprise / regulatory readiness assessment

**Scope:** Inspection and gap analysis only, per request — no rewrite performed. This
document is the evidence-backed basis for a phased implementation plan, not the plan's
execution.

**Method:** Direct inspection of the repository (`app/src/**`, `frontend/src/**`,
`docs/**`, `.github/**`) as of this assessment. Every claim below either cites a
file/line or states explicitly that a grep/search across the relevant trees returned
no matches. No file was overwritten during this assessment; only `Read`/`Grep`/`Bash`
(read-only) were used. `AGENTS.md` does not exist in this repository; `CLAUDE.md`
(graphify usage rules) and the existing `docs/AGENT_MODE.md`,
`docs/CLINICAL_WORKSPACE.md`, `docs/ARCHITECTURE.md` were read and are treated as
authoritative for what's already documented — this assessment does not duplicate them,
it extends them toward institutional deployment.

## Responsibility taxonomy (used throughout)

Every gap below is tagged with one or more of:

- **[SW]** — Implementable in this codebase.
- **[CFG]** — Requires institutional configuration/deployment decisions (identity
  provider, network topology, key management service, retention policy) — code can
  make it *possible*, not *true by default*.
- **[DATA]** — Requires a licensed medical dataset/terminology/drug database this
  project cannot ship (SNOMED CT, RxNorm, a commercial interaction database, UMLS).
- **[CLIN]** — Requires clinical validation by qualified clinicians (accuracy
  studies, adjudicated reference answers, safety review) — no engineering substitute.
- **[LEGAL]** — Requires legal, regulatory, contractual, or certification work
  (BAAs, DPAs, HIPAA Security Rule risk assessment, FDA/MDR/CE classification,
  KVKK VERBIS registration) that no code change satisfies.

---

## 1. Current-state architecture summary

ModelForge Medical is a **single-user Electron desktop application** (main process +
Chromium renderer + `preload.ts` context bridge — see `docs/ARCHITECTURE.md`). There
is **no server component, no multi-tenancy, and no network-facing API** other than
outbound calls the app itself makes (model providers, MCP servers, evidence-source
fetches). Every store is a local file under Electron's `userData` directory, written
through a shared atomic-write helper (`app/src/json-store.ts`) with corruption
recovery (backs up and resets on schema-mismatch, per `readJsonWithSchema`).

Clinical-specific layer (built this engagement, see `docs/CLINICAL_WORKSPACE.md` for
full detail):

- **Patient Cases** (`app/src/patient-cases-store.ts`) — structured fields with
  per-field `includeInContext` opt-in, optional AES-256-GCM encryption at rest
  (`app/src/case-encryption.ts`), inactivity-based session lock
  (`frontend/src/lib/use-case-auto-lock.ts`).
- **Clinical Assistant** (`frontend/src/pages/Chat.tsx`) — 8-section response
  contract via system prompt, deterministic pre-model emergency-keyword detection
  and demonstration-only medication/allergy conflict checking
  (`app/src/medical-safety.ts`), transmission preview + opt-in redaction before
  remote sends.
- **Evidence Library** (`app/src/evidence-store.ts`) — add-by-URL only, extracts
  `<title>`/meta-description honestly (never fabricates), no live literature search.
- **Knowledge Graph** (`frontend/src/pages/KnowledgeGraph.tsx`) — per-case field
  visualization only, explicitly not a medical ontology.
- **Audit & Privacy** (`app/src/audit-log-store.ts`) — a flat, unsigned JSON array
  of events, capped at 5000 and/or a configurable retention window
  (`AppSettings.auditLogRetentionDays`).
- **MCP client** (`app/src/mcp-client.ts`) — rebuilt on the official
  `@modelcontextprotocol/sdk` this engagement: real JSON Schema validation (AJV),
  per-tool trust profiles, progress/cancellation, OAuth 2.1+PKCE for HTTP servers,
  a code-enforced tool denylist mechanism (used for DICOM MCP's `move_series`/
  `move_study`).
- **Identity, RBAC, central administration**: **none exist.** `app/src/accounts.ts`
  is GitHub/Hugging Face personal-access-token linking for Agent-mode tools
  (repository browsing, model downloads) — it is not a user-identity system and has
  no bearing on who is using the ModelForge Medical application itself. Grepping
  `app/src` and `frontend/src` for `passport|next-auth|oidc|saml|SAML|OIDC` returns
  no matches. Grepping for `RBAC|permission|role.*admin` returns matches only in
  unrelated files (`command-sandbox.ts`'s OS process permissions, `json-store.ts`'s
  file permissions) — no application-level role concept exists anywhere.

## 2. Evidence-backed gap analysis (by requested capability area)

### 2.1 Identity and access management — **absent entirely**

No login screen, no user object, no session concept beyond "the OS user who launched
the app." Confirmed by direct inspection: no SSO/OIDC/SAML/MFA library in either
`app/package.json` or `frontend/package.json`; no `User`/`Session` type in
`app/src/**`; `secrets-store.ts` and `case-encryption.ts` are per-device, not
per-person. Break-glass, RBAC/ABAC, patient/department-level authorization, and
account lifecycle management all require an identity system that doesn't exist as a
prerequisite — none of these can be partially retrofitted onto a single-user desktop
process without that foundation. **[SW+CFG]**: an identity layer is buildable, but a
desktop Electron app enforcing RBAC against a local install is inherently weaker than
a server-mediated one (a user with disk access can inspect/modify local state) — real
RBAC for this product shape implies a **server-mediated deployment topology** (see
§5 Target architecture), not just a login screen bolted onto the current
single-process app.

### 2.2 Central institutional administration — **absent entirely**

`app/src/settings-store.ts`'s `AppSettings` is a single flat, per-device JSON file
(`settings-store.ts:1-225`, confirmed no `organization`/`centralPolicy`/`orgPolicy`
field via grep). There is no concept of an admin pushing policy to a fleet of
installs, no remote configuration, no remote revocation, and no organization-wide
feature toggle. Agent mode can be disabled per-device by the device's own user
(Settings toggle exists for `networkToolsEnabled`, `verificationEnabled`, etc.) but
**not by an administrator remotely** — anyone with the app installed can re-enable
anything on their own machine. **[SW+CFG]**: requires a central policy service (or
at minimum, a signed policy file distribution mechanism) — pure client-side
enforcement without server backing is fundamentally circumventable by whoever has
local admin rights on the device.

### 2.3 PHI and sensitive-data protection — **partial, one store only**

**PHI-bearing stores identified by inspection:**

| Store | File | PHI risk | Encryption today |
|---|---|---|---|
| Patient cases | `patient-cases.json` / `.enc.json` | High — allergies, meds, conditions, notes | **Yes**, opt-in AES-256-GCM (`case-encryption.ts`) |
| Chat sessions | `sessions-store.ts` → `sessions.json` | High — case context gets pasted/typed directly into chat messages, model responses | **No** |
| Evidence sources | `evidence-store.ts` → `evidence-sources.json` | Low (URLs/metadata only, no patient data by design) | No (not needed) |
| Audit log | `audit-log-store.ts` → `audit-log.json` | Low by design (`detail` documented as non-clinical, never enforced at the type level) | No |
| RAG embeddings | `app/src/rag.ts` (per `docs/ARCHITECTURE.md`) | High if a clinical document is embedded | **Not inspected in this pass — flag for follow-up; likely unencrypted like sessions.** |
| Exported files | `data-transfer.ts`-driven exports (session/all export) | High | **No** — exports are plaintext by construction |
| Electron cache/temp | Chromium's own disk cache, crash dumps | Unknown/high | **Not addressed at all** — outside this app's direct control without Electron-level hardening |
| Logs | `logger.ts` rotating file logs | Medium — depends on what gets logged; not audited for PHI leakage in this pass | **Not addressed** |
| Backups | None exist — no backup mechanism at all currently | N/A | N/A |

**This is the single largest concrete gap**: chat session history — where actual
clinical conversation content lives, arguably the *highest*-PHI-density store in the
app — has **no encryption at rest**, while only the structured Patient Case store
does. A user could enable case encryption, feel protected, and still have full
clinical detail sitting in plaintext `sessions.json` from every conversation.
**[SW]** extending `case-encryption.ts`'s pattern to sessions is directly buildable;
**[SW]** a temp-file/cache audit is buildable; **[CFG]** enterprise key
management (HSM/KMS-backed keys, rotation) requires infrastructure this app doesn't
have and a passphrase-only design (as built) cannot satisfy on its own; **[LEGAL]**
BAA/DPA and zero-retention configuration metadata are provider contracts, not code.

De-identification: `medical-safety.ts`'s `redactIdentifiers` is regex-only
(email/phone/SSN/MRN/DOB patterns — `medical-safety.ts`, confirmed via
`docs/CLINICAL_WORKSPACE.md`'s own explicit caveat) and is documented in-repo as
**not** clinical-grade (HIPAA Safe Harbor requires handling free-text narrative
mentions of names/locations/rare ages/device IDs, which regex cannot reliably catch).
**[DATA+CLIN]** — a real de-identification engine needs either a licensed NLP
de-identification service or a clinically-validated model, not a regex list.

### 2.4 Audit and accountability — **partial, not tamper-evident, no real actor identity**

`audit-log-store.ts` records `id, timestamp, actionCategory, targetType?, targetId?,
detail?` plus (added this engagement) MCP-specific fields. Confirmed by direct
inspection (`grep -n 'hash|sign|hmac|checksum' audit-log-store.ts` → **no matches**):
**the audit log has no cryptographic integrity protection whatsoever.** It is a flat
JSON array anyone with filesystem access can edit with a text editor, with no hash
chain, no digital signature, and no append-only enforcement at the OS or application
level. There is also **no authenticated actor** on any event — because there's no
identity system (§2.1), "who did this" cannot be recorded beyond "whoever had the app
open." No SIEM export, no central aggregation (every install's audit log is local and
isolated — an institution running 200 clinician workstations has 200 disconnected
audit logs, not one), no access-review report generation, no automated security
alerting. **[SW]**: a hash-chained or signed log format, structured export, and a
SIEM-compatible output format (CEF/syslog) are all directly buildable without external
dependencies. **[SW+CFG]**: central aggregation requires either a server component or
a defined export/ship-to-SIEM pipeline (Filebeat, Fluentd, etc.) configured per
institution.

### 2.5 Clinical interoperability — **absent entirely (by design, per README)**

No FHIR client, no SMART on FHIR, no HL7 v2 parser, no CDA handling anywhere in
`app/src` or `frontend/src` (confirmed via grep across both trees — zero matches
for `FHIR|HL7|SMART`). DICOM support is **MCP-tool-mediated only** (`dicom-mcp`
preset, `docs/CLINICAL_WORKSPACE.md`'s "Medical MCP integrations" section) — the app
calls an external, community-maintained, explicitly-prototype MCP server for DICOM
metadata queries; it does not itself speak the DICOM protocol, has no patient-matching
logic, no duplicate detection, and (correctly, per the existing design) no write-back
capability of any kind. Turkish SBYS/e-Nabız integration does not exist in any form.
**[SW]**: a read-only FHIR R4 client (patient/encounter/condition/medication resource
fetch) is buildable as a new MCP-server-equivalent integration, following the same
pattern already established for DICOM MCP (a scoped, denylist-enforced, warning-banner
integration) — but this is genuinely large new work, not a gap-fill. **[LEGAL+CFG]**:
SMART on FHIR requires an institutional EHR's app-registration process; e-Nabız
requires Turkish Ministry of Health authorization that is explicitly outside
engineering scope.

### 2.6 Medical terminology — **absent entirely**

No SNOMED CT, LOINC, RxNorm, ICD-10, UMLS, or UCUM handling anywhere in the codebase
(confirmed via grep — the only occurrences of these terms are in `medical-safety.ts`
comments *explaining their absence* and in `docs/CLINICAL_WORKSPACE.md`, which this
engagement wrote to document that absence honestly). Patient Case fields
(`conditions`, `medications`, `allergies` in `patient-cases-store.ts`) are **free-text
string arrays** with no coded-value binding, no terminology version, and no mapping
provenance. **[DATA]**: SNOMED CT, LOINC, RxNorm, and UMLS are licensed vocabularies
(UMLS requires a UTS license even for research use) — none can be bundled into an
open-source-adjacent product without a license agreement per institution. **[SW]**:
the *integration surface* (a terminology-lookup abstraction, coded-value fields
alongside free text, UCUM-based unit normalization for lab values) is buildable now,
ready to plug in a licensed terminology server later.

### 2.7 Medication and allergy safety — **demonstration-only, explicitly labeled as such**

`checkMedicationConflicts()` (`medical-safety.ts`) uses two small hardcoded tables:
`ALLERGY_CLASS_SYNONYMS` (3 classes: penicillin, sulfa, NSAID) and
`KNOWN_INTERACTIONS` (5 pairs: warfarin+aspirin, warfarin+ibuprofen, MAOI+SSRI,
sildenafil+nitrate, metformin+contrast dye). The in-repo comment on
`KNOWN_INTERACTIONS` states verbatim: *"NOT a substitute for a licensed
drug-interaction database (e.g. First Databank, Lexicomp, Multum)."* Every UI
surface that renders a warning from this function (`PatientCaseDetail.tsx`) appends
*"Generated by simple keyword matching, not a licensed drug-interaction database.
Verify independently."* **This labeling is a real, load-bearing safety control** — it
correctly prevents the single most dangerous failure mode of a system like this
(silent false confidence from an absent warning) by making the limitation
unavoidably visible at the point of use. No cross-sensitivity beyond the three
allergy classes, no duplicate-therapy detection, no dose-range checking, no
renal/hepatic adjustment, no pregnancy/age/weight/pediatric logic, no formulary
support. **[DATA]**: a real medication-safety engine requires a licensed database
(First Databank/Multum/Lexicomp-class) — this is a data-licensing problem, not an
engineering one. **[SW]**: the *abstraction boundary* — a `MedicationSafetyProvider`
interface `checkMedicationConflicts()` could be refactored behind, with the current
demonstration table as the default/fallback implementation and a licensed-database
adapter pluggable per institution — is directly buildable now and is the concrete,
correctly-scoped "software responsibility" here.

### 2.8 Clinical AI validation — **absent entirely**

No intended-use statement beyond the product-boundary language in `README.md`
("clinical decision-support... not an autonomous diagnostician"). No validation
dataset, no clinician-adjudicated reference answers, no hallucination/harmful-omission
metrics, no sensitivity/specificity/calibration measurement, no subgroup evaluation,
no acceptance thresholds, no silent-mode prospective evaluation pipeline, no
human-factors/usability study. **This entire category is [CLIN]** — it cannot be
satisfied by code changes at all. The one thing engineering *can* do is instrument
the product to make such a study possible later (structured logging of model
outputs against the response contract, a review/adjudication UI for clinicians to
mark outputs correct/incorrect) — that instrumentation does not exist today either.
**[SW]**: build the *instrumentation* (structured output logging, a clinician-review
UI, a metrics pipeline) now; **[CLIN]**: the actual validation study itself is not an
engineering deliverable under any circumstance.

### 2.9 Model governance — **absent entirely**

`AppSettings.defaultModel` and per-session `model` string
(`sessions-store.ts:ChatSession.model`) are free-text identifiers with no version
pinning beyond whatever string the user typed, no model card, no approved-use flag,
no evaluation gate before a model becomes selectable, no drift detection, no
periodic revalidation requirement, no reproducibility guarantee (temperature/seed are
user-configurable per session but nothing prevents a user from changing them
turn-to-turn). System-prompt/prompt-preset versioning exists in a limited form —
`PromptPreset.versions` (`schemas.ts`) keeps a history when a saved prompt is edited
— but this is a convenience feature, not a governance control (no approval workflow,
no change-control gate). **[SW]**: an approved-model registry (institution-curated
list of `{provider, modelId, version, approvedUseCases, approvedBy, approvedAt}`)
gating what's selectable in the model picker is directly buildable and is a natural
extension of the existing `mcp-presets.ts`/trust-profile pattern already used for MCP
servers. **[CLIN]**: deciding *which* models are approved for *which* use cases is a
clinical/governance decision, not one code can make.

### 2.10 Output safety — **partial**

What exists: the 8-section response contract (prompt-level, not enforced), pre-model
deterministic emergency detection (`checkForEmergencyFlags` — genuinely
model-independent, a real control), the "Not verified" badge on every assistant
message (`Chat.tsx`'s `MessageBubble`), transmission preview before remote sends,
and (built but **not wired into the UI** — confirmed via grep, `checkCitations` is
only referenced from its own test file) a citation-verification function that checks
a model's inline citation markers against known Evidence Library sources. **Gap**:
there is no structured *validation* of a model's response against the 8-section
contract — a model that skips "Uncertainty and limitations" or fabricates a citation
is not caught by anything today; the contract is a system-prompt instruction only,
exactly as `docs/CLINICAL_WORKSPACE.md` already discloses. No abstention enforcement
(a model can answer confidently even when the contract asks it to say "insufficient
data"). No mechanism requires an identifiable clinician's sign-off before a
model-drafted note (e.g. a SOAP note) is treated as final — `ClinicalNote.author`
(`patient-cases-store.ts`) does distinguish `"clinician" | "model-inference"`
provenance, which is good, but nothing *enforces* a review step before a
model-inference note could be acted on. **[SW]**: structured-output validation
(parse the response for the 8 required section headers, flag a response missing
any), wiring `checkCitations` into the chat UI, and a review/sign-off gate on
`clinicalNotes` are all directly buildable now.

### 2.11 Evidence quality — **partial**

Evidence Library (`evidence-store.ts`) never fabricates title/organization/date —
confirmed by its own test suite (`evidence-store.test.ts`'s "never fabricates a
title when none is found"). This is real and correctly built. Gaps: no automatic
claim-to-source traceability from a model's answer back to a specific Evidence
Library entry (the citation-checking function exists but isn't wired in, per §2.10);
no retraction awareness; no evidence grading (GRADE-style strength-of-evidence
labeling); no guideline-versioning; publication/retrieval dates are captured
(`retrievedAt`, `publishedOrUpdated`) but not surfaced prominently enough to
distinguish "current" from "possibly outdated" evidence in the UI. Patient
facts/retrieved evidence/model inference *are* structurally separated at the data
level (`ClinicalNote.author`, `CaseField.includeInContext`, Evidence Library as a
distinct store) — this separation exists and is a real strength; it's the
*rendering* of that separation in the chat transcript itself (as opposed to the case
page) that's incomplete.

### 2.12 Operational readiness — **absent**

No centralized monitoring (single-device app, nothing to centralize into). No HA
concept (desktop app). No backup mechanism of any kind exists — a user's Patient
Cases, chat history, and audit log live only on their local disk with no built-in
backup, encrypted or not. No defined RPO/RTO. `.github/workflows/ci.yml` and
`release.yml` exist and run tests/build/typecheck plus a release-asset
verification step (confirmed by direct inspection), but **no dependency/SBOM
scanning step was found** (`grep -n 'npm audit|codeql|security' ci.yml` → no
matches) and **no `.github/dependabot.yml` exists**. `electron-builder` update
signing is explicitly **not configured** — `docs/DEVELOPMENT.md`'s own "Adding
signing later (not currently configured)" section confirms every installer today
ships with an "unknown publisher" warning, and `electron-updater` (present in
`app/package.json`) auto-updates without a code-signing chain of trust in place.
**[SW]**: SBOM generation (`npm sbom` / CycloneDX, trivial to add to CI), Dependabot
config, and a documented incident-response runbook are directly buildable now.
**[CFG]**: code-signing certificates, a backup destination/schedule, and defined
RPO/RTO are institutional decisions layered on top of buildable mechanisms.

### 2.13 Agent and MCP security — **strong relative to the rest of the app, with one explicit known gap**

This is the most mature area, largely because of this engagement's Part A/B MCP
rework (`docs/CLINICAL_WORKSPACE.md`'s "MCP client architecture" section):
AJV-validated tool schemas, per-tool trust profiles (never blanket server trust),
OAuth 2.1+PKCE with RFC 8707 resource-indicator scoping, a code-enforced tool
denylist (proven against DICOM's `move_series`/`move_study`), PHI transmission
preview before remote MCP calls, structured audit binding, and untrusted-description
rendering. **Explicit, documented gap**: `docs/AGENT_MODE.md` states directly —
*"Windows has no equivalent lightweight primitive [to bubblewrap/sandbox-exec] —
there's no OS-level confinement there, only the [destructive-command] blocklist...
plus resource-monitor.ts limits."* This means on Windows specifically, `run_command`
and `run_code` rely entirely on a denylist of known-dangerous patterns rather than
real OS-level sandboxing — a materially weaker isolation guarantee than macOS/Linux
for the exact same feature. There is no institutional trusted-MCP-server registry
(any user can add any MCP server locally — this is by design for a single-user app,
but is a gap for institutional deployment where an admin should be able to restrict
which MCP servers are addable at all), no network-egress control beyond the existing
`networkToolsEnabled` global on/off toggle, and no least-privilege *service identity*
concept (there are no services — everything runs as the OS user). **[SW]**: an
institutional MCP-server allowlist (server URL/command must match an admin-approved
list) is a direct, buildable extension of the existing preset/trust-profile pattern.
**[CFG]**: true Windows sandboxing would require either a fundamentally different
process-isolation approach (a Windows container, AppContainer/Job Object-based
confinement) — a genuinely large undertaking, not a quick fix — or accepting the
denylist-only posture as a documented, institution-acknowledged risk for Windows
deployments specifically.

### 2.14 Accessibility and human factors — **ad hoc, not audited**

`docs/CLINICAL_WORKSPACE.md`'s own "Known limitations" section already discloses:
"ad hoc `aria-*` labeling, no full WCAG 2.2 AA audit performed on the clinical
pages." No keyboard-only operation audit, no screen-reader testing, no localization
validation beyond the existing en/tr dictionary completeness (no clinical-content
translation review). The "Not verified" badge and clinical severity/warning
styling (destructive-red for emergency banners, warning-amber for medication
conflicts) do differentiate facts/warnings/unverified output *visually*, but this
has not been validated for colorblind accessibility or screen-reader announcement
priority (an emergency banner should almost certainly be an `aria-live="assertive"`
region — not confirmed as implemented in this pass). **[SW]**: a WCAG audit pass
and `aria-live` correctness review are directly buildable. **[LEGAL]**: formal
accessibility *certification* (e.g. VPAT) is a compliance-documentation exercise
layered on top of the engineering work.

---

## 3. Capability gap table

| Capability | Current implementation | Risk | Required improvement | Priority | Responsibility |
|---|---|---|---|---|---|
| Verified identity | None — OS-user-only | Critical: no accountability, no access control possible | Identity provider integration (OIDC/SAML) | P0 | SW+CFG |
| MFA | None | Critical | Delegate to IdP (do not build custom MFA) | P0 | CFG |
| RBAC/ABAC | None | Critical | Role model + enforcement layer, server-mediated | P0 | SW+CFG |
| Break-glass access | None | High | Justification-logged emergency access flow | P0 | SW |
| Central policy admin | None (per-device settings only) | Critical | Central policy service, signed policy distribution | P0 | SW+CFG |
| Approved model registry | Free-text model string, no governance | High | Curated, admin-approved model list | P0 | SW+CLIN |
| MCP/endpoint allowlist | User can add any MCP server locally | High (institutional context) | Admin-scoped allowlist enforcement | P0 | SW+CFG |
| PHI inventory/encryption | Only patient-cases.json encrypted; sessions.json, exports, RAG store, logs, cache not covered | Critical | Extend encryption to all PHI-bearing stores; audit temp/cache/log paths | P0 | SW |
| Enterprise key management | Passphrase-derived key, session-memory only, no rotation | High | KMS/HSM-backed key option for institutional deployments | P0 | SW+CFG |
| Secure deletion | Plain file delete (`fs.rmSync`) | Medium | Document as best-effort; true secure-erase is filesystem/disk-dependent | P1 | SW+CFG |
| Backup encryption | No backup mechanism exists at all | High | Build backup mechanism, encrypted by default | P0 | SW+CFG |
| Legal hold | None | Medium | Retention-override flag per case/audit event | P1 | SW+LEGAL |
| DLP | None | Medium | Outbound-content scanning before remote send (beyond current redaction) | P1 | SW |
| Clinical-grade de-identification | Regex-only, explicitly non-clinical-grade | High | Licensed NLP de-identification service | P1 | DATA+CLIN |
| Tamper-evident audit | Flat JSON, no hash/signature | Critical | Hash-chained or signed log format | P0 | SW |
| Authenticated audit actor | None (no identity system) | Critical | Depends on §Identity | P0 | SW (blocked on identity) |
| SIEM export | None | High | CEF/syslog export, or file-ship pipeline | P1 | SW+CFG |
| FHIR R4 (read-only) | None | High (for real clinical utility) | Read-only FHIR client, same pattern as DICOM MCP | P0 | SW+CFG |
| SMART on FHIR | None | High | Standard OAuth2 SMART launch flow | P0 | SW+CFG |
| Terminology (SNOMED/LOINC/RxNorm/UMLS) | Free-text only | High | Coded-value fields + pluggable terminology service | P1 | DATA+SW |
| Licensed medication safety | Demonstration table only (explicitly labeled) | Critical if mistaken for real clearance | `MedicationSafetyProvider` abstraction + licensed adapter | P1 | DATA+SW |
| Clinical validation framework | None | Critical | Instrumentation now; formal study is clinical work | P0 | SW (instrumentation) + CLIN (study) |
| Output structured validation | Prompt-only contract, not enforced | High | Parse/validate response structure; wire in existing `checkCitations` | P1 | SW |
| Windows agent sandboxing | Denylist only, no OS-level confinement | High (Windows installs specifically) | Document as risk; evaluate AppContainer/Job Object confinement | P1 | SW+CFG |
| SBOM / dependency scanning | None found in CI | Medium | Add SBOM generation + Dependabot to CI | P1 | SW |
| Update signing | Not configured (`docs/DEVELOPMENT.md` confirms) | Medium | Configure code-signing certificates | P1 | CFG |
| Accessibility (WCAG 2.2 AA) | Ad hoc, undocumented gaps | Medium | Full audit + remediation pass | P2 | SW+LEGAL (certification) |

---

## 4. Threat model

| Threat | Current exposure | Mitigations present | Mitigations missing |
|---|---|---|---|
| **PHI exposure via stolen/lost device** | High — most PHI-bearing stores unencrypted (§2.3) | Case-encryption for `patient-cases.json` only; OS-level disk encryption is the user's own responsibility (documented) | Full-store encryption, remote wipe, MDM integration |
| **Malicious insider (authorized user misusing access)** | High — no RBAC, no per-patient authorization, no audit-actor identity | Audit trail exists (weak) | RBAC, break-glass justification logging, authenticated actors, tamper-evident log |
| **Stolen device with app open/unlocked** | Medium — session lock exists for case data specifically | `caseAutoLockMinutes` auto-lock (§Encryption/session-lock in `docs/CLINICAL_WORKSPACE.md`) | Whole-app lock (chat/Settings remain reachable per documented limitation), MFA re-auth |
| **Compromised/malicious model provider** | Medium — remote sends require explicit confirmation, redaction is opt-in | Transmission preview, local/remote badge, provider selection is user-controlled | No provider attestation/BAA-status tracking, no automatic zero-retention enforcement |
| **Prompt injection via imported clinical documents/attachments** | Medium — mitigated but not eliminated | `UNTRUSTED_CONTENT_PREAMBLE` framing (`Chat.tsx`), per-call tool approval, MCP tool descriptions rendered as "unverified" | No content-level injection detection/scanning |
| **Unsafe/malicious MCP tool or server** | Low-Medium — meaningfully hardened this engagement | AJV schema validation, trust profiles (never blanket), code-enforced denylist, OAuth scoping, PHI transmission preview | No institutional trusted-server registry; any local user can add any server |
| **Supply-chain compromise (dependency)** | Medium — not actively monitored | None found beyond normal `npm install` | SBOM, Dependabot, CI dependency scanning, update-signing chain |
| **Audit log tampering** | High — trivially editable, no integrity check | None | Hash chaining/signing, append-only enforcement, central shipping |
| **Windows command-execution escape** | Medium-High on Windows specifically, Low on macOS/Linux | Destructive-command blocklist, resource limits (`docs/AGENT_MODE.md`) | Real OS-level sandbox equivalent to bubblewrap/sandbox-exec |
| **Data exfiltration via redaction bypass** | Medium — redaction is regex-only and opt-in, off by default | Transmission preview shows what's included | Clinical-grade de-identification, mandatory (not opt-in) DLP for institutional deployments |

---

## 5. Target architecture for institutional deployment

The current single-process desktop shape is fundamentally incompatible with several
P0 requirements (RBAC, central policy, tamper-evident central audit, SIEM
integration) — these require **something on the other end of a network connection**
that the desktop app talks to, not just more local code. A realistic target
architecture:

```
┌─────────────────────────┐        ┌──────────────────────────────────┐
│ ModelForge Medical       │        │ Institutional control plane        │
│ (desktop client,         │◄──────►│  - Identity (OIDC/SAML broker)     │
│  this repository)        │  HTTPS │  - Policy service (feature flags,  │
│                           │        │    model registry, MCP allowlist)  │
│  - Local case cache       │        │  - Central audit ingestion (SIEM)  │
│    (encrypted, short-TTL) │        │  - Key management (KMS-backed)     │
│  - Offline-capable for    │        │  - Backup/DR orchestration         │
│    local-model inference  │        └──────────────────────────────────┘
└─────────────────────────┘
```

Key architectural decisions this implies:

1. **Identity moves to the control plane.** The desktop app becomes an OIDC/SAML
   *relying party*, not an identity holder — no custom auth is built in-app.
2. **Audit events are shipped, not just stored locally.** Local storage remains
   (offline resilience) but every event is also forwarded to a central,
   tamper-evident sink as soon as connectivity allows; local logs stay
   hash-chained regardless of connectivity so a gap in shipping doesn't create a
   gap in integrity.
3. **Policy is pulled, signed, and cached.** The client periodically fetches a
   signed policy document (approved models, MCP allowlist, retention rules,
   feature flags) and enforces it locally, refusing to operate on an
   expired/unverifiable policy past a grace period — this is how "central
   revocation" becomes real without requiring permanent connectivity.
4. **Local-first inference is preserved.** This is the product's actual
   differentiator and should not be sacrificed for the control plane — local model
   inference continues to work fully offline; only identity, policy-refresh, and
   audit-shipping require connectivity, and each degrades gracefully (cached
   policy, local audit buffering) rather than failing closed in a way that blocks
   clinical work.
5. **Key management splits local/central.** Case-encryption keys can remain
   passphrase-derived for individual/small-practice deployments (current design,
   kept as a supported mode) *or* be wrapped by an institutional KMS for larger
   deployments — both modes share the same `case-encryption.ts` interface, just a
   different key-provider implementation behind it.

This is a genuinely large architectural addition (a new backend service this
repository does not currently have any component of), not a set of patches to the
existing Electron app — sizing it accurately matters more than a comforting
smaller estimate.

---

## 6. Phased implementation roadmap

Dependencies are explicit; nothing after Phase 0 should start before its listed
dependency is done, since building on an unstable foundation (e.g. audit fields
before an identity system exists to populate the actor) means redoing the work.

### Phase 0 — Foundation (blocks all P0 work)
- Full PHI inventory completion (§2.3's flagged-but-not-fully-inspected stores:
  `rag.ts` embeddings, exports, logs, Electron cache/temp).
- Decide target architecture posture (single-device-only vs. control-plane-backed —
  §5) — **this is a product decision, not an engineering one**, and everything
  downstream depends on it.
- **Acceptance criteria**: written PHI inventory covering every store with
  encryption status; a signed-off target-architecture decision document.

### Phase 1 — Identity, RBAC, central policy (P0)
- Depends on: Phase 0's architecture decision.
- OIDC relying-party integration; role model (clinician/admin/researcher/
  auditor/support) with `patient-level`/`department-level` scoping; break-glass
  flow with mandatory justification text, itself an audited event; central policy
  fetch-and-cache with signature verification and expiry.
- **Acceptance criteria**: no PHI-bearing action is reachable without a verified
  identity and a role check; break-glass access is itself audit-logged with the
  justification text; a revoked policy takes effect within the defined grace
  period even offline-then-reconnected.

### Phase 2 — Tamper-evident audit + PHI encryption completion (P0)
- Depends on: Phase 1 (for authenticated actors on every event).
- Hash-chain or sign every audit event; extend encryption-at-rest to
  `sessions.json`, exports, and any PHI-bearing cache/temp path found in Phase 0's
  inventory; central audit shipping with local buffering.
- **Acceptance criteria**: any out-of-band edit to the local audit log file is
  detectable; every store in the Phase 0 inventory marked "PHI: high" is
  encrypted at rest; audit events survive a network outage and ship on
  reconnection without loss or duplication.

### Phase 3 — Model/MCP governance (P0/P1)
- Depends on: Phase 1 (policy delivery mechanism).
- Approved-model registry gating the model picker; institutional MCP-server
  allowlist enforced client-side against the fetched policy; evaluation-gate
  workflow before a model/MCP server can be marked approved.
- **Acceptance criteria**: a non-approved model/MCP server is not selectable in
  the UI, not just discouraged; an admin can revoke approval and it takes effect
  per Phase 1's policy-refresh mechanism.

### Phase 4 — Clinical interoperability, read-only (P0/P1)
- Depends on: Phase 1 (identity/authorization — patient-context sync requires
  knowing *who* is allowed to see *which* patient), Phase 3 (an EHR integration
  is itself a governed "tool").
- Read-only FHIR R4 client (patient/encounter/condition/medicationrequest
  resources), SMART on FHIR launch flow, patient matching (deterministic, not
  probabilistic, to start), source provenance tagging on every imported field.
- **Acceptance criteria**: no write-back capability exists at all in this phase
  (explicitly deferred); every FHIR-sourced field is visibly tagged with its
  source and retrieval time in the UI, matching the existing
  `ClinicalNote.author` provenance pattern.

### Phase 5 — Terminology + licensed medication safety (P1)
- Depends on: Phase 0 (architecture decision affects whether terminology service
  is local or centrally hosted), a signed data-license agreement (external to
  engineering).
- `MedicationSafetyProvider` abstraction (keep the current demonstration table as
  the default fallback, explicitly labeled, exactly as today); pluggable
  terminology-lookup interface; UCUM unit normalization on lab-result entry.
- **Acceptance criteria**: swapping the demonstration medication-safety table for
  a licensed adapter requires no changes outside the adapter implementation;
  every terminology-coded field records its code system and version.

### Phase 6 — Output safety hardening + evidence provenance (P1)
- Depends on: nothing above — can run in parallel with Phases 1-5.
- Structured-response validation against the 8-section contract; wire
  `checkCitations` into the chat UI; evidence-grading labels in Evidence Library;
  a review/sign-off gate before a `clinicalNotes` entry with
  `author: "model-inference"` is treated as final.
- **Acceptance criteria**: a response missing a required contract section is
  visibly flagged, not silently accepted; an unresolvable citation marker is
  rendered as unverified in the transcript, not just internally computed.

### Phase 7 — Operational readiness (P1)
- Depends on: Phase 2 (backup must cover the now-fully-encrypted stores).
- Encrypted backup mechanism with defined RPO/RTO; SBOM + Dependabot in CI;
  code-signing for releases; documented incident-response runbook.
- **Acceptance criteria**: a restore-from-backup drill succeeds against a
  synthetic dataset; CI fails the build on a newly-disclosed critical CVE in a
  direct dependency.

### Phase 8 — Accessibility + maturity (P2)
- WCAG 2.2 AA audit and remediation; `aria-live` correctness pass on
  emergency/warning banners; localization validation for clinical content.

---

## 7. Proposed data model (institutional deployment)

Scoped to what Phases 1-4 above require; field lists are illustrative, not final schemas.

```
Organization
  id, name, identityProviderConfig, policyDocumentUrl, dataResidencyRegion

User
  id, organizationId, externalIdpSubject (never a locally-stored password),
  displayName, status (active/suspended/deprovisioned), lastLoginAt

Role
  id, name (clinician|administrator|researcher|auditor|support), permissions[]

UserRoleAssignment
  userId, roleId, scope (organization|department|patient-list), scopeId, grantedBy, grantedAt

Permission
  id, resource (patient-case|audit-log|model-registry|mcp-registry|...), action (view|edit|export|delete|administer)

BreakGlassAccess
  id, userId, patientId, justificationText, grantedAt, expiresAt, reviewedBy?, reviewedAt?

Patient
  id, organizationId, externalIdentifiers[] (MRN + system, FHIR-sourced), matchConfidence

Encounter
  id, patientId, source (manual|FHIR), sourceSystem, occurredAt, provenance

Consent
  id, patientId, scope (ai-assistance|remote-model-use|research), grantedAt, revokedAt?, method

ModelVersion
  id, provider, modelId, versionLabel, approvedUseCases[], approvedBy, approvedAt,
  evaluationReportRef, retiredAt?

ClinicalReview
  id, targetType (chat-message|clinical-note), targetId, reviewerId, outcome
  (approved|rejected|amended), reviewedAt, notes

AuditEvent (extends current AuditEvent — audit-log-store.ts)
  ...existing fields..., actorUserId (was absent — now populated), organizationId,
  previousEventHash, eventHash, signature?
```

`Patient`/`Encounter`/`Consent` are new concepts — today's `PatientCase` is a
**case workspace**, not a longitudinal patient record; the two are related but
distinct, and this model treats `PatientCase` as remaining the app's local working
document while `Patient`/`Encounter` become the institutional-record-linkage layer
introduced in Phase 4.

---

## 8. Clinical evaluation strategy

1. **Intended-use statement** (deliverable, not just a README line): specific
   clinical workflows in scope (e.g. "SOAP note drafting from clinician-entered
   findings"), explicitly out-of-scope workflows (autonomous diagnosis,
   prescribing, ordering — already correctly excluded by design), and target user
   population.
2. **Reference dataset**: representative, de-identified or synthetic cases spanning
   the intended-use workflows, with clinician-adjudicated reference answers
   (multiple independent clinicians per case, disagreement-resolution process
   documented).
3. **Metrics**: harmful-omission rate (did the response miss something a clinician
   would flag as safety-critical), hallucination rate (unsupported claims), citation
   accuracy (does `checkCitations`'s unverified-marker rate correlate with actual
   fabrication), abstention correctness (does the system correctly say "insufficient
   information" when it should), and where applicable to a specific workflow,
   sensitivity/specificity/calibration.
4. **Subgroup evaluation**: performance broken out by age, sex, language (en/tr, per
   the app's existing i18n support), specialty, and care setting — only where
   legally and scientifically appropriate for the specific workflow being evaluated,
   per the request's own caveat.
5. **Acceptance thresholds**: defined *before* the evaluation runs, by clinical
   stakeholders, not derived post-hoc from whatever the model achieves.
6. **Prospective silent-mode pilot**: the system runs alongside real clinical
   workflows without its output being acted upon, logged and later compared against
   what clinicians actually did — this is the step between "the demo works" and
   "clinicians can see this in their workflow."
7. **Human-factors/usability validation**: does a clinician under real time pressure
   correctly notice the "Not verified" badge, the emergency banner, and the
   medication-conflict caveat, or does alert fatigue cause them to be ignored — this
   requires observed usability sessions, not a code review.

This entire section is **[CLIN]** — engineering's role is building the
instrumentation (structured logging, the review/adjudication UI referenced in
Phase 6) that makes each step *measurable*, not conducting the study itself.

---

## 9. Regulatory-readiness matrix

| Jurisdiction | Key requirements | Current status | Gap |
|---|---|---|---|
| **Türkiye — KVKK** | Data controller/processor registration (VERBİS), explicit consent for sensitive (health) data processing, cross-border transfer restrictions, breach notification | Not addressed | No consent-capture mechanism (§7 `Consent` model is proposed, not built), no VERBİS registration (institutional/legal, not code), cross-border transfer control depends on data-residency (§5, not built) |
| **Türkiye — Ministry of Health** | e-Nabız/SBYS integration requirements where applicable, local data-residency expectations for health data | Not addressed | Requires explicit MoH engagement; out of engineering scope entirely |
| **US — HIPAA/HITECH** | Administrative/physical/technical safeguards, BAAs with any subprocessor (including model providers), breach notification, minimum-necessary access | Encryption-at-rest partial (§2.3), audit partial (§2.4), no BAA-tracking metadata, no RBAC/minimum-necessary enforcement (§2.1) | P0 items above (identity, RBAC, full-store encryption, tamper-evident audit) are direct prerequisites; BAA execution with each model provider is a legal step this document cannot complete |
| **US — FDA (Clinical Decision Support)** | 21st Century Cures Act CDS exemption criteria (does the system tell the clinician the basis for its recommendation and allow independent review, without solely relying on the software) — or, if not exempt, device classification | The product's design (structured contract requiring evidence/uncertainty, explicit non-autonomous framing, "Not verified" badging) is **consistent with** the non-device CDS exemption criteria as currently understood, but this is not a legal determination | Requires formal regulatory counsel review of the specific intended-use statement (§8) against current FDA CDS guidance — this is a **[LEGAL]** determination, not something this assessment can certify |
| **EU — GDPR** | Lawful basis for special-category (health) data, DPIA for high-risk processing, data subject rights (access/erasure/portability), DPO where applicable | No DPIA performed, no data-subject-rights tooling (export exists per-session but not as a formal "right of access" workflow) | Erasure is possible (`deleteCase`) but not audited as a formal GDPR-erasure-request workflow; DPIA is a **[LEGAL]** deliverable |
| **EU — MDR/IVDR** | Medical device classification if the system's output directly drives a clinical decision without adequate independent clinician review | Same exemption-consistent design as the FDA CDS analysis above | Same caveat: **[LEGAL]** determination required, not an engineering conclusion |
| **EU — AI Act** | High-risk classification likely for AI used in healthcare decision-support; if high-risk, requires risk management system, technical documentation, human oversight, accuracy/robustness testing, logging | Human-oversight design intent exists (non-autonomous framing); risk-management system, technical documentation, and accuracy/robustness testing (§8) do not yet exist | Classification itself is a **[LEGAL]** determination; the technical-documentation and logging requirements substantially overlap with §2.4/§2.8/§2.9's gaps above |

**No claim of compliance with any of the above is made by this document.** Every row
states current gaps against the requirement, not a certification.

---

## 10. Controls that cannot be solved through code alone

- Clinical validation, accuracy/safety studies, subgroup evaluation, acceptance
  thresholds (§8) — **[CLIN]**.
- Licensed terminology (SNOMED CT/LOINC/RxNorm/UMLS) and licensed medication-
  interaction databases (§2.6, §2.7) — **[DATA]**.
- BAAs/DPAs with model providers, VERBİS registration, FDA/MDR/AI-Act
  classification, DPIA, accessibility certification (VPAT) — **[LEGAL]**.
- Identity provider selection/operation, KMS/HSM provisioning, backup
  infrastructure, network topology, code-signing certificate issuance,
  data-residency hosting decisions — **[CFG]**, i.e. real infrastructure and
  institutional process, not application code.
- Deciding acceptable risk posture for Windows agent-mode sandboxing (denylist-only
  vs. investing in a real OS-level confinement mechanism) is ultimately a
  risk-acceptance decision for whoever deploys the product, informed by but not
  resolved by engineering.

## 11. Tests required for every proposed control

| Control area | Test types required |
|---|---|
| Identity/RBAC | Unauthorized-access rejection tests per role/scope combination; break-glass justification-required test; session-revocation-takes-effect test |
| Central policy | Signature-verification-failure rejection test; expired-policy grace-period test; offline-then-reconnect policy-refresh test |
| PHI encryption | Round-trip tests per newly-encrypted store (mirroring `case-encryption.test.ts`'s pattern already in the repo); tamper-detection tests (GCM auth-tag failure, as already exists for case encryption) |
| Tamper-evident audit | Hash-chain-break-detection test; out-of-band-edit-detection test; concurrent-write-ordering test |
| Model/MCP governance | Non-approved-model-not-selectable test; policy-revocation-takes-effect test; denylist-enforcement test (mirroring `mcp-client.test.ts`'s existing `blockedTools` suite) |
| FHIR integration | Read-only enforcement test (no write-capable code path exists at all); patient-matching accuracy test against synthetic data; provenance-tagging-present test on every imported field |
| Medication safety abstraction | Adapter-swap test (demonstration table vs. mock licensed adapter produce compatibly-shaped results); "never treat absence of warning as clearance" — a UI test asserting the disclaimer text is always present alongside any conflict-check result, including zero-warning results |
| Output structured validation | Missing-section-detection test; citation-verification test (extending the existing but unwired `checkCitations` test coverage into an integration test through the chat UI) |
| Backup/restore | Full restore-from-backup integration test against a synthetic dataset; encrypted-backup-cannot-be-read-without-key test |
| Accessibility | Automated WCAG audit (axe-core or equivalent) in CI; `aria-live` announcement test for emergency banner |

Every test category above should follow the existing repository convention: real
logic exercised against synthetic fixtures only (as `medical-safety.test.ts`,
`evidence-store.test.ts`, and `patient-cases-store.test.ts` already do), colocated
`*.test.ts` files, no test ever touching real patient data.

## 12. Deployment decision

Per the requested classification, and strictly on the evidence gathered in this
assessment:

> **Research and clinician-supervised evaluation only.**
> **Not for autonomous clinical decisions, production dependency, or use with
> identifiable patient data**, until the Phase 1-2 P0 items above (verified
> identity, RBAC, tamper-evident audit with authenticated actors, and complete
> PHI-store encryption) are demonstrably satisfied — not merely implemented, but
> verified by the acceptance criteria listed in §6.

This matches the deployment-decision options given as: **not yet even "de-identified
pilot"-ready**, because de-identification itself is regex-only and non-clinical-grade
(§2.3), and a pilot using de-identified data still needs the audit-integrity and
access-control foundation (§2.1, §2.4) to be trustworthy as a pilot at all. The
correct entry point today is **synthetic-data research and internal clinician
evaluation only**, exactly as this repository's own test suites already do.
