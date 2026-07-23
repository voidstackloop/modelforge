import { describe, it, expect } from "vitest";
import { isTransientError } from "./transient-errors";

describe("isTransientError", () => {
    it("treats network-level failures as transient", () => {
        expect(isTransientError("Can't reach Ollama at http://127.0.0.1:11434 — is it running? (fetch failed)")).toBe(true);
        expect(isTransientError("request to https://api.openai.com failed, reason: ECONNRESET")).toBe(true);
        expect(isTransientError("The request timed out after 30s")).toBe(true);
    });

    it("treats rate limits and server errors as transient", () => {
        expect(isTransientError("OpenAI request failed (HTTP 529): overloaded_error")).toBe(true);
        expect(isTransientError("Rate limit exceeded, HTTP 429")).toBe(true);
        expect(isTransientError("Gemini request failed (HTTP 503)")).toBe(true);
    });

    it("does not retry auth or validation errors", () => {
        expect(isTransientError("Incorrect API key provided (HTTP 401)")).toBe(false);
        expect(isTransientError("model 'gpt-99' not found (HTTP 404)")).toBe(false);
        expect(isTransientError("Agent mode isn't supported yet for Gemini")).toBe(false);
    });
});
