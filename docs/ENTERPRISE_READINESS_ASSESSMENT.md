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

### 2.2 Central institutional administration — **signed local policy done; network push/RBAC still absent**

**Done, this engagement**: `app/src/policy-store.ts` — a signed, versioned JSON
policy document an institution's admin tooling drops at a fixed, OS-conventional,
machine-wide directory (distinct from Electron's per-user `userData`, so a
device's own user can't edit or delete their own governance policy without OS-level
admin rights — see `docs/CENTRAL_POLICY.md` for the full trust-model writeup). The
app verifies an Ed25519 signature against a trusted public key co-located with the
policy, enforces expiry with a 7-day grace period, and — critically — **falls back
to the last-known-good verified policy rather than reverting to local control**
when a later read is invalid (tampered, corrupted, or expired past grace): this is
the specific fail-closed property that stops "corrupt the policy file" from being
an effective way to escape governance. `settings-store.ts`'s `getSettings()`/
`saveSettings()` are the single choke point every caller in the app already shares
(confirmed: `agent-tools.ts`'s network-tool gate reads `getSettings()` directly),
so a managed field's value always wins on read and can't be persisted to
`settings.json` on write, regardless of which code path attempts it — not just a
UI-level restriction. Settings → Audit & Privacy shows the live policy state
(Active/Expired-grace/Invalid/Not configured), issuer, expiry, and which specific
settings are currently locked, with the corresponding controls actually disabled
in the UI (confirmed: the audit-log retention `<select>` and case auto-lock
`<select>` are wired to this).

**Still absent**: this is a *pull, not push* model — no live revocation (a new
policy takes effect the next time the local file is re-checked, not instantly
across a fleet), no per-user/per-role policy (one policy per device, since there's
no identity system to scope it by — see §2.1), and only a small, deliberately
curated subset of `AppSettings` is governable (`MANAGED_SETTING_KEYS` in
`policy-store.ts` — network tools, verification loop/step limit, case auto-lock,
redact-before-remote-send, audit retention/backend, medication-safety provider
and patient-cases backend selection), not the full settings surface. There is
still no organization/tenant concept, no admin console (policy authoring is a
CLI script — `app/scripts/sign-policy.js` — an admin runs locally, not a hosted
UI), and no MDM-integrated distribution (an institution's own configuration-
management tooling must place the two files at the documented OS path).
**[SW+CFG]**: the signed-policy mechanism itself is now built; MDM distribution
tooling, a hosted policy-authoring console, and live push/revocation remain
**[CFG]** institutional/infrastructure work layered on top of a real, working
verification-and-enforcement foundation rather than a stub.

### 2.3 PHI and sensitive-data protection — **on-disk content and JSON exports now covered; Markdown export and OS-level surfaces remain open**

**PHI-bearing stores identified by inspection:**

| Store | File | PHI risk | Encryption today |
|---|---|---|---|
| Patient cases | `patient-cases.json` / `.enc.json` | High — allergies, meds, conditions, notes | **Yes**, opt-in AES-256-GCM (`case-encryption.ts`) |
| Chat sessions | `sessions-store.ts` → `sessions.json` / `.enc.json` | High — case context gets pasted/typed directly into chat messages, model responses | **Yes** — shares `case-encryption.ts`'s gate (confirmed by inspection of `sessions-store.ts`; an earlier revision of this document incorrectly listed this as uncovered) |
| RAG-indexed document content | `rag-db.ts` → `rag.db` (`collections.name`, `documents.name`, `chunks.text`/`heading`) | High — folders a user points the app at can contain clinical documents | **Yes**, same passphrase/key as above. **Not** covered: `documents.path`/`collections.folder_path` (kept plaintext — they're SQL equality-lookup keys; AES-GCM's random IV breaks exact-match queries on ciphertext without a separate blind-index scheme, and a filename is a materially smaller leak than the extracted text) and `chunks.embedding` (not human-readable; needed in plaintext for similarity search) — both documented limitations in `rag-db.ts`, not oversights |
| Evidence sources | `evidence-store.ts` → `evidence-sources.json` | Low (URLs/metadata only, no patient data by design) | No (not needed) |
| Audit log | `audit-log-store.ts` → `audit-log.json` | Low by design (`detail` documented as non-clinical, never enforced at the type level) | No |
| Exported files | `data-transfer.ts`-driven exports (session/all export) | High | **Partial** — JSON exports (single session, all sessions) are encrypted with the same case-encryption session key when it's enabled, and refuse to write plaintext (`CaseDataLockedError`) if it's enabled but locked; import decrypts them the same way and fails closed (`EncryptedExportUnreadableError`) on a wrong passphrase or a disabled/locked store. Markdown export stays intentionally plaintext (it's a human-readable format by design) but now warns the user before writing one while case encryption is on. Prompt-preset export/import is unaffected — deliberately, since presets aren't patient data (see `data-transfer.ts`) |
| Electron cache/temp | Chromium's own disk cache, crash dumps | Unknown/high | **Not addressed at all** — outside this app's direct control without Electron-level hardening |
| Logs | `logger.ts` rotating file logs | Medium — a spot check found no store that logs message/case content directly (`patient-cases-store.ts`, `sessions-store.ts`, `rag.ts` make zero `logger.*` calls), but this is not a full audit | **Not addressed**; spot-checked only |
| Backups | None exist — no backup mechanism at all currently | N/A | N/A |

**Remaining concrete gap**: JSON export/import (`data-transfer.ts`'s
`serializeForExport`/`deserializeImportedPayload`) now closes the "encrypt every
store, then silently export a plaintext copy" hole for session data — there is no
patient-case export feature to have the same gap. Markdown export is a narrower,
accepted exception: it's inherently a plaintext, human-readable format, so it can't
be encrypted without defeating its own purpose, and the renderer now warns visibly
before writing one while case encryption is on rather than doing so silently. Worth
being explicit about the trade-off this makes: an encrypted export can only be
decrypted by importing it into a ModelForge install with case encryption enabled
and unlocked under the *same* passphrase active at export time — rotating the
passphrase re-encrypts the live stores in place, but a previously-exported file is
a static snapshot that migration never touches, and sharing an export with someone
who doesn't hold that passphrase isn't supported (that would need a real,
separately-designed "share outside the app" feature). Electron's own
cache/temp/crash-dump surfaces and full log-content auditing are also still open.
**[SW]** a full temp-file/cache/log audit is buildable; **[CFG]** enterprise key
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
drug-interaction database (e.g. First Databank, Lexicomp, Multum)."*
`checkMedicationConflicts()` now returns a structured `MedicationSafetyResult`
(provider identity, a `status` of demonstration/clinically-authoritative/
unavailable/failed, and static limitations text) rather than a bare warnings
array, specifically so an empty result can never be rendered or read as "verified
safe." `PatientCaseDetail.tsx` (`medicationConflictCheckInputSchema`-validated at
the IPC boundary) renders four distinct states from it — matches found (labeled
with the provider and its limitations, e.g. *"...not a licensed drug-interaction
database..."*), checked with no matches (*"No matches found by \<provider\>; this
is not a clinical interaction check"*), unavailable/failed (an explicit failure
banner, never collapsing to a clean result), and not applicable (nothing
recorded). **This labeling is a real, load-bearing safety control** — it
correctly prevents the single most dangerous failure mode of a system like this
(silent false confidence from an absent warning) by making the limitation
unavoidably visible at the point of use. No cross-sensitivity beyond the three
allergy classes, no duplicate-therapy detection, no dose-range checking, no
renal/hepatic adjustment, no pregnancy/age/weight/pediatric logic, no formulary
support. **[DATA]**: a real medication-safety engine requires a licensed database
(First Databank/Multum/Lexicomp-class) — this is a data-licensing problem, not an
engineering one. **[SW]**: the *abstraction boundary* — a `MedicationSafetyProvider`
interface with a `coverage` field (`"demonstration"` vs. `"clinically-authoritative"`)
and an optional `isAvailable()` — already exists, with the current demonstration
table as the default implementation; a licensed-database adapter is pluggable per
institution behind that same interface without touching any call site.

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

### 2.10 Output safety — **partial, structural validation now closed**

What exists: the 8-section response contract (prompt-level — a model can still fail
to follow it, so this alone is not enforcement), pre-model deterministic emergency
detection (`checkForEmergencyFlags` — genuinely model-independent, a real control),
the "Not verified" badge on every assistant message (`Chat.tsx`'s `MessageBubble`),
transmission preview before remote sends, a citation-verification function
(`checkCitations`, `medical-safety.ts`) wired into the chat UI via
`CitationCheckNotice` (`Chat.tsx`) — an unverified marker or an uncited clinical
claim is flagged inline, not just internally computed — and, closing the specific
gap this section previously flagged, structured-output validation against the
8-section contract itself: `checkResponseContractCompliance`
(`frontend/src/lib/clinical-constants.ts`) parses a completed response for all
eight required headings and `ResponseContractNotice` (`Chat.tsx`) flags exactly
which ones a response silently dropped, applicable only when the response clearly
attempted the structured format at all (avoiding false positives on short
non-clinical replies). Both checks are deterministic and client-side, independent
of the model. **Remaining gap**: no abstention enforcement (a model can answer
confidently even when the contract asks it to say "insufficient data" — this is a
*content* judgment, not a structural one, and isn't something section-heading
matching can catch). No mechanism requires an identifiable clinician's sign-off
before a model-drafted note (e.g. a SOAP note) is treated as final —
`ClinicalNote.author` (`patient-cases-store.ts`) does distinguish
`"clinician" | "model-inference"` provenance, which is good, but nothing *enforces*
a review step before a model-inference note could be acted on. **[SW]**: a
review/sign-off gate on `clinicalNotes` is directly buildable now; abstention
enforcement would need model-output content analysis, a materially different (and
harder to get right without false positives) problem than the structural checks
above.

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

### 2.12 Operational readiness — **backup now done; CI supply-chain gaps partially closed**

No centralized monitoring (single-device app, nothing to centralize into). No HA
concept (desktop app).

**Done, this session**: `app/src/backup-store.ts` — encrypted, whole-profile
backup and verified restore, covering every file this app persists (patient
cases, chat sessions, audit log, and the rest — see `docs/BACKUP_RESTORE.md`
for the full inventory and rationale). Uses its own passphrase, a separate
encryption domain from case-encryption's. Restore is a three-phase design
(decrypt-and-validate-first, an automatic pre-restore safety snapshot, then
staged-and-verified writes) specifically so a bad restore is itself
reversible, and a wrong passphrase or corrupted file never touches live data.
Backups can be manual or scheduled (`app/src/backup-scheduler.ts`) — turning
scheduling on gives a real, operator-defined RPO of at most the configured
interval, rather than "however long since your last manual backup." Both
remain **app-open only** (no OS-level task registration, same limitation as
`scheduler.ts`'s agent-prompt scheduling), and the automatic-backup
passphrase is stored in the OS keychain (same mechanism as provider API
keys) to run with nobody present — a different, explicitly-stated trust
model than manual backups' never-touches-disk passphrase. An optional
secondary cloud destination (`app/src/cloud-backup-store.ts`, any
S3-compatible object store, best-effort and independent of local-write
success) is also available. Compression (gzip per file before the
encrypted envelope) cuts typical backup size well below the previous
~1.33x-of-live-data figure. Full detail in `docs/BACKUP_RESTORE.md`'s RPO
and cloud-destination sections.

**Corrected from an earlier stale claim in this document**: `.github/dependabot.yml`
already exists and is comprehensive (weekly updates across every npm
workspace, `cargo`, `pip`, and `github-actions` itself) — see
`docs/HARNESS_INTEGRATION.md` §1.3 for the full re-verification. `SBOM
generation` also already exists (`.github/workflows/ci.yml`'s `sbom` job,
CycloneDX per workspace). **Still genuinely absent**: no SAST, no dedicated
secret-scanning step, no license-policy gate, no `SECURITY.md`/`CODEOWNERS`.
`electron-builder` update signing remains explicitly **not configured** —
`docs/DEVELOPMENT.md`'s own "Adding signing later (not currently configured)"
section confirms every installer today ships with an "unknown publisher"
warning, and `electron-updater` (present in `app/package.json`) auto-updates
without a code-signing chain of trust in place.
**[SW]**: a documented incident-response runbook is still directly buildable
now (not yet done). **[CFG]**: code-signing certificates and a *scheduled*
backup policy (today's is manual-only) are institutional decisions layered on
top of the buildable mechanism that now exists.

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
| Central policy admin | **Done (signed local policy)** — `policy-store.ts`, fail-closed, `MANAGED_SETTING_KEYS` subset enforced at the `getSettings()`/`saveSettings()` choke point | Was Critical, now Medium (no live push/per-role scoping) | Remaining: MDM distribution tooling, live push/revocation, per-role policy (needs identity) | P1 | SW done; CFG (distribution) + SW (identity-scoped policy, blocked on §2.1) remain |
| Approved model registry | Free-text model string, no governance | High | Curated, admin-approved model list | P0 | SW+CLIN |
| MCP/endpoint allowlist | User can add any MCP server locally | High (institutional context) | Admin-scoped allowlist enforcement | P0 | SW+CFG |
| PHI inventory/encryption | Patient cases, chat sessions, and RAG-indexed content (text/names, not paths/embeddings — see §2.3) now share one encryption gate; JSON session exports/imports now ride the same gate (§2.3); Markdown export stays plaintext by design with a visible warning; logs and OS-level cache/temp remain uncovered | High (was Critical) | Audit temp/cache/log paths | P0 | SW |
| Enterprise key management | Passphrase-derived key, session-memory only, no rotation | High | KMS/HSM-backed key option for institutional deployments | P0 | SW+CFG |
| Secure deletion | Plain file delete (`fs.rmSync`) | Medium | Document as best-effort; true secure-erase is filesystem/disk-dependent | P1 | SW+CFG |
| Backup encryption | **Done** — `backup-store.ts`, own passphrase (separate domain from case encryption), 3-phase verified restore with automatic pre-restore safety snapshot | Was High, now Low | Remaining: scheduled/automatic backups (today's is manual-only, by design — see `docs/BACKUP_RESTORE.md`) | P1 | SW done; CFG (a scheduling/reminder policy) remains |
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
| Output structured validation | ~~Prompt-only contract, not enforced~~ **Done** — `checkResponseContractCompliance` + `checkCitations`, both wired into `Chat.tsx` | — | Remaining: abstention enforcement (content-level, not structural — see §2.10) | P1 | SW |
| Windows agent sandboxing | Denylist only, no OS-level confinement | High (Windows installs specifically) | Document as risk; evaluate AppContainer/Job Object confinement | P1 | SW+CFG |
| SBOM / dependency scanning | None found in CI | Medium | Add SBOM generation + Dependabot to CI | P1 | SW |
| Update signing | Not configured (`docs/DEVELOPMENT.md` confirms) | Medium | Configure code-signing certificates | P1 | CFG |
| Accessibility (WCAG 2.2 AA) | Ad hoc, undocumented gaps | Medium | Full audit + remediation pass | P2 | SW+LEGAL (certification) |

---

## 4. Threat model

| Threat | Current exposure | Mitigations present | Mitigations missing |
|---|---|---|---|
| **PHI exposure via stolen/lost device** | Medium — patient cases, chat sessions, and RAG-indexed content now share one encryption gate (§2.3); JSON session exports/imports now ride the same gate; Markdown export and OS-level cache/temp/logs remain unencrypted | Case-encryption covers `patient-cases.json`, `sessions.json`, `rag.db` content, and JSON session exports; OS-level disk encryption is the user's own responsibility (documented) | Temp/cache/log hardening, remote wipe, MDM integration |
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

> A concrete, implementation-ready design for the patient-case-storage slice of this
> architecture — deployment topology, auth, API shape, conflict handling, migration,
> audit-shipping — now exists in **[docs/SHARED_BACKEND_DESIGN.md](SHARED_BACKEND_DESIGN.md)**,
> written against the `PatientCasesBackend` configuration-boundary interface added to
> `patient-cases-store.ts` after this assessment was originally written. That document
> accepts the target architecture below as given rather than re-deriving it.

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
  `rag.ts` embeddings, Markdown export, logs, Electron cache/temp).
- Decide target architecture posture (single-device-only vs. control-plane-backed —
  §5) — **this is a product decision, not an engineering one**, and everything
  downstream depends on it.
- **Acceptance criteria**: written PHI inventory covering every store with
  encryption status; a signed-off target-architecture decision document.

### Phase 1 — Identity, RBAC, central policy (P0)
- Depends on: Phase 0's architecture decision.
- OIDC relying-party integration; role model (clinician/admin/researcher/
  auditor/support) with `patient-level`/`department-level` scoping; break-glass
  flow with mandatory justification text, itself an audited event.
- **Done, ahead of the identity dependency** (§2.2): the *policy* half of this
  phase — signed-document fetch-and-cache with signature verification, expiry,
  and grace-period fail-closed behavior (`policy-store.ts`) — turned out not to
  require identity as a prerequisite (a policy document doesn't need to know
  *who* the user is, only that it's genuinely from the institution), so it's
  built and enforced today against a curated settings subset. What's still
  gated on identity: *per-role* policy (today's policy is per-device, not
  per-user/role, since there's no identity to scope it by) and live network
  push/revocation (today's is a local, periodically-re-checked file).
- **Acceptance criteria**: no PHI-bearing action is reachable without a verified
  identity and a role check — **open**; break-glass access is itself audit-logged
  with the justification text — **open**; a revoked policy takes effect within
  the defined grace period even offline-then-reconnected — **met** for the
  local-file policy mechanism (`policy-store.ts`'s 7-day grace period,
  `policy-store.test.ts`'s expiry/fallback tests), not yet for a networked
  push scenario since there's no network delivery mechanism built.

### Phase 2 — Tamper-evident audit + PHI encryption completion (P0)
- Depends on: Phase 1 (for authenticated actors on every event).
- **Done** (audit): every audit event is hash-chained (`audit-log-store.ts`'s
  `previousEventHash`/`eventHash`, `verifyChainIntegrity()`) — an out-of-band edit
  to the local log is detectable. Central audit shipping with local buffering
  remains open (needs Phase 1 identity to populate an authenticated actor — see
  `docs/SHARED_BACKEND_DESIGN.md` §7 for the client-side design).
- **Done** (encryption): `sessions.json` and RAG-indexed document content
  (`rag.db`) now share `patient-cases.json`'s encryption gate (§2.3). JSON
  session exports/imports (`data-transfer.ts`) now ride the same gate too —
  encrypted on export when enabled, fail closed (not plaintext) when enabled
  but locked, and import fails closed on a wrong passphrase rather than
  silently importing garbage or reporting "nothing found."
- **Remaining**: Markdown export stays plaintext by design (see §2.3) — a
  visible warning now stands in for encryption there, since the format can't
  be encrypted without defeating its purpose. Any PHI-bearing cache/temp path
  found in a full Phase 0 inventory pass is still plaintext.
- **Acceptance criteria**: any out-of-band edit to the local audit log file is
  detectable — **met**; every store in the Phase 0 inventory marked "PHI: high" is
  encrypted at rest — **met except Markdown export (by design) and cache/temp**;
  audit events survive a network outage and ship on reconnection without loss or
  duplication — **open**, depends on Phase 1.

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
- **Done**: structured-response validation against the 8-section contract
  (`checkResponseContractCompliance`) and citation verification (`checkCitations`)
  are both wired into the chat UI (`Chat.tsx`'s `ResponseContractNotice` /
  `CitationCheckNotice`) — a response missing a required section, or citing a
  source with no match, is flagged inline rather than passing silently.
- **Remaining**: evidence-grading labels in Evidence Library; a review/sign-off
  gate before a `clinicalNotes` entry with `author: "model-inference"` is treated
  as final.
- **Acceptance criteria** *(met for the structural checks above; still open for
  the remaining items)*: a response missing a required contract section is
  visibly flagged, not silently accepted — **met**; an unresolvable citation
  marker is rendered as unverified in the transcript, not just internally
  computed — **met**; evidence-grading and note-review sign-off remain open.

### Phase 7 — Operational readiness (P1)
- Depends on: Phase 2 (backup must cover the now-fully-encrypted stores) — met,
  `backup-store.ts` covers every file each store persists, encrypted or not.
- **Done**: encrypted backup mechanism (`backup-store.ts`) — own passphrase,
  verified restore, automatic pre-restore safety snapshot for rollback;
  scheduled backups (`backup-scheduler.ts`) give RPO a real, operator-defined
  number instead of "manual, user-controlled"; an optional S3-compatible
  cloud destination (`cloud-backup-store.ts`) for a secondary off-device
  copy; SBOM (`ci.yml`'s `sbom` job) and Dependabot (`.github/dependabot.yml`)
  were already present, corrected from this document's earlier stale claim
  (§2.12).
- **Remaining**: scheduled backups are still app-open only, no OS-level task
  registration — a device off/asleep longer than the configured interval
  still has a gap `docs/BACKUP_RESTORE.md` states honestly rather than
  papering over; code-signing for releases; a documented incident-response
  runbook; SAST/secret-scanning in CI (still absent, unlike SBOM/Dependabot).
- **Acceptance criteria**: a restore-from-backup drill succeeds against a
  synthetic dataset — **met**, `backup-store.test.ts`'s round-trip and
  rollback tests plus `e2e/tests/backup-restore.spec.ts`; CI fails the build
  on a newly-disclosed critical CVE in a direct dependency — **open** (no
  SAST/vulnerability-scanning gate exists yet, only Dependabot's
  version-currency alerts).

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
| Central policy | **Done**: signature-verification-failure rejection (`policy-store.test.ts` — wrong key, tampered payload, non-canonical bytes, unrecognized settings field), expired-policy grace-period behavior, and last-known-good fallback on a later invalid read, all covered at the unit level plus an end-to-end Playwright pass (`e2e/tests/central-policy.spec.ts`) through the real Settings UI. Remaining: an offline-then-reconnect *network* policy-refresh test once a networked push mechanism exists (today's mechanism is a local file, so this doesn't yet apply) |
| PHI encryption | Round-trip tests per newly-encrypted store (mirroring `case-encryption.test.ts`'s pattern already in the repo); tamper-detection tests (GCM auth-tag failure, as already exists for case encryption) |
| Tamper-evident audit | Hash-chain-break-detection test; out-of-band-edit-detection test; concurrent-write-ordering test |
| Model/MCP governance | Non-approved-model-not-selectable test; policy-revocation-takes-effect test; denylist-enforcement test (mirroring `mcp-client.test.ts`'s existing `blockedTools` suite) |
| FHIR integration | Read-only enforcement test (no write-capable code path exists at all); patient-matching accuracy test against synthetic data; provenance-tagging-present test on every imported field |
| Medication safety abstraction | Adapter-swap test (demonstration table vs. mock licensed adapter produce compatibly-shaped results); "never treat absence of warning as clearance" — a UI test asserting the disclaimer text is always present alongside any conflict-check result, including zero-warning results |
| Output structured validation | **Done**: missing-section-detection unit tests (`Chat.clinical.test.ts`) and e2e coverage through the real chat UI (`e2e/tests/response-contract-notice.spec.ts`, `chat-streaming.spec.ts`) for both `checkResponseContractCompliance` and `checkCitations` |
| Backup/restore | **Done**: full round-trip restore, wrong-passphrase rejection (with zero live-file side effects), tampered/corrupted backup rejection (GCM auth tag), checksum-mismatch rejection independent of the auth tag, path-traversal-shaped file name rejection, stale-counterpart cleanup on encrypted/plaintext mode mismatch, and rollback-via-safety-snapshot — all in `backup-store.test.ts` (12 tests), plus a real-UI pass in `e2e/tests/backup-restore.spec.ts` |
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
