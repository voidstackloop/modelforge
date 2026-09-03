/**
 * Model/prompt versioning for the ClinicalAiGateway's own system prompt —
 * closes the gap that used to exist here: a single hardcoded prompt string
 * inline in gateway.ts, with no version recorded per request and no way to
 * pin or roll back to an older wording. `AiOutput.promptVersion`
 * (packages/contracts/src/ai-gateway.ts) now records exactly which entry
 * below produced each output, forever — never mutated after the fact,
 * mirroring `AiOutput.modelVersion`'s own "what produced this" role for the
 * provider model itself.
 *
 * Versions are append-only and immutable: once `PROMPT_VERSIONS` ships a
 * version, its text must never change (a wording fix is a NEW version, not
 * an edit) — an already-generated AiOutput's `promptVersion` must always be
 * able to resolve back to the exact prompt text that produced it, for as
 * long as this codebase cares to keep the entry around. "Rollback" is
 * simply pointing `CURRENT_PROMPT_VERSION` at an older key; nothing about
 * older outputs' records needs to change for that to be safe.
 */

const V1 = `You are a clinical decision-support assistant. You are NOT a diagnostic device and your output is never a final medical decision. Every response you produce will be shown to a licensed clinician as an unsigned draft for their review — it must never be presented to a patient directly, and it never modifies, signs, or submits any medical record on its own.

Respond using EXACTLY this structure, with no other section headers:
SUMMARY: <one concise, clinically useful conclusion, or "N/A" if abstaining>
EVIDENCE:
- <one bullet per specific supporting fact, referencing only the clinical data provided below>
UNCERTAINTY: <what is uncertain or missing, if anything>
FOLLOWUP:
- <one bullet per recommended next step for the clinician to consider>
ABSTAIN: <present ONLY if the provided data is insufficient, contradictory, or outside your scope — explain why you cannot safely draw a conclusion>

Never include your reasoning process, chain-of-thought, or private deliberation — only the concise sections above. Never invent facts not present in the clinical data provided. If the data is insufficient, contradictory, or you are not confident, use the ABSTAIN section rather than guessing.`;

export const PROMPT_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
    "clinical-gateway-prompt-v1": V1,
});

/** The version every new request uses unless a caller pins an older one
 * (submitRequest's own optional `promptVersion` input) — a real rollback
 * mechanism: an operator who finds a new prompt version is producing worse
 * outputs (see eval-harness/production-monitor.ts's drift detection) can
 * pin requests back to the prior version without a code deploy, by passing
 * it explicitly, while a fix is prepared. */
export const CURRENT_PROMPT_VERSION = "clinical-gateway-prompt-v1";

export class UnknownPromptVersionError extends Error {
    constructor(version: string) {
        super(`Unknown prompt version "${version}" — known versions: ${Object.keys(PROMPT_VERSIONS).join(", ")}.`);
        this.name = "UnknownPromptVersionError";
    }
}

/** Resolves a prompt version to its text. `version` defaults to
 * `CURRENT_PROMPT_VERSION`; an explicitly-passed unknown version throws
 * rather than silently falling back to current — a caller pinning a
 * specific version (e.g. for a reproducibility/rollback reason) must never
 * silently get a different one. */
export function getSystemPrompt(version: string = CURRENT_PROMPT_VERSION): { version: string; text: string } {
    const text = PROMPT_VERSIONS[version];
    if (!text) throw new UnknownPromptVersionError(version);
    return { version, text };
}
