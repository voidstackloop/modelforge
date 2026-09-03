import type { PatientCase } from "@modelforge/contracts";
import { redactIdentifiers } from "./redaction.js";

/**
 * ClinicalAiGateway step 5: "Minimize the data to what the selected task
 * requires." Item: "a medication-interaction request should not
 * automatically receive complete imaging studies or unrelated historical
 * notes." This is a static, auditable allowlist per purpose-of-use — never
 * "send everything and let the model ignore what it doesn't need," which
 * is not minimization at all.
 *
 * Category names match `AiDataScope.dataCategories`
 * (packages/contracts/src/ai-gateway.ts) and `AiConsent.dataCategories`, so
 * the same strings flow through selection, consent-coverage checking
 * (ai-gateway/policy.ts), and the audit trail without translation.
 */
export const TASK_DATA_CATEGORIES: Record<string, readonly string[]> = {
    "medication-review": ["medications", "allergies"],
    "diagnostic-support": ["presentingComplaint", "symptomsTimeline", "vitalSigns", "conditions", "labResults", "imagingAndReports"],
    "documentation-assist": ["clinicalNotes"],
    "summarization": ["presentingComplaint", "symptomsTimeline", "conditions", "medications", "clinicalNotes"],
    research: ["conditions", "labResults", "medications"],
    teaching: ["presentingComplaint", "conditions", "imagingAndReports"],
    "quality-improvement": ["conditions", "medications", "labResults"],
} satisfies Record<string, readonly string[]>;

/** The scalar (non-array-of-resources) case fields minimizeForTask can
 * include — the complete set of `resourceType: "patientCaseField"` citation
 * suffixes routes/ai-gateway.ts's citation re-authorization must recognize.
 * Exported so that re-verification never drifts from what this function
 * actually cites; a category added here without a matching read-time check
 * would silently make its citations undisplayable, not silently unsafe. */
export const SCALAR_CASE_FIELD_CATEGORIES = ["presentingComplaint", "symptomsTimeline", "vitalSigns", "conditions", "allergies", "medications", "labResults", "imagingAndReports"] as const;

export interface MinimizedSelection {
    /** Plain-text sections, one per included category, ready to compose
     * into a prompt — never the whole PatientCase JSON. */
    sections: Array<{ category: string; text: string }>;
    /** The categories actually included after every filter (task allowlist
     * ∩ caller's requested categories ∩ each field's own includeInContext
     * flag) — what the request envelope's dataScope and the audit trail
     * both record. */
    includedCategories: string[];
    /** Resource refs for citation purposes (ai-gateway/gateway.ts's
     * createOutput turns each of these into an AiCitation) — one per
     * clinical note actually included (real resource ids), PLUS one
     * synthetic `patientCaseField` ref per included scalar field category
     * (`resourceId: "<category>:<caseId>"`). The synthetic ones exist
     * specifically so evidence provenance covers *every* piece of content
     * that reached the model, not only clinical notes — before this, a
     * diagnostic-support request's labResults/vitalSigns/imagingAndReports
     * sections (the majority of most prompts) produced zero citations at
     * all, a real provenance gap this closes. Category comes first in
     * `resourceId`, deliberately, so extracting the fixed, colon-free
     * category back out at read time is unambiguous even if a caseId
     * itself happens to contain a colon (case ids are arbitrary caller-
     * supplied TEXT, not a format this system controls — see
     * routes/params.ts's own doc comment on that). See
     * routes/ai-gateway.ts's citation re-authorization loop for the
     * matching read-time check. */
    resourceRefs: Array<{ resourceType: string; resourceId: string }>;
}

function fieldText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value.trim() || null;
    if (Array.isArray(value)) return value.length ? value.map(String).join("; ") : null;
    if (typeof value === "object") {
        const parts = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
            .map(([k, v]) => `${k}: ${v}`);
        return parts.length ? parts.join(", ") : null;
    }
    return String(value);
}

/**
 * `requestedCategories` is the user's own explicit selection from the
 * pre-flight sharing UI — always intersected with, never a way to widen,
 * the task's own allowlist. A category outside the task allowlist is
 * silently dropped, not an error: the UI is expected to only ever offer
 * categories the task allows in the first place, but this function does
 * not trust that and re-enforces it regardless of what the caller sent.
 */
export function minimizeForTask(patientCase: PatientCase, purposeOfUse: string, requestedCategories: string[]): MinimizedSelection {
    const allowedForTask = new Set(TASK_DATA_CATEGORIES[purposeOfUse] ?? []);
    const requested = new Set(requestedCategories);
    const sections: Array<{ category: string; text: string }> = [];
    const includedCategories: string[] = [];
    const resourceRefs: Array<{ resourceType: string; resourceId: string }> = [];

    const scalarFieldMap: Record<string, { includeInContext: boolean; value: unknown } | undefined> = {
        presentingComplaint: patientCase.presentingComplaint,
        symptomsTimeline: patientCase.symptomsTimeline,
        vitalSigns: patientCase.vitalSigns,
        conditions: patientCase.conditions,
        allergies: patientCase.allergies,
        medications: patientCase.medications,
        labResults: patientCase.labResults,
        imagingAndReports: patientCase.imagingAndReports,
    };

    for (const [category, field] of Object.entries(scalarFieldMap)) {
        if (!allowedForTask.has(category) || !requested.has(category) || !field) continue;
        // A clinician's own explicit per-field exclusion (caseFieldSchema's
        // includeInContext) is never overridden by a task allowlist — it is
        // the more specific, more recent human decision.
        if (!field.includeInContext) continue;
        const text = fieldText(field.value);
        if (text) {
            sections.push({ category, text: redactIdentifiers(text).text });
            includedCategories.push(category);
            resourceRefs.push({ resourceType: "patientCaseField", resourceId: `${category}:${patientCase.id}` });
        }
    }

    if (allowedForTask.has("clinicalNotes") && requested.has("clinicalNotes")) {
        for (const note of patientCase.clinicalNotes) {
            const redacted = redactIdentifiers(note.text);
            sections.push({ category: "clinicalNotes", text: redacted.text });
            resourceRefs.push({ resourceType: "clinicalNote", resourceId: note.id });
        }
        if (patientCase.clinicalNotes.length > 0) includedCategories.push("clinicalNotes");
    }

    return { sections, includedCategories: [...new Set(includedCategories)], resourceRefs };
}
