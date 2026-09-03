import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636), S256 only — required for this flow since it is a public
 * client (no client_secret; see token-crypto.ts's own doc comment on why).
 * `codeVerifier` is a high-entropy random string never sent to the
 * authorization endpoint; `codeChallenge` (its SHA-256, base64url-encoded)
 * is sent instead, and the verifier is presented only at the token
 * exchange — the mechanism that lets a public client prove it, not an
 * attacker who merely intercepted the authorization code, is the one
 * completing the exchange.
 */
export interface PkcePair {
    codeVerifier: string;
    codeChallenge: string;
}

function base64UrlEncode(input: Buffer): string {
    return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url-encoded — 43 characters, comfortably within
 * RFC 7636's required 43-128 character range for a code_verifier. */
export function generatePkcePair(): PkcePair {
    const codeVerifier = base64UrlEncode(randomBytes(32));
    const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
    return { codeVerifier, codeChallenge };
}

/** A cryptographically random, URL-safe `state` value (CSRF protection —
 * see smart-launch/service.ts's own doc comment on how it's used). Same
 * generation shape as a PKCE verifier but a distinct, unrelated value. */
export function generateState(): string {
    return base64UrlEncode(randomBytes(24));
}
