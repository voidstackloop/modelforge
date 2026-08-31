// Defensive scrubbing for the few free-text strings that could still reach
// telemetry (an error message before it's reduced to its errorKind enum, or
// a future logger.ts-migration call site). The typed event schemas in
// schema.ts avoid needing this on the happy path — every field there is a
// number, boolean, or fixed enum — but redact.ts exists as reusable,
// independently-tested defense in depth, and as the shared utility a future
// logger.* migration will need.

const REDACTED = "[redacted]";

// Order matters: more specific patterns (bearer tokens, URLs) run before the
// generic path pattern, since a URL or authorization header can itself
// contain characters a path pattern would otherwise partially match.
const PATTERNS: { name: string; regex: RegExp }[] = [
    // "Authorization: Bearer <token>" or a bare "Bearer <token>" fragment.
    { name: "authorization-header", regex: /\b(authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi },
    // Common API-key-shaped tokens (sk-..., ghp_..., etc.) — a coarse net,
    // not an exhaustive provider-specific list.
    { name: "api-key", regex: /\b(sk|pk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/g },
    // http(s) URLs, including any query string — the query string is the
    // part most likely to carry a token/signature, so the whole URL is
    // dropped rather than trying to keep the origin.
    { name: "url", regex: /\bhttps?:\/\/[^\s"'<>]+/gi },
    // Windows paths: `C:\...` or `\\server\share\...`.
    { name: "windows-path", regex: /\b[A-Za-z]:\\(?:[^\s\\/:*?"<>|\r\n]+\\)*[^\s\\/:*?"<>|\r\n]*|\\\\[^\s\\]+(?:\\[^\s\\]+)+/g },
    // POSIX absolute paths — home directories and common system prefixes,
    // not every string containing a slash (which would over-redact plain
    // prose and JSON keys like "actions/resources").
    { name: "posix-path", regex: /\B\/(?:home|Users|root|etc|var|tmp|opt|mnt)\/[^\s"'<>]*/g },
    // Email addresses.
    { name: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/** Replaces every recognized sensitive-shaped substring in `text` with a
 * fixed `[redacted]` marker. Never throws; an unrecognized pattern is simply
 * left in place — this is a defensive net for known-dangerous shapes, not a
 * guarantee of exhaustive scrubbing, which is why the typed event schemas
 * avoid depending on it for anything that's already structured. */
export function redactText(text: string): string {
    let result = text;
    for (const { regex } of PATTERNS) {
        result = result.replace(regex, REDACTED);
    }
    return result;
}

/** Recursively applies redactText() to every string value in a plain
 * JSON-shaped value (object/array/primitive) — for the rare case a caller
 * hands telemetry a structured-but-unreviewed blob (e.g. bridging a legacy
 * logger.* call) rather than a typed schema.ts event. */
export function redactDeep<T>(value: T): T {
    if (typeof value === "string") return redactText(value) as unknown as T;
    if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(val);
        return out as T;
    }
    return value;
}
