import { createHash } from "node:crypto";
import { scanForUnsafeContent } from "./content-scanner.js";

/**
 * ClinicalAiGateway steps 10-11: "Validate and normalize the model
 * response" / "Apply clinical-safety and data-loss-prevention checks."
 *
 * The gateway's own system prompt (built alongside this module in
 * gateway.ts) asks every provider to answer in a small tagged structure —
 * `SUMMARY:`/`EVIDENCE:`/`UNCERTAINTY:`/`FOLLOWUP:`/`ABSTAIN:` — precisely
 * so this parser never has to guess where "the conclusion" ends and "the
 * supporting evidence" begins from free prose. This is item: "Separate
 * evidence, generated conclusions, uncertainty, and recommended follow-up"
 * made concrete, and it deliberately never asks for or accepts a
 * `REASONING:`/chain-of-thought section — "never store or expose hidden
 * chain-of-thought."
 *
 * A model that ignores the format entirely does not fail closed into
 * fabricated structure — its whole response becomes `summary`, evidence/
 * follow-up stay empty, and `formatCompliant: false` is reported so the
 * gateway can log it as a safety-relevant signal (a model that can't follow
 * output-format instructions is a real signal about how much to trust the
 * rest of its output) without blocking a clinician from seeing what it
 * actually said.
 */

export interface ParsedModelResponse {
    summary: string;
    evidence: string[];
    uncertainty?: string;
    followUp: string[];
    abstained: boolean;
    abstainReason?: string;
    formatCompliant: boolean;
}

const SECTION_HEADERS = ["SUMMARY", "EVIDENCE", "UNCERTAINTY", "FOLLOWUP", "ABSTAIN"] as const;
type SectionHeader = (typeof SECTION_HEADERS)[number];

function parseBulletLines(block: string): string[] {
    return block
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*]\s?/, "").trim())
        .filter((line) => line.length > 0);
}

export function parseModelResponse(rawText: string): ParsedModelResponse {
    const headerPattern = new RegExp(`^(${SECTION_HEADERS.join("|")}):`, "m");
    if (!headerPattern.test(rawText)) {
        return { summary: rawText.trim(), evidence: [], followUp: [], abstained: false, formatCompliant: false };
    }

    const sections: Partial<Record<SectionHeader, string>> = {};
    const matches = [...rawText.matchAll(new RegExp(`^(${SECTION_HEADERS.join("|")}):[ \\t]*`, "gm"))];
    for (let i = 0; i < matches.length; i++) {
        const header = matches[i][1] as SectionHeader;
        const start = matches[i].index! + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index! : rawText.length;
        sections[header] = rawText.slice(start, end).trim();
    }

    const abstainReason = sections.ABSTAIN;
    return {
        summary: sections.SUMMARY ?? "",
        evidence: sections.EVIDENCE ? parseBulletLines(sections.EVIDENCE) : [],
        uncertainty: sections.UNCERTAINTY || undefined,
        followUp: sections.FOLLOWUP ? parseBulletLines(sections.FOLLOWUP) : [],
        abstained: abstainReason !== undefined,
        abstainReason: abstainReason || undefined,
        formatCompliant: true,
    };
}

export interface ValidatedOutput extends ParsedModelResponse {
    outputHash: string;
    /** True if the OUTPUT itself (not the input — that was already scanned
     * before the request went out) tripped the same content scanner — a
     * model regurgitating an injected instruction or leaking something
     * secret-shaped is exactly what this catches on the way back. */
    outputFlagged: boolean;
    outputFlagReasons: string[];
}

const HTML_TAG_PATTERN = /<[^>]*>/g;

/** Strips any raw HTML before this content is ever persisted or rendered —
 * defense in depth against a model that was tricked into emitting markup;
 * this system never treats model output as trusted-safe-to-render HTML
 * regardless of what scanForUnsafeContent already caught. */
function stripHtml(text: string): string {
    return text.replace(HTML_TAG_PATTERN, "");
}

/**
 * If the output itself is flagged (a secret-shaped string, an injected-
 * instruction echo), this function does NOT silently pass the raw text
 * through — it replaces `summary` with a fixed, safe abstention message
 * and forces `abstained: true`, so a caller can never accidentally surface
 * unsafe content just because it also happened to check `outputFlagged`
 * after already having stored/shown `summary`.
 */
export function validateModelResponse(rawText: string): ValidatedOutput {
    const parsed = parseModelResponse(rawText);
    const scan = scanForUnsafeContent(rawText);

    const sanitizedSummary = stripHtml(parsed.summary);
    const sanitizedEvidence = parsed.evidence.map(stripHtml);
    const sanitizedFollowUp = parsed.followUp.map(stripHtml);

    const result: ParsedModelResponse = scan.safe
        ? { ...parsed, summary: sanitizedSummary, evidence: sanitizedEvidence, followUp: sanitizedFollowUp }
        : {
              summary: "This output was withheld: it contained content flagged as unsafe (a possible prompt-injection echo or an accidentally-included secret). A clinician must review the source request directly.",
              evidence: [], followUp: [], abstained: true,
              abstainReason: `Output withheld — flagged: ${scan.findings.map((f) => f.pattern).join(", ")}`,
              formatCompliant: parsed.formatCompliant,
          };

    const outputHash = createHash("sha256").update(JSON.stringify({ summary: result.summary, evidence: result.evidence, uncertainty: result.uncertainty, followUp: result.followUp })).digest("hex");

    return {
        ...result,
        outputHash,
        outputFlagged: !scan.safe,
        outputFlagReasons: scan.findings.map((f) => f.pattern),
    };
}
