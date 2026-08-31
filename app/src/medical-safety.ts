import { logger } from "./logger";

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

// What kind of engine produced a result — always provider-declared, never
// inferred from its output. "demonstration" means exactly what the built-in
// provider is: a mechanism demo, not medical coverage. A future licensed
// provider would declare "clinically-authoritative" instead; nothing in this
// file may promote a provider to that status on its own.
export type MedicationSafetyCoverage = "demonstration" | "clinically-authoritative";

// The full state of a medication-safety check, replacing a bare warnings
// array so "no warnings" and "no evidence of a problem" can never be
// conflated with "verified safe" or "check didn't actually run":
//   - `status` is the provider's own coverage (demonstration/
//     clinically-authoritative) when a check actually ran, or "unavailable"/
//     "failed" when it didn't — four distinct values, never collapsed into
//     "no warnings".
//   - `applicable` is a separate axis: false means there was nothing to
//     check (no allergies or medications recorded at all), which is not the
//     same claim as "checked and found nothing".
//   - `warnings` is only ever non-empty when `status` reflects a check that
//     actually completed.
export interface MedicationSafetyResult {
    /** Stable machine identifier of the provider that produced this result — matches MedicationSafetyProvider.name. */
    providerName: string;
    /** Human-readable label for display, e.g. "Built-in demonstration list". */
    providerLabel: string;
    status: MedicationSafetyCoverage | "unavailable" | "failed";
    /** ISO-8601 timestamp of when this check was evaluated. */
    evaluatedAt: string;
    /** False when no allergies or medications were supplied — there was nothing to check, as distinct from a check that ran and found nothing. */
    applicable: boolean;
    warnings: MedicationConflictWarning[];
    /** Static caveat/provenance text for this provider, always shown alongside its results regardless of outcome — e.g. why zero warnings isn't evidence of safety. */
    limitations: string;
    /** Present only when status is "failed" — a fixed, safe-to-display/log message. Never the provider's raw error, which could otherwise echo back the allergy/medication text it was just given. */
    error?: string;
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
    /** Human-readable label for display — distinct from `name` so the UI never has to guess how to present a machine identifier. */
    readonly label: string;
    /** What kind of engine this is. Fixed per provider; see MedicationSafetyCoverage. */
    readonly coverage: MedicationSafetyCoverage;
    /** Static caveat/provenance text shown alongside every result from this provider, regardless of outcome. */
    readonly limitations: string;
    /**
     * Optional: lets a provider report itself as not currently usable (e.g.
     * a remote provider with no configured credentials or an unreachable
     * endpoint) without needing to throw. Checked before `checkConflicts` is
     * ever called — an unavailable provider must not be asked to run.
     */
    isAvailable?(): boolean;
    checkConflicts(allergies: string[], medications: string[]): MedicationConflictWarning[];
}

export const builtInMedicationSafetyProvider: MedicationSafetyProvider = {
    name: "modelforge-builtin-seed-list",
    label: "Built-in demonstration list",
    coverage: "demonstration",
    limitations:
        "A small, non-exhaustive set of well-known interaction pairs and allergy-class synonyms, included only to " +
        "demonstrate the warning mechanism — not a licensed drug-interaction database (e.g. First Databank, " +
        "Lexicomp, Multum). Zero warnings from this list is not evidence that the recorded medications and " +
        "allergies are safe together; independently verify with a pharmacist or clinical reference.",
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

/** Swaps the active provider directly — used by tests and by whoever wires up a real second provider at the point it's registered. For the persisted, Settings-driven path, see `selectMedicationSafetyProvider` below instead. */
export function setMedicationSafetyProvider(provider: MedicationSafetyProvider): void {
    activeMedicationSafetyProvider = provider;
}

export function getMedicationSafetyProvider(): MedicationSafetyProvider {
    return activeMedicationSafetyProvider;
}

// --- Provider registry (configuration boundary for a future provider) ------
//
// A named catalog a real licensed-database provider can register itself
// into (e.g. a future module calling `registerMedicationSafetyProvider(...)`
// at startup), independent of whether anything currently selects it.
// Settings persists only a *name* (AppSettings.medicationSafetyProviderId,
// see settings-store.ts) — never a provider object, credentials, or
// endpoint — so on-disk config never contains anything provider-specific
// enough to need its own migration if a real provider's shape changes
// later; any actual credential a real provider needs belongs in the
// existing generic secrets-store, keyed by that provider's own name, not in
// a field this file invents ahead of time. Only the built-in demonstration
// provider is registered today — this file deliberately never registers a
// second one on its own, since doing so would mean fabricating a vendor
// integration this codebase has no license or clinical validation for.
const medicationSafetyProviderRegistry = new Map<string, MedicationSafetyProvider>([
    [builtInMedicationSafetyProvider.name, builtInMedicationSafetyProvider],
]);

/** Adds (or replaces) a provider in the registry, keyed by its `name`. Registering alone never changes which provider is active — see `selectMedicationSafetyProvider`. */
export function registerMedicationSafetyProvider(provider: MedicationSafetyProvider): void {
    medicationSafetyProviderRegistry.set(provider.name, provider);
}

/** Every currently-registered provider's public identity — what a Settings UI lists to choose from. Never includes credentials or connection details, since the provider interface itself carries none. */
export function listMedicationSafetyProviders(): { name: string; label: string; coverage: MedicationSafetyCoverage }[] {
    return [...medicationSafetyProviderRegistry.values()].map(({ name, label, coverage }) => ({ name, label, coverage }));
}

/**
 * Makes the named registered provider active — the persisted, Settings-driven
 * selection path (AppSettings.medicationSafetyProviderId), as opposed to
 * `setMedicationSafetyProvider`'s direct one-off swap (tests, ad hoc use).
 * Fails safe: an unregistered name (a stale setting from a build that shipped
 * a provider this one doesn't, a typo) leaves whichever provider was already
 * active untouched and returns `false` rather than throwing or silently
 * falling through to some default — callers (main.ts at startup,
 * settings:save) are expected to log that case, not treat it as fatal.
 */
export function selectMedicationSafetyProvider(name: string): boolean {
    const provider = medicationSafetyProviderRegistry.get(name);
    if (!provider) return false;
    activeMedicationSafetyProvider = provider;
    return true;
}

function hasContent(list: string[]): boolean {
    return list.some((s) => normalize(s).length > 0);
}

/**
 * Deterministic, best-effort conflict check against a case's recorded
 * allergies and current medication list, delegated to whichever provider is
 * currently active (built-in seed list by default). Every warning must be
 * clinician-reviewed, never auto-acted on, regardless of provider.
 *
 * Always returns a full MedicationSafetyResult rather than a bare warnings
 * array — see its own doc comment for why "no warnings" alone is never
 * enough to tell "nothing to check" apart from "checked, found nothing" or
 * "the check itself didn't run".
 */
export function checkMedicationConflicts(allergies: string[], medications: string[]): MedicationSafetyResult {
    const provider = activeMedicationSafetyProvider;
    const base = {
        providerName: provider.name,
        providerLabel: provider.label,
        evaluatedAt: new Date().toISOString(),
        limitations: provider.limitations,
    };

    const applicable = hasContent(allergies) || hasContent(medications);
    if (!applicable) {
        // Nothing recorded to check against — deliberately skips even
        // isAvailable()/checkConflicts() so an unavailable or misconfigured
        // provider can never masquerade as "ran and found nothing" when
        // there was nothing to evaluate in the first place.
        return { ...base, applicable, status: provider.coverage, warnings: [] };
    }

    if (provider.isAvailable && !provider.isAvailable()) {
        return { ...base, applicable, status: "unavailable", warnings: [] };
    }

    try {
        const warnings = provider.checkConflicts(allergies, medications);
        return { ...base, applicable, status: provider.coverage, warnings };
    } catch (err) {
        // Never surface the provider's raw error message to the caller (and
        // from there, the renderer/IPC boundary): a buggy or malicious
        // provider could echo back the very allergy/medication text it was
        // just given inside an error message, which would leak clinical
        // content through a field this app treats as safe to display and
        // log. Only the provider's own identity is logged — never its input
        // or its raw error.
        logger.error(`Medication safety provider "${provider.name}" threw during checkConflicts().`);
        return {
            ...base,
            applicable,
            status: "failed",
            warnings: [],
            error: "The medication safety check failed to complete. Treat this as unverified, not as a clean result.",
        };
    }
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
