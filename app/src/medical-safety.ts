// Deterministic, non-model safety checks for the clinical workspace.
//
// These run outside any LLM call on purpose: a model can be prompted to
// mention red flags, but a prompt is not a control — it can be ignored,
// jailbroken, or simply omitted on an off day. Everything here is plain
// pattern matching over text/structured data so it behaves the same way
// every time, regardless of which model is selected.
//
// None of this is a medical device, a diagnostic system, or a substitute
// for clinical judgment. The keyword/pattern lists below are intentionally
// conservative (biased toward over-flagging) and are not exhaustive medical
// coverage — see docs/AGENT_MODE.md-equivalent product boundary notes in
// README.md.

export interface EmergencyFlag {
    /** The phrase from the input that triggered this flag. */
    matched: string;
    /** Short human-readable category, e.g. "possible stroke". */
    category: string;
}

export interface EmergencyCheckResult {
    isEmergency: boolean;
    flags: EmergencyFlag[];
}

// Deliberately broad, plain-language patterns a patient or clinician might
// type — not ICD-10 codes or clinical shorthand, since this check runs on
// raw user input before any structuring happens. Over-flagging is the safe
// failure mode here; under-flagging is not.
const EMERGENCY_PATTERNS: { category: string; pattern: RegExp }[] = [
    { category: "difficulty breathing", pattern: /\b(can'?t breathe|cannot breathe|trouble breathing|severe(ly)? short(ness)? of breath|gasping for air|struggling to breathe)\b/i },
    { category: "possible stroke", pattern: /\b(face (is )?drooping|slurred speech|sudden(ly)? (can'?t|cannot) (speak|move|see)|one[- ]sided weakness|sudden numbness|worst headache of (my|his|her|their) life)\b/i },
    { category: "severe chest pain", pattern: /\b(crushing chest pain|severe chest pain|chest pain (radiating|spreading) (to|down) (my|his|her|their) (arm|jaw))\b/i },
    { category: "anaphylaxis", pattern: /\b(anaphylaxis|throat (is )?closing|swelling of (my|his|her|their) (throat|tongue|face) and (can'?t|cannot) breathe|allergic reaction.{0,20}(can'?t|cannot) breathe)\b/i },
    { category: "major bleeding", pattern: /\b(bleeding (that )?(won'?t|will not) stop|massive bleeding|uncontrolled(?:ly)? bleeding|hemorrhag(e|ing))\b/i },
    { category: "loss of consciousness", pattern: /\b(unresponsive|not waking up|unconscious and (won'?t|will not) wake|passed out and (won'?t|will not) wake)\b/i },
    { category: "immediate self-harm risk", pattern: /\b(going to kill myself|about to kill myself|suicide (plan|attempt) (right now|tonight)|actively (suicidal|planning to end my life))\b/i },
    { category: "overdose", pattern: /\b(took (a|too many) (whole )?bottle of (pills|medication)|overdosed?( on)?)\b/i },
    { category: "severe allergic/anaphylactic swelling", pattern: /\b(throat closing up|face swelling rapidly)\b/i },
];

/**
 * Scans free text (a chat message, imported note) for plain-language
 * emergency red flags. Runs before the message ever reaches a model —
 * the resulting banner must never be suppressed by, or contingent on,
 * anything the model says afterward.
 */
export function checkForEmergencyFlags(text: string): EmergencyCheckResult {
    const flags: EmergencyFlag[] = [];
    for (const { category, pattern } of EMERGENCY_PATTERNS) {
        const match = text.match(pattern);
        if (match) flags.push({ matched: match[0], category });
    }
    return { isEmergency: flags.length > 0, flags };
}

export const EMERGENCY_BANNER_TEXT =
    "This may describe a medical emergency. Contact your local emergency number " +
    "or go to the nearest emergency department now. Do not wait for an AI-generated response.";

// --- Allergy / medication conflict checks ----------------------------------

export interface MedicationConflictWarning {
    kind: "allergy" | "duplicate-class" | "known-interaction";
    medication: string;
    conflictsWith: string;
    detail: string;
}

// A tiny, deliberately non-authoritative seed list of well-known,
// high-profile interaction pairs and drug/allergy-class synonyms, used only
// to demonstrate and unit-test the warning *mechanism*. This is NOT a
// substitute for a licensed drug-interaction database (e.g. First
// Databank, Lexicomp, Multum) — see README limitations. Matching is
// case-insensitive substring matching on free-text medication/allergy
// names, which is intentionally conservative and will both over- and
// under-match real-world brand names, salts, and combination products.
const KNOWN_INTERACTIONS: { a: string; b: string; detail: string }[] = [
    { a: "warfarin", b: "aspirin", detail: "Combined use raises bleeding risk; requires clinician review." },
    { a: "warfarin", b: "ibuprofen", detail: "NSAID + warfarin raises GI bleeding risk; requires clinician review." },
    { a: "maoi", b: "ssri", detail: "Risk of serotonin syndrome; requires clinician review." },
    { a: "sildenafil", b: "nitrate", detail: "Combined use can cause severe hypotension." },
    { a: "metformin", b: "contrast dye", detail: "Risk of contrast-induced lactic acidosis; hold per protocol." },
];

const ALLERGY_CLASS_SYNONYMS: Record<string, string[]> = {
    penicillin: ["amoxicillin", "ampicillin", "penicillin"],
    sulfa: ["sulfamethoxazole", "sulfasalazine", "bactrim"],
    nsaid: ["ibuprofen", "naproxen", "aspirin", "diclofenac"],
};

function normalize(s: string): string {
    return s.trim().toLowerCase();
}

/**
 * Behind-interface seam for medication/allergy conflict checking. The
 * built-in provider below is a tiny, non-authoritative seed list that
 * exists only to demonstrate and unit-test the warning *mechanism* — a real
 * deployment would swap in a provider backed by a licensed interaction
 * database (First Databank, Lexicomp, Multum, etc.) via
 * `setMedicationSafetyProvider` without touching any call site, since every
 * caller (IPC handlers, tests) goes through `checkMedicationConflicts`, not
 * a concrete implementation.
 */
export interface MedicationSafetyProvider {
    /** Short identifier surfaced in warnings/UI so it's never ambiguous which engine produced a result, e.g. "modelforge-builtin-seed-list" vs a real vendor name. */
    readonly name: string;
    checkConflicts(allergies: string[], medications: string[]): MedicationConflictWarning[];
}

export const builtInMedicationSafetyProvider: MedicationSafetyProvider = {
    name: "modelforge-builtin-seed-list",
    checkConflicts(allergies: string[], medications: string[]): MedicationConflictWarning[] {
        const warnings: MedicationConflictWarning[] = [];
        const normAllergies = allergies.map(normalize).filter(Boolean);
        const normMeds = medications.map(normalize).filter(Boolean);

        for (const allergy of normAllergies) {
            const synonymGroup = ALLERGY_CLASS_SYNONYMS[allergy] ?? [allergy];
            for (const med of normMeds) {
                if (synonymGroup.some((syn) => med.includes(syn) || syn.includes(med))) {
                    warnings.push({
                        kind: "allergy",
                        medication: med,
                        conflictsWith: allergy,
                        detail: `Recorded allergy to "${allergy}" may conflict with medication "${med}".`,
                    });
                }
            }
        }

        for (let i = 0; i < normMeds.length; i++) {
            for (let j = i + 1; j < normMeds.length; j++) {
                const [medA, medB] = [normMeds[i], normMeds[j]];
                for (const pair of KNOWN_INTERACTIONS) {
                    const matchesForward = medA.includes(pair.a) && medB.includes(pair.b);
                    const matchesReverse = medA.includes(pair.b) && medB.includes(pair.a);
                    if (matchesForward || matchesReverse) {
                        warnings.push({
                            kind: "known-interaction",
                            medication: normMeds[i],
                            conflictsWith: normMeds[j],
                            detail: pair.detail,
                        });
                    }
                }
            }
        }

        return warnings;
    },
};

let activeMedicationSafetyProvider: MedicationSafetyProvider = builtInMedicationSafetyProvider;

/** Swaps the active provider (e.g. to a licensed-database-backed one). Not persisted across restarts on purpose — wire persistence at the call site once a real second provider exists, rather than guessing its config shape now. */
export function setMedicationSafetyProvider(provider: MedicationSafetyProvider): void {
    activeMedicationSafetyProvider = provider;
}

export function getMedicationSafetyProvider(): MedicationSafetyProvider {
    return activeMedicationSafetyProvider;
}

/**
 * Deterministic, best-effort conflict check against a case's recorded
 * allergies and current medication list, delegated to whichever provider is
 * currently active (built-in seed list by default). Every warning must be
 * clinician-reviewed, never auto-acted on, regardless of provider.
 */
export function checkMedicationConflicts(
    allergies: string[],
    medications: string[]
): MedicationConflictWarning[] {
    return activeMedicationSafetyProvider.checkConflicts(allergies, medications);
}

// --- Best-effort text redaction ---------------------------------------------

export interface RedactionResult {
    redacted: string;
    /** Count of substitutions made, by category, for transparency in the UI. */
    counts: Record<string, number>;
}

// Pattern-based, best-effort scrubbing of common direct identifiers before
// an optional remote model call. This is NOT clinical-grade de-identification
// (it will not catch identifying information embedded in free-text clinical
// narrative, e.g. "the patient, a retired postal worker in Springfield") and
// must never be presented to the user as HIPAA Safe Harbor de-identification.
const REDACTION_PATTERNS: { category: string; pattern: RegExp; replacement: string }[] = [
    { category: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[REDACTED_EMAIL]" },
    { category: "phone", pattern: /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, replacement: "[REDACTED_PHONE]" },
    { category: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[REDACTED_SSN]" },
    { category: "mrn", pattern: /\b(MRN|mrn)[:#\s]*\d{4,}\b/g, replacement: "[REDACTED_MRN]" },
    { category: "dob", pattern: /\b(0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])[/-](19|20)\d{2}\b/g, replacement: "[REDACTED_DATE]" },
];

export function redactIdentifiers(text: string): RedactionResult {
    let redacted = text;
    const counts: Record<string, number> = {};
    for (const { category, pattern, replacement } of REDACTION_PATTERNS) {
        const matches = redacted.match(pattern);
        if (matches) counts[category] = matches.length;
        redacted = redacted.replace(pattern, replacement);
    }
    return { redacted, counts };
}

// --- Citation / unverified-claim helper -------------------------------------

export interface CitationCheckResult {
    /** Citation markers (e.g. "[1]", "(Smith 2020)") found in the text with no matching source. */
    unverifiedMarkers: string[];
    /** True if the text contains clinical assertions but no citation markers at all. */
    missingCitations: boolean;
}

const CITATION_MARKER_PATTERN = /\[\d+\]|\((?:[A-Z][a-zA-Z'-]+(?:\s(?:et al\.?|&|and)\s[A-Z][a-zA-Z'-]+)?,?\s?(?:19|20)\d{2}\))/g;

// Rough heuristic for "this looks like it's making a clinical claim that
// should be sourced" — a hedge word or a specific clinical noun. Deliberately
// permissive; false positives just mean an extra abstinence nudge, which is
// the safer direction to err in.
const CLINICAL_ASSERTION_PATTERN = /\b(indicates?|suggests?|diagnos(is|e[sd]?)|treatment|contraindicat(ed|ion)|dosage|guideline|recommend(s|ed)?|evidence shows|studies show)\b/i;

/**
 * Cross-checks citation markers found in model output against a list of
 * source identifiers actually attached to the conversation (e.g. Evidence
 * Library entries or explicitly retrieved RAG chunks). A marker with no
 * matching known source is "unverified" — the caller should render such
 * markers as fabricated/unverified rather than trusting them at face value.
 */
export function checkCitations(text: string, knownSourceIds: string[]): CitationCheckResult {
    const markers = text.match(CITATION_MARKER_PATTERN) ?? [];
    const knownSet = new Set(knownSourceIds.map(normalize));
    const unverifiedMarkers = markers.filter((marker) => !knownSet.has(normalize(marker)));
    const missingCitations = markers.length === 0 && CLINICAL_ASSERTION_PATTERN.test(text);
    return { unverifiedMarkers, missingCitations };
}
