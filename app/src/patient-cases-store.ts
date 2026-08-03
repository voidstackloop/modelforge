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

// Re-exported for backward compatibility — this store's own callers/tests
// catch `CaseDataLockedError` from here; the class itself now lives in
// case-encryption.ts since sessions-store.ts uses the exact same encryption
// gate and error.
export { CaseDataLockedError };

export type LabResult = z.infer<typeof labResultSchema>;
export type ClinicalNote = z.infer<typeof clinicalNoteSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type CaseConsent = z.infer<typeof caseConsentSchema>;

export interface CaseField<T> {
    value: T;
    includeInContext: boolean;
}

export interface PatientCase {
    id: string;
    title: string;
    demographics: CaseField<{ age?: string; sex?: string; notes?: string }>;
    presentingComplaint: CaseField<string>;
    symptomsTimeline: CaseField<string>;
    vitalSigns: CaseField<string>;
    conditions: CaseField<string[]>;
    allergies: CaseField<string[]>;
    medications: CaseField<string[]>;
    labResults: CaseField<LabResult[]>;
    imagingAndReports: CaseField<string>;
    clinicalNotes: ClinicalNote[];
    attachments: AttachmentRef[];
    consentNote?: string;
    consentRecords: CaseConsent[];
    enteredBy?: string;
    createdAt: string;
    updatedAt: string;
}

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

function readAll(): PatientCase[] {
    if (caseEncryption.isEnabled()) {
        if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
        const payload = readJson<EncryptedPayload | null>(encryptedFilePath(), null);
        if (!payload) return [];
        const parsed: unknown = JSON.parse(caseEncryption.decrypt(payload, caseEncryption.getSessionKey()!));
        const result = patientCasesFileSchema.safeParse(parsed);
        return result.success ? result.data.map(normalize) : [];
    }
    return readJsonWithSchema<PatientCase[]>(filePath(), [], patientCasesFileSchema as unknown as z.ZodType<PatientCase[]>).map(normalize);
}

function writeAll(cases: PatientCase[]): void {
    if (caseEncryption.isEnabled()) {
        if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
        const payload = caseEncryption.encrypt(JSON.stringify(cases), caseEncryption.getSessionKey()!);
        writeJson(encryptedFilePath(), payload);
        removeIfExists(filePath());
    } else {
        writeJson(filePath(), cases);
        removeIfExists(encryptedFilePath());
    }
}

/** Reads the current case list under whichever mode is active right now —
 * used by the encryption setup/disable/rotate-passphrase flows to move data
 * between plaintext and encrypted storage. Same locked-state guarantees as
 * every other read: throws CaseDataLockedError rather than returning an
 * empty list if encryption is enabled but not unlocked. */
export function getAllCasesForMigration(): PatientCase[] {
    return readAll();
}

/** Writes the given case list under whichever mode is active right now —
 * paired with getAllCasesForMigration() so a caller can read under the old
 * key/mode, change the key/mode, then write back under the new one. */
export function overwriteAllCases(cases: PatientCase[]): void {
    writeAll(cases);
}

export function listCases(): PatientCase[] {
    return readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Every read goes through this — never a raw array index or an unfiltered
// scan — so that a caller can only ever get back the one case it asked for,
// which is the actual guarantee behind "one patient's data never leaks into
// another case's context." Callers still must not blend two `PatientCase`
// objects together in one prompt.
export function getCase(id: string): PatientCase | null {
    return readAll().find((c) => c.id === id) ?? null;
}

function emptyStringField(): CaseField<string> {
    return { value: "", includeInContext: false };
}

function emptyArrayField<T>(): CaseField<T[]> {
    return { value: [], includeInContext: false };
}

export function createCase(title: string, enteredBy?: string): PatientCase {
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
    const all = readAll();
    all.push(patientCase);
    writeAll(all);
    return patientCase;
}

export function updateCase(
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
    >
): PatientCase | null {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...partial, updatedAt: new Date().toISOString() };
    writeAll(all);
    return all[idx];
}

export function deleteCase(id: string): void {
    writeAll(readAll().filter((c) => c.id !== id));
}

/** Records a new consent grant — never mutates or removes a past record
 * (revoking uses `revokeConsent` below to set `revokedAt`, preserving the
 * fact that consent was once granted and when). */
export function grantConsent(caseId: string, scope: CaseConsent["scope"], method: string): PatientCase | null {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === caseId);
    if (idx === -1) return null;
    const record: CaseConsent = { id: randomUUID(), scope, method, grantedAt: new Date().toISOString() };
    all[idx] = { ...all[idx], consentRecords: [...all[idx].consentRecords, record], updatedAt: new Date().toISOString() };
    writeAll(all);
    return all[idx];
}

/** Sets `revokedAt` on a specific consent record — the record itself stays,
 * since "consent was granted on X and revoked on Y" is the fact worth
 * keeping, not just "consent is currently absent". */
export function revokeConsent(caseId: string, consentId: string): PatientCase | null {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === caseId);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    all[idx] = {
        ...all[idx],
        consentRecords: all[idx].consentRecords.map((c) => (c.id === consentId ? { ...c, revokedAt: c.revokedAt ?? now } : c)),
        updatedAt: now,
    };
    writeAll(all);
    return all[idx];
}

/** True only if a matching scope has an active (granted, not revoked) consent record. */
export function hasActiveConsent(patientCase: PatientCase, scope: CaseConsent["scope"]): boolean {
    return patientCase.consentRecords.some((c) => c.scope === scope && !c.revokedAt);
}

export function addClinicalNote(caseId: string, author: ClinicalNote["author"], text: string): PatientCase | null {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === caseId);
    if (idx === -1) return null;
    const note: ClinicalNote = { id: randomUUID(), author, text, createdAt: new Date().toISOString() };
    all[idx] = { ...all[idx], clinicalNotes: [...all[idx].clinicalNotes, note], updatedAt: new Date().toISOString() };
    writeAll(all);
    return all[idx];
}

/**
 * Records a clinician's sign-off on a model-inference note — the note stays
 * in the case either way, but `review` marks whether it was ever actually
 * looked at and what a clinician decided about it, rather than letting
 * "present in the case" silently stand in for "reviewed." Only meaningful
 * for author: "model-inference" notes; a clinician's own note needs no
 * separate reviewer, so this refuses to set a review on one.
 */
export function reviewClinicalNote(
    caseId: string,
    noteId: string,
    reviewedBy: string,
    outcome: NonNullable<ClinicalNote["review"]>["outcome"],
    comment?: string
): PatientCase | null {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === caseId);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    all[idx] = {
        ...all[idx],
        clinicalNotes: all[idx].clinicalNotes.map((n) =>
            n.id === noteId && n.author === "model-inference" ? { ...n, review: { reviewedBy, reviewedAt: now, outcome, comment } } : n
        ),
        updatedAt: now,
    };
    writeAll(all);
    return all[idx];
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
