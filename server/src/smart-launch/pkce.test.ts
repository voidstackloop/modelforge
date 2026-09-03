import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePkcePair, generateState } from "./pkce.js";

describe("generatePkcePair", () => {
    it("produces a code_challenge that is the SHA-256(codeVerifier), base64url encoded", () => {
        const { codeVerifier, codeChallenge } = generatePkcePair();
        const expected = createHash("sha256").update(codeVerifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        expect(codeChallenge).toBe(expected);
    });

    it("codeVerifier is within RFC 7636's required 43-128 character range", () => {
        const { codeVerifier } = generatePkcePair();
        expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
        expect(codeVerifier.length).toBeLessThanOrEqual(128);
    });

    it("is URL-safe (no +, /, or = padding)", () => {
        const { codeVerifier, codeChallenge } = generatePkcePair();
        expect(codeVerifier).not.toMatch(/[+/=]/);
        expect(codeChallenge).not.toMatch(/[+/=]/);
    });

    it("generates a different pair every call", () => {
        const a = generatePkcePair();
        const b = generatePkcePair();
        expect(a.codeVerifier).not.toBe(b.codeVerifier);
        expect(a.codeChallenge).not.toBe(b.codeChallenge);
    });
});

describe("generateState", () => {
    it("is URL-safe and generates a different value every call", () => {
        const a = generateState();
        const b = generateState();
        expect(a).not.toBe(b);
        expect(a).not.toMatch(/[+/=]/);
        expect(a.length).toBeGreaterThan(20);
    });
});
