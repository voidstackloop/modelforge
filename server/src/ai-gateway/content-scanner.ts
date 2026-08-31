/**
 * ClinicalAiGateway step 7: "Scan documents and retrieved content for
 * malicious instructions, secrets, and unsupported content." This is a
 * **heuristic, pattern-based scanner** — not an ML classifier, and
 * deliberately disclosed as such. It catches the concrete, well-known
 * indirect-prompt-injection and secret-leakage shapes attackers actually
 * use against clinical-note-shaped text; it is a real, load-bearing
 * defense-in-depth layer, not a guarantee that no injection attempt can
 * ever get through. Treat every retrieved/uploaded document as untrusted
 * data per the same "never as executable instructions" rule this scanner
 * exists to enforce, regardless of whether it flags anything.
 */

export type ContentScanFindingKind = "prompt-injection" | "secret" | "unsupported-content";

export interface ContentScanFinding {
    kind: ContentScanFindingKind;
    pattern: string;
    /** A short, truncated, non-PHI-preserving excerpt for audit purposes —
     * long enough to triage, never the full surrounding clinical text. */
    snippet: string;
}

export interface ContentScanResult {
    safe: boolean;
    findings: ContentScanFinding[];
}

// Phrases and shapes that show up overwhelmingly in actual prompt-injection
// attempts against LLM systems (jailbreak/override language), not in normal
// clinical prose — chosen to bias toward catching real attempts over
// flagging ordinary clinical language ("the patient was told to ignore
// their prior medication schedule" should never match "ignore previous
// instructions").
const PROMPT_INJECTION_PATTERNS: Array<{ name: string; regex: RegExp }> = [
    { name: "ignore-previous-instructions", regex: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i },
    { name: "disregard-system-prompt", regex: /disregard\s+(the\s+)?(system\s+)?(prompt|instructions?|rules?)/i },
    { name: "reveal-system-prompt", regex: /(reveal|print|repeat|show)\s+(your|the)\s+(system\s+prompt|instructions?|initial\s+prompt)/i },
    { name: "role-override", regex: /you\s+are\s+now\s+(a|an|no\s+longer)\b/i },
    { name: "act-as-unrestricted", regex: /act\s+as\s+(an?\s+)?(unrestricted|jailbroken|uncensored|dan)\b/i },
    { name: "new-instructions-marker", regex: /\[?\s*(new|updated|override)\s+(system\s+)?instructions?\s*\]?\s*:/i },
    { name: "end-of-document-injection", regex: /---\s*end\s+of\s+(document|note|report)\s*---[\s\S]{0,50}(now|instead)\b/i },
    { name: "hidden-instruction-marker", regex: /<!--[\s\S]*?(ignore|instruction|system)[\s\S]*?-->/i },
];

// Secret/credential shapes — vendor-specific prefixes where known, generic
// high-entropy-looking token patterns otherwise.
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
    { name: "openai-api-key", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
    { name: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "anthropic-api-key", regex: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
    { name: "generic-bearer-token", regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
    { name: "private-key-block", regex: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/ },
    { name: "password-assignment", regex: /\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{6,}/i },
    { name: "connection-string-credential", regex: /\b\w+:\/\/[^\s:]+:[^\s@]+@/ },
];

// "Unsupported content" — binary/script-shaped material that has no
// business appearing inside clinical text a model is asked to reason
// about; a document containing this is more consistent with an attempted
// exploit (or an ingestion-pipeline bug feeding raw bytes downstream) than
// with clinical content.
const UNSUPPORTED_CONTENT_PATTERNS: Array<{ name: string; regex: RegExp }> = [
    { name: "script-tag", regex: /<script[\s>]/i },
    { name: "javascript-uri", regex: /javascript:/i },
    { name: "embedded-base64-blob", regex: /(?:[A-Za-z0-9+/]{4}){200,}={0,2}/ },
];

function truncateSnippet(text: string, index: number, length: number): string {
    const start = Math.max(0, index - 20);
    const end = Math.min(text.length, index + length + 20);
    return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 120);
}

function scanWith(text: string, patterns: Array<{ name: string; regex: RegExp }>, kind: ContentScanFindingKind): ContentScanFinding[] {
    const findings: ContentScanFinding[] = [];
    for (const { name, regex } of patterns) {
        const match = regex.exec(text);
        if (match) findings.push({ kind, pattern: name, snippet: truncateSnippet(text, match.index, match[0].length) });
    }
    return findings;
}

export function scanForUnsafeContent(text: string): ContentScanResult {
    const findings = [
        ...scanWith(text, PROMPT_INJECTION_PATTERNS, "prompt-injection"),
        ...scanWith(text, SECRET_PATTERNS, "secret"),
        ...scanWith(text, UNSUPPORTED_CONTENT_PATTERNS, "unsupported-content"),
    ];
    return { safe: findings.length === 0, findings };
}

/** Scans every piece of text that will be included in a request's prompt,
 * tagging each finding with which source resource it came from — what the
 * gateway actually calls, since a request typically bundles several
 * resources (notes, reports, retrieved chunks) into one prompt. */
export function scanResources(resources: Array<{ resourceId: string; text: string }>): Array<{ resourceId: string; result: ContentScanResult }> {
    return resources.map(({ resourceId, text }) => ({ resourceId, result: scanForUnsafeContent(text) }));
}
