import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { readJsonWithSchema, readJson, writeJson } from "./json-store";
import { patientCasesFileSchema, type labResultSchema, type clinicalNoteSchema, type attachmentRefSchema, type caseConsentSchema } from "./schemas";
import * as caseEncryption from "./case-encryption";
import { CaseDataLockedError } from "./case-encryption";
import type { EncryptedPayload } from "./case-encryption";
import type { z } from "zod";
import type {
    AttachmentRef,
    CaseConsent,
    ClinicalNote,
    LabResult,
    PatientCase as SharedPatientCase,
} from "@modelforge/contracts";

// Re-exported for backward compatibility — this store's own callers/tests
// catch `CaseDataLockedError` from here; the class itself now lives in
// case-encryption.ts since sessions-store.ts uses the exact same encryption
// gate and error.
export { CaseDataLockedError };

export type { AttachmentRef, CaseConsent, ClinicalNote, LabResult };

export interface CaseField<T> {
    value: T;
    includeInContext: boolean;
}

export type PatientCase = SharedPatientCase;

function filePath(): string {
    return path.join(app.getPath("userData"), "patient-cases.json");
}

// A separate physical file for the encrypted form, rather than a discriminated
// field inside patient-cases.json — this way the plaintext file's schema
// never has to accommodate "or maybe it's actually an encrypted blob", and
// switching modes is just "which of these two files is authoritative right
// now", with the other one deleted so stale plaintext never lingers next to
// a newly-encrypted copy (or vice versa).
function encryptedFilePath(): string {
    return path.join(app.getPath("userData"), "patient-cases.enc.json");
}

function removeIfExists(target: string): void {
    try {
        fs.rmSync(target, { force: true });
    } catch {
        // Best effort — leftover stale file is a cleanliness issue, not a
        // correctness one, since only one path is ever read as authoritative.
    }
}

// consentRecords is optional in the on-disk schema (so a case saved before
// this field existed still validates instead of getting backed-up-and-reset
// — see json-store.ts) but every in-memory PatientCase this store hands out
// guarantees a real array, so every caller can rely on it without an `?? []`
// at every use site.
function normalize(raw: z.infer<typeof patientCasesFileSchema>[number]): PatientCase {
    return { ...raw, consentRecords: raw.consentRecords ?? [] };
}

// In-process read cache — same rationale and safety argument as
// sessions-store.ts's identical cache (this module is the sole writer of
// patient-cases.json/.enc.json, so the cache can't drift from disk within a
// running process; every encryption transition other than locking already
// calls overwriteAllCases() right after, which repopulates the cache via
// writeAll()). Also skips re-running schema validation + normalize() on
// every single read, not just the disk I/O and decrypt.
//
// Unlike sessions-store.ts, writes here aren't debounced — case edits come
// from a deliberate form save, not a tight per-tool-call agent loop, so
// there's no equivalent hot path to coalesce.
let cache: PatientCase[] | null = null;

/** Drops the cached array without touching disk. Called automatically via
 * caseEncryption.onBeforeLock (registered below) — see sessions-store.ts's
 * identical registration for why this must be structural rather than
 * depending on every caller of lock() remembering to clear both stores'
 * caches in the right order. Safe to call at any other time too; the next
 * read just repopulates it. */
export function clearCache(): void {
    cache = null;
}

// `async` even though every step here is synchronous I/O — this is the
// local backend's implementation of PatientCasesBackend.readAll(), and that
// interface is `Promise`-returning throughout (see the interface's own doc
// comment) so it can also be satisfied by a real network-backed
// implementation. Wrapping already-synchronous logic in `async` costs
// nothing but a microtask tick; the alternative (a sync-only interface) is
// what made this file's `readSince`/`writeOne`/`deleteOne` additions
// impossible for any real HTTP backend to actually implement.
async function readAll(): Promise<PatientCase[]> {
    if (caseEncryption.isEnabled() && !caseEncryption.isUnlocked()) throw new CaseDataLockedError();
    if (cache !== null) return cache;

    if (caseEncryption.isEnabled()) {
        const payload = readJson<EncryptedPayload | null>(encryptedFilePath(), null);
        if (!payload) {
            cache = [];
        } else {
            const parsed: unknown = JSON.parse(caseEncryption.decrypt(payload, caseEncryption.getSessionKey()!));
            const result = patientCasesFileSchema.safeParse(parsed);
            cache = result.success ? result.data.map(normalize) : [];
        }
    } else {
        cache = readJsonWithSchema<PatientCase[]>(filePath(), [], patientCasesFileSchema as unknown as z.ZodType<PatientCase[]>).map(normalize);
    }
    return cache;
}

async function writeAll(cases: PatientCase[]): Promise<void> {
    if (caseEncryption.isEnabled()) {
        if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
        const payload = caseEncryption.encrypt(JSON.stringify(cases), caseEncryption.getSessionKey()!);
        writeJson(encryptedFilePath(), payload);
        removeIfExists(filePath());
    } else {
        writeJson(filePath(), cases);
        removeIfExists(encryptedFilePath());
    }
    cache = cases;
}

// See sessions-store.ts's identical registration for the full rationale.
caseEncryption.onBeforeLock(() => clearCache());

// --- Persistence backend seam (configuration boundary) ----------------------
//
// This app is single-user, local-first by default: `localPatientCasesBackend`
// below (this file's own encryption-aware readAll/writeAll) is the only
// backend registered, and it's what every install actually runs. The
// interface exists as a documented plug point for a *shared* backend a real
// deployment could add — a care team needing one centralized case list
// instead of N scattered local files, or IT backing a fleet of installs with
// one managed database — without touching any of the business logic below
// (createCase, updateCase, consent/note tracking, etc.), all of which goes
// through `getPatientCasesBackend()` rather than a concrete implementation.
// A real HTTP-backed implementation exists — shared-patient-cases-backend.ts
// — built against this exact interface.
export type PatientCasesBackendScope = "local" | "shared";

// Thrown by a shared backend's readAll/readSince on any network failure,
// timeout, or non-2xx response — mirroring CaseDataLockedError's shape and
// purpose in case-encryption.ts. Never collapse a reachability failure to an
// empty array: "no cases" and "couldn't reach the server" must never look
// the same to a clinician. See docs/SHARED_BACKEND_DESIGN.md §3.
export class SharedBackendUnavailableError extends Error {
    constructor(message = "The shared patient case backend is unavailable — check connectivity or backend configuration.") {
        super(message);
        this.name = "SharedBackendUnavailableError";
    }
}

// Thrown when a writeOne/deleteOne call's expectedVersion no longer matches
// the backend's current version of the case — i.e. someone else wrote to it
// first. Carries the backend's current copy so a caller (ultimately the
// renderer, via the same unhandled-rejection path CaseDataLockedError
// already uses across the IPC boundary) can show it in a reload/reconcile
// prompt. Deliberately never auto-resolved here or anywhere in this file —
// see docs/SHARED_BACKEND_DESIGN.md §5 for why silent/automatic merging is
// rejected for this data.
export class CaseWriteConflictError extends Error {
    constructor(public readonly current: PatientCase) {
        super("This case was updated by someone else since it was loaded — reload and reapply your changes.");
        this.name = "CaseWriteConflictError";
    }
}

export interface PatientCasesBackend {
    /** Stable machine identifier, e.g. "modelforge-local-json". */
    readonly name: string;
    /** Human-readable label for display. */
    readonly label: string;
    /** "local": only this device. "shared": a networked backend a team/fleet points at — never inferred, always backend-declared. */
    readonly scope: PatientCasesBackendScope;
    /** Static caveat text shown alongside this backend regardless of outcome. */
    readonly limitations: string;
    /** Optional: lets a backend report itself as not currently usable (e.g. unauthenticated or unconfigured) so selection and UI can fail closed before an operation is attempted. */
    isAvailable?(): boolean;
    /** Every method is Promise-returning — even the local backend's, which
     * has nothing to actually await — so this interface can be satisfied by
     * a real network-backed implementation without a second, incompatible
     * shape. See shared-patient-cases-backend.ts. */
    readAll(): Promise<PatientCase[]>;
    writeAll(cases: PatientCase[]): Promise<void>;

    /**
     * Incremental sync: returns cases changed since `cursor` (opaque,
     * backend-defined — a server timestamp or monotonic counter) and the
     * cursor to pass next time. `cursor: null` means "everything". Optional
     * — every backend (including the local one) must still implement
     * readAll/writeAll as the required baseline; a backend that also
     * implements this is preferred by the read paths below for efficiency.
     * See docs/SHARED_BACKEND_DESIGN.md §3.
     */
    readSince?(cursor: string | null): Promise<{ cases: PatientCase[]; cursor: string; deletedIds?: string[] }>;

    /**
     * Single-case write with optimistic concurrency. `expectedVersion` is
     * the version the caller last saw (`null` for a case that shouldn't
     * already exist, i.e. a create). Returns the accepted case + its new
     * version, or `{ conflict: true, current }` with the backend's current
     * copy if `expectedVersion` is stale — the caller must never treat a
     * conflict result as success. See docs/SHARED_BACKEND_DESIGN.md §5.
     *
     * `idempotencyKey` (P1 item 5, case-offline-cache.ts): when present,
     * sent as an `Idempotency-Key` so a caller replaying the *same* logical
     * write (a queued outbox entry retried after a network blip) gets back
     * the original result instead of double-applying or a false conflict —
     * see server/src/routes/idempotency.ts, which already implements the
     * server side of this contract. Omitted by every call site that isn't
     * replaying anything; a fresh write needs no stable key.
     */
    writeOne?(
        patientCase: PatientCase,
        expectedVersion: string | null,
        idempotencyKey?: string
    ): Promise<{ patientCase: PatientCase; version: string } | { conflict: true; current: PatientCase }>;

    /**
     * Single-case delete with optimistic concurrency, mirroring writeOne's
     * conflict shape. Not part of docs/SHARED_BACKEND_DESIGN.md §3's original
     * TS interface snippet — added here to complete that same document's §3
     * HTTP API table, which already specifies `DELETE /cases/{id}` but left
     * no corresponding optional client method. A backend without this falls
     * back to readAll/writeAll for deletes, same as for every other mutation.
     *
     * `idempotencyKey`: accepted for the same reason and shape as writeOne's
     * (case-offline-cache.ts's outbox calls both uniformly), but note it is
     * currently inert server-side — server/src/routes/cases.ts's DELETE
     * handler doesn't call withIdempotencyKey (only POST/PUT do). Delete-
     * replay is already safe today through a different mechanism: this
     * interface's own contract that a 404 on retry means "already deleted,"
     * mapped to success rather than an error (see shared-patient-cases-
     * backend.ts's deleteOne). Sending the header anyway costs nothing and
     * means the client needs no change if the server ever does start
     * honoring it for DELETE too.
     */
    deleteOne?(id: string, expectedVersion: string | null, idempotencyKey?: string): Promise<{ deleted: true } | { conflict: true; current: PatientCase }>;
}

export const localPatientCasesBackend: PatientCasesBackend = {
    name: "modelforge-local-json",
    label: "Local (this device)",
    scope: "local",
    limitations:
        "Stores patient cases in a local file on this device only (optionally encrypted at rest via Settings → " +
        "Audit & Privacy) — not shared with any other device, user, or install. A shared backend for a care team " +
        "or managed fleet can be registered behind this same interface.",
    readAll,
    writeAll,
};

const patientCasesBackendRegistry = new Map<string, PatientCasesBackend>([[localPatientCasesBackend.name, localPatientCasesBackend]]);
let activePatientCasesBackend: PatientCasesBackend = localPatientCasesBackend;

/** Adds (or replaces) a backend in the registry, keyed by its `name`. Registering alone never changes which backend is active — see `selectPatientCasesBackend`. */
export function registerPatientCasesBackend(backend: PatientCasesBackend): void {
    patientCasesBackendRegistry.set(backend.name, backend);
}

function isPatientCasesBackendAvailable(backend: PatientCasesBackend): boolean {
    try {
        return backend.isAvailable?.() ?? true;
    } catch {
        return false;
    }
}

/** Every currently-registered backend's public identity and current usability — what a Settings UI lists to choose from. Never includes connection details or credentials. */
export function listPatientCasesBackends(): { name: string; label: string; scope: PatientCasesBackendScope; available: boolean }[] {
    return [...patientCasesBackendRegistry.values()].map((backend) => ({
        name: backend.name,
        label: backend.label,
        scope: backend.scope,
        available: isPatientCasesBackendAvailable(backend),
    }));
}

export function getPatientCasesBackend(): PatientCasesBackend {
    return activePatientCasesBackend;
}

/**
 * Makes the named registered backend active — the persisted, Settings-driven
 * selection path (AppSettings.patientCasesBackendId). Fails safe: an
 * unregistered name (a stale setting from a build that shipped a backend
 * this one doesn't, a typo) leaves whichever backend was already active
 * untouched and returns `false` rather than throwing or silently falling
 * through to some default — callers (main.ts at startup, settings:save) are
 * expected to log that case, not treat it as fatal.
 */
export function selectPatientCasesBackend(name: string): boolean {
    const backend = patientCasesBackendRegistry.get(name);
    if (!backend || !isPatientCasesBackendAvailable(backend)) return false;
    activePatientCasesBackend = backend;
    return true;
}

/** Reads the current case list under whichever *local* mode is active right
 * now (plaintext vs. encrypted) — used by the encryption setup/disable/
 * rotate-passphrase flows to move data between them. Deliberately always the
 * local file regardless of which PatientCasesBackend is active: at-rest
 * encryption is a local-storage-specific concern a shared backend would
 * handle its own way (e.g. TLS + server-side encryption), not something this
 * migration path should apply to a backend it knows nothing about. Same
 * locked-state guarantees as every other read: throws CaseDataLockedError
 * rather than returning an empty list if encryption is enabled but not
 * unlocked. */
export async function getAllCasesForMigration(): Promise<PatientCase[]> {
    return readAll();
}

/** Writes the given case list under whichever *local* mode is active right
 * now (plaintext vs. encrypted), same local-file-only scope as
 * getAllCasesForMigration() above — paired with it so a caller can read
 * under the old key/mode, change the key/mode, then write back under the
 * new one. */
export async function overwriteAllCases(cases: PatientCase[]): Promise<void> {
    return writeAll(cases);
}

// Full-read helper shared by listCases/getCase/mutateCase: prefers a
// backend's readSince(null) ("everything") over readAll() when available,
// since a backend implementing incremental sync is presumed to make that the
// cheaper/more current path — readAll() stays the required fallback for
// every backend that doesn't implement it (today, that's every registered
// backend; the local backend has no reason to).
const sharedSyncState = new WeakMap<PatientCasesBackend, { cursor: string | null; cases: Map<string, PatientCase> }>();

async function readAllCases(backend: PatientCasesBackend): Promise<PatientCase[]> {
    if (backend.readSince && backend.scope === "shared") {
        let state = sharedSyncState.get(backend);
        if (!state) {
            state = { cursor: null, cases: new Map() };
            sharedSyncState.set(backend, state);
        }
        const batch = await backend.readSince(state.cursor);
        for (const id of batch.deletedIds ?? []) state.cases.delete(id);
        for (const patientCase of batch.cases) state.cases.set(patientCase.id, patientCase);
        state.cursor = batch.cursor;
        return [...state.cases.values()];
    }
    if (backend.readSince) return (await backend.readSince(null)).cases;
    return backend.readAll();
}

export async function listCases(): Promise<PatientCase[]> {
    return (await readAllCases(getPatientCasesBackend())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Every read goes through this — never a raw array index or an unfiltered
// scan — so that a caller can only ever get back the one case it asked for,
// which is the actual guarantee behind "one patient's data never leaks into
// another case's context." Callers still must not blend two `PatientCase`
// objects together in one prompt.
export async function getCase(id: string): Promise<PatientCase | null> {
    return (await readAllCases(getPatientCasesBackend())).find((c) => c.id === id) ?? null;
}

/**
 * Applies `mutate` to the case with `id` and persists the result. When the
 * active backend supports writeOne, this reads the one case (via
 * readAllCases, still a bulk read today — see its own comment), mutates it,
 * and writes it back guarded by an optimistic-concurrency version — a
 * concurrent edit from elsewhere surfaces as CaseWriteConflictError rather
 * than being silently clobbered by a full-array writeAll racing another
 * writer. A backend without writeOne (today's local backend, which has
 * exactly one writer) falls back to the pre-existing read-all/mutate-in-
 * place/write-all path, unchanged in behavior.
 *
 * `expectedVersion` is the version *the caller* last saw this case at —
 * `undefined` (every call site in this codebase today; see each exported
 * function below) means the caller isn't tracking one, in which case this
 * falls back to whatever version the fresh read just above returned. That
 * fallback only guards against a write racing with this exact read/write
 * pair — it cannot detect "someone else changed this since a clinician
 * loaded the case in the UI," because nothing here knows what the UI last
 * displayed. Real protection against that requires a caller-supplied
 * version threaded through the IPC/renderer layer, which is not yet built
 * (see docs/SHARED_BACKEND_DESIGN.md §3's own "riskiest open decision" note
 * on this exact interface) — this parameter exists so that plumbing has
 * somewhere to land without another change to this function's shape.
 */
async function mutateCase(
    id: string,
    expectedVersion: string | null | undefined,
    mutate: (current: PatientCase) => PatientCase
): Promise<PatientCase | null> {
    const backend = getPatientCasesBackend();
    if (backend.writeOne) {
        const current = (await readAllCases(backend)).find((c) => c.id === id);
        if (!current) return null;
        const versionToCheck = expectedVersion !== undefined ? expectedVersion : (current.version ?? null);
        const result = await backend.writeOne(mutate(current), versionToCheck);
        if ("conflict" in result) throw new CaseWriteConflictError(result.current);
        return result.patientCase;
    }
    const all = await backend.readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    all[idx] = mutate(all[idx]);
    await backend.writeAll(all);
    return all[idx];
}

function emptyStringField(): CaseField<string> {
    return { value: "", includeInContext: false };
}

function emptyArrayField<T>(): CaseField<T[]> {
    return { value: [], includeInContext: false };
}

export async function createCase(title: string, enteredBy?: string): Promise<PatientCase> {
    const now = new Date().toISOString();
    const patientCase: PatientCase = {
        id: randomUUID(),
        title: title.trim() || "Untitled case",
        demographics: { value: {}, includeInContext: false },
        presentingComplaint: emptyStringField(),
        symptomsTimeline: emptyStringField(),
        vitalSigns: emptyStringField(),
        conditions: emptyArrayField(),
        allergies: emptyArrayField(),
        medications: emptyArrayField(),
        labResults: emptyArrayField(),
        imagingAndReports: emptyStringField(),
        clinicalNotes: [],
        attachments: [],
        consentRecords: [],
        enteredBy,
        createdAt: now,
        updatedAt: now,
    };
    const backend = getPatientCasesBackend();
    if (backend.writeOne) {
        // expectedVersion: null — this id must not already exist on the backend.
        const result = await backend.writeOne(patientCase, null);
        if ("conflict" in result) throw new CaseWriteConflictError(result.current);
        return result.patientCase;
    }
    const all = await backend.readAll();
    all.push(patientCase);
    await backend.writeAll(all);
    return patientCase;
}

export async function updateCase(
    id: string,
    partial: Partial<
        Pick<
            PatientCase,
            | "title"
            | "demographics"
            | "presentingComplaint"
            | "symptomsTimeline"
            | "vitalSigns"
            | "conditions"
            | "allergies"
            | "medications"
            | "labResults"
            | "imagingAndReports"
            | "clinicalNotes"
            | "attachments"
            | "consentNote"
            | "consentRecords"
        >
    >,
    expectedVersion?: string | null
): Promise<PatientCase | null> {
    return mutateCase(id, expectedVersion, (current) => ({ ...current, ...partial, updatedAt: new Date().toISOString() }));
}

/** `expectedVersion`: see mutateCase's doc comment — optional, undefined by
 * every current call site, so this falls back to a version read fresh
 * immediately before the delete rather than one a caller tracked earlier. */
export async function deleteCase(id: string, expectedVersion?: string | null): Promise<void> {
    const backend = getPatientCasesBackend();
    if (backend.deleteOne) {
        const current = (await readAllCases(backend)).find((c) => c.id === id);
        if (!current) return;
        const versionToCheck = expectedVersion !== undefined ? expectedVersion : (current.version ?? null);
        const result = await backend.deleteOne(id, versionToCheck);
        if ("conflict" in result) throw new CaseWriteConflictError(result.current);
        return;
    }
    await backend.writeAll((await backend.readAll()).filter((c) => c.id !== id));
}

/** Records a new consent grant — never mutates or removes a past record
 * (revoking uses `revokeConsent` below to set `revokedAt`, preserving the
 * fact that consent was once granted and when). */
export async function grantConsent(caseId: string, scope: CaseConsent["scope"], method: string): Promise<PatientCase | null> {
    // undefined expectedVersion: this appends to whatever the backend's
    // freshest copy is, which is the correct behavior for an additive record
    // like a consent grant — there is no "base snapshot" a caller loaded to
    // overwrite, unlike updateCase's whole-field-set replacement.
    return mutateCase(caseId, undefined, (current) => {
        const record: CaseConsent = { id: randomUUID(), scope, method, grantedAt: new Date().toISOString() };
        return { ...current, consentRecords: [...current.consentRecords, record], updatedAt: new Date().toISOString() };
    });
}

/** Sets `revokedAt` on a specific consent record — the record itself stays,
 * since "consent was granted on X and revoked on Y" is the fact worth
 * keeping, not just "consent is currently absent". */
export async function revokeConsent(caseId: string, consentId: string): Promise<PatientCase | null> {
    return mutateCase(caseId, undefined, (current) => {
        const now = new Date().toISOString();
        return {
            ...current,
            consentRecords: current.consentRecords.map((c) => (c.id === consentId ? { ...c, revokedAt: c.revokedAt ?? now } : c)),
            updatedAt: now,
        };
    });
}

/** True only if a matching scope has an active (granted, not revoked) consent record. */
export function hasActiveConsent(patientCase: PatientCase, scope: CaseConsent["scope"]): boolean {
    return patientCase.consentRecords.some((c) => c.scope === scope && !c.revokedAt);
}

export async function addClinicalNote(caseId: string, author: ClinicalNote["author"], text: string): Promise<PatientCase | null> {
    return mutateCase(caseId, undefined, (current) => {
        const note: ClinicalNote = { id: randomUUID(), author, text, createdAt: new Date().toISOString() };
        return { ...current, clinicalNotes: [...current.clinicalNotes, note], updatedAt: new Date().toISOString() };
    });
}

/**
 * Records a clinician's sign-off on a model-inference note — the note stays
 * in the case either way, but `review` marks whether it was ever actually
 * looked at and what a clinician decided about it, rather than letting
 * "present in the case" silently stand in for "reviewed." Only meaningful
 * for author: "model-inference" notes; a clinician's own note needs no
 * separate reviewer, so this refuses to set a review on one.
 */
export async function reviewClinicalNote(
    caseId: string,
    noteId: string,
    reviewedBy: string,
    outcome: NonNullable<ClinicalNote["review"]>["outcome"],
    comment?: string
): Promise<PatientCase | null> {
    return mutateCase(caseId, undefined, (current) => {
        const now = new Date().toISOString();
        return {
            ...current,
            clinicalNotes: current.clinicalNotes.map((n) =>
                n.id === noteId && n.author === "model-inference" ? { ...n, review: { reviewedBy, reviewedAt: now, outcome, comment } } : n
            ),
            updatedAt: now,
        };
    });
}

/**
 * Assembles only the fields the user has marked `includeInContext: true`
 * into a plain-text block for a model prompt, each line prefixed with the
 * field name so the model (and a human reviewing the transmission preview)
 * can see exactly what was included. Fields with `includeInContext: false`
 * never appear here — this is the single choke point that enforces the
 * "user controls exactly which case fields are sent" requirement.
 */
export function buildContextForCase(patientCase: PatientCase): { text: string; includedFields: string[] } {
    const lines: string[] = [];
    const includedFields: string[] = [];

    function addString(label: string, field: CaseField<string>) {
        if (field.includeInContext && field.value.trim()) {
            lines.push(`${label}: ${field.value.trim()}`);
            includedFields.push(label);
        }
    }
    function addList(label: string, field: CaseField<string[]>) {
        if (field.includeInContext && field.value.length > 0) {
            lines.push(`${label}: ${field.value.join(", ")}`);
            includedFields.push(label);
        }
    }

    if (patientCase.demographics.includeInContext) {
        const d = patientCase.demographics.value;
        const parts = [d.age ? `age ${d.age}` : null, d.sex ? `sex ${d.sex}` : null, d.notes || null].filter(Boolean);
        if (parts.length > 0) {
            lines.push(`Demographics: ${parts.join(", ")}`);
            includedFields.push("Demographics");
        }
    }
    addString("Presenting complaint", patientCase.presentingComplaint);
    addString("Symptoms and timeline", patientCase.symptomsTimeline);
    addString("Vital signs", patientCase.vitalSigns);
    addList("Known conditions", patientCase.conditions);
    addList("Allergies", patientCase.allergies);
    addList("Current medications", patientCase.medications);
    if (patientCase.labResults.includeInContext && patientCase.labResults.value.length > 0) {
        lines.push(
            `Lab results: ${patientCase.labResults.value
                .map((l) => `${l.name} ${l.value}${l.unit ?? ""}${l.referenceRange ? ` (ref ${l.referenceRange})` : ""}`)
                .join("; ")}`
        );
        includedFields.push("Lab results");
    }
    addString("Imaging and reports", patientCase.imagingAndReports);

    return { text: lines.join("\n"), includedFields };
}
