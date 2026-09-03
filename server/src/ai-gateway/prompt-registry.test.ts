import { describe, expect, it } from "vitest";
import { CURRENT_PROMPT_VERSION, getSystemPrompt, PROMPT_VERSIONS, UnknownPromptVersionError } from "./prompt-registry.js";

describe("prompt-registry", () => {
    it("CURRENT_PROMPT_VERSION always resolves to a real, non-empty entry in PROMPT_VERSIONS", () => {
        expect(PROMPT_VERSIONS[CURRENT_PROMPT_VERSION]).toBeTruthy();
    });

    it("getSystemPrompt() with no argument resolves the current version", () => {
        const prompt = getSystemPrompt();
        expect(prompt.version).toBe(CURRENT_PROMPT_VERSION);
        expect(prompt.text).toBe(PROMPT_VERSIONS[CURRENT_PROMPT_VERSION]);
    });

    it("getSystemPrompt(version) pins an explicit known version — the rollback mechanism", () => {
        const prompt = getSystemPrompt("clinical-gateway-prompt-v1");
        expect(prompt.version).toBe("clinical-gateway-prompt-v1");
        expect(prompt.text).toContain("ABSTAIN");
    });

    it("throws UnknownPromptVersionError for an unrecognized version, rather than silently falling back to current", () => {
        expect(() => getSystemPrompt("does-not-exist")).toThrow(UnknownPromptVersionError);
        expect(() => getSystemPrompt("does-not-exist")).toThrow(/Unknown prompt version/);
    });

    it("the registry is frozen — no accidental mutation of a shipped version's text", () => {
        expect(Object.isFrozen(PROMPT_VERSIONS)).toBe(true);
    });
});
