// Plain constants/types shared by the Clinical Assistant chat UI, kept in
// their own module (not Chat.tsx) so that file only exports components —
// mixing component and non-component exports in one file breaks Vite's Fast
// Refresh for that file (react-refresh/only-export-components).

export interface EmergencyFlag {
    matched: string;
    category: string;
}

export const EMERGENCY_BANNER_TEXT =
    "This may describe a medical emergency. Contact your local emergency number " +
    "or go to the nearest emergency department now. Do not wait for an AI-generated response.";

export const CLINICAL_MODES = {
    none: { label: "General", instruction: null },
    soap: {
        label: "SOAP note",
        instruction: "Draft a SOAP note (Subjective, Objective, Assessment, Plan) from the information provided.",
    },
    differential: {
        label: "Differential diagnosis support",
        instruction: "Provide differential diagnosis support — a ranked list of possible interpretations, not a single diagnosis.",
    },
    medicationReview: {
        label: "Medication review",
        instruction: "Review the listed medications for interactions, duplication, and dosing concerns that warrant clinician attention.",
    },
    dischargeSummary: {
        label: "Discharge summary",
        instruction: "Draft a discharge summary from the information provided.",
    },
    patientEducation: {
        label: "Patient education",
        instruction: "Write a plain-language explanation suitable to share with a patient, avoiding unexplained jargon.",
    },
    researchReview: {
        label: "Research/literature review",
        instruction: "Summarize relevant medical literature or guidelines, citing sources where available.",
    },
} as const;

export type ClinicalModeKey = keyof typeof CLINICAL_MODES;

// Single source of truth for the eight required section headings — reused
// to build the prompt text below *and* to validate a response against it
// (checkResponseContractCompliance). Keeping one array instead of a
// hardcoded heading list in each place means the prompt instruction and the
// check that verifies a model actually followed it can never silently drift
// apart from each other.
export const RESPONSE_CONTRACT_SECTION_HEADINGS = [
    "1. Summary",
    "2. Known patient facts",
    "3. Assessment or possible interpretations",
    "4. Missing information",
    "5. Red flags and urgent concerns",
    "6. Suggested next clinical steps",
    "7. Evidence and citations",
    "8. Uncertainty and limitations",
] as const;

// The structured response contract every clinically-relevant answer must
// follow, enforced here via the system prompt rather than left to a model's
// default behavior — a model can still fail to follow it, which is exactly
// why the emergency banner above is a separate, non-model check rather than
// relying on the model to always mention section 5 correctly.
export const CLINICAL_RESPONSE_CONTRACT = `When responding to a clinically relevant question, structure your answer using exactly these eight sections, in order, with these headings:
${RESPONSE_CONTRACT_SECTION_HEADINGS.join("\n")}

Do not fabricate patient facts, sources, doses, contraindications, or test results. Mark inference and uncertainty clearly. Ask for missing high-impact information rather than guessing. State explicitly when the available evidence is insufficient to answer confidently, rather than answering anyway. Never silently convert units — preserve the original unit and show any conversion explicitly. This is decision support for a clinician, not an autonomous diagnosis or prescription — you are not treating the patient.`;

export interface ResponseContractCheckResult {
    /**
     * True only when the response appears to actually be attempting the
     * structured contract (at least one required heading present verbatim)
     * — a short non-clinical reply ("Thanks, that's helpful") was never
     * going to have eight sections and flagging it as non-compliant would
     * be noise, not a real signal. Mirrors medical-safety.ts's
     * checkCitations()'s own applicability heuristic (only flag "missing
     * citations" when the text is making a clinical assertion at all).
     */
    applicable: boolean;
    /** Required headings absent from the response, in contract order — empty when every section that should be present is. */
    missingSections: (typeof RESPONSE_CONTRACT_SECTION_HEADINGS)[number][];
}

/**
 * Deterministic, non-model check: does a response that attempted the
 * eight-section contract actually include every required section? A model
 * can be instructed to always include "5. Red flags and urgent concerns" —
 * nothing stops it from quietly dropping that section on a given response,
 * and a clinician skimming a long structured answer is exactly the person
 * likely to miss a silently-omitted section without an explicit flag. Runs
 * entirely client-side (plain string matching against the same heading list
 * used to build the prompt above) — no IPC round trip needed, unlike the
 * other deterministic safety checks in app/src/medical-safety.ts which need
 * the main process for other reasons (settings access, file I/O). This one
 * has neither, so it stays where the constant it checks against lives.
 */
export function checkResponseContractCompliance(text: string): ResponseContractCheckResult {
    const present = RESPONSE_CONTRACT_SECTION_HEADINGS.filter((heading) => text.includes(heading));
    if (present.length === 0) return { applicable: false, missingSections: [] };
    return {
        applicable: true,
        missingSections: RESPONSE_CONTRACT_SECTION_HEADINGS.filter((heading) => !text.includes(heading)),
    };
}
