/**
 * Best-effort, pattern-based scrubbing of common structured identifiers
 * (email/phone/SSN/MRN/DOB) — the same category of patterns and the same
 * "not clinical-grade de-identification" disclosure as
 * app/src/medical-safety.ts's redactIdentifiers (the Electron app's own,
 * independently-existing equivalent for its own remote-send feature).
 * Kept as a separate, server-side implementation rather than a shared
 * import — app/ and server/ share no runtime code beyond
 * packages/contracts, and this pattern list is small enough that
 * duplicating it is cheaper and safer than inventing a new shared package
 * for one function.
 *
 * This is data minimization/redaction (ClinicalAiGateway step 6), never
 * treated as PS3.15-grade de-identification or as a guarantee of
 * anonymity — "treat pseudonymized data as sensitive clinical data. Never
 * imply that automated de-identification guarantees anonymity." A patient's
 * name, free-text narrative details, and anything this pattern list simply
 * doesn't recognize (e.g. an identifier format unique to one institution)
 * pass through unredacted. Imaging de-identification is a separate,
 * considerably more rigorous pipeline (server/src/imaging/deidentification.ts)
 * and is not duplicated here.
 */

export interface RedactionResult {
    text: string;
    /** Counts per category — metadata only, safe to log/audit; the
     * original matched values are never retained here. */
    counts: Record<string, number>;
}

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
    return { text: redacted, counts };
}
