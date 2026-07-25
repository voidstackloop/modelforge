import { describe, it, expect } from "vitest";
import { formatModelRef, formatCustomModelRef, parseCustomModelId, parseModelRef } from "./providers";

describe("formatModelRef / parseModelRef", () => {
    it("round-trips a plain provider:model reference", () => {
        expect(parseModelRef(formatModelRef("openai", "gpt-5"))).toEqual({ provider: "openai", modelId: "gpt-5" });
    });

    it("preserves colons already inside the model id (e.g. Ollama tags)", () => {
        expect(parseModelRef(formatModelRef("ollama", "llama3.1:8b"))).toEqual({
            provider: "ollama",
            modelId: "llama3.1:8b",
        });
    });

    it("rejects an unknown provider prefix", () => {
        expect(parseModelRef("notaprovider:foo")).toBeNull();
    });

    it("rejects a string with no colon at all", () => {
        expect(parseModelRef("nocolonhere")).toBeNull();
    });

    it("accepts gemini and custom as valid providers", () => {
        expect(parseModelRef(formatModelRef("gemini", "gemini-2.5-pro"))?.provider).toBe("gemini");
        expect(parseModelRef(formatModelRef("custom", "abc::model-x"))?.provider).toBe("custom");
    });

    it("round-trips every managed local runtime", () => {
        for (const provider of ["mlx", "rocm", "vllm"] as const) {
            expect(parseModelRef(formatModelRef(provider, "publisher/model"))).toEqual({
                provider,
                modelId: "publisher/model",
            });
        }
    });
});

describe("formatCustomModelRef / parseCustomModelId", () => {
    it("round-trips a custom provider id and model id", () => {
        const ref = formatCustomModelRef("groq-1", "llama-3.3-70b-versatile");
        const parsed = parseModelRef(ref);
        expect(parsed?.provider).toBe("custom");
        expect(parseCustomModelId(parsed!.modelId)).toEqual({
            customProviderId: "groq-1",
            actualModel: "llama-3.3-70b-versatile",
        });
    });

    it("returns null for a modelId with no custom-provider separator", () => {
        expect(parseCustomModelId("just-a-model")).toBeNull();
    });
});
