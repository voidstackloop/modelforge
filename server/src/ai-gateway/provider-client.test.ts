import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleInferenceClient, resolveCredentialReference } from "./provider-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAiCompatibleInferenceClient", () => {
    it("authenticates model identity checks and chat requests", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "approved-model" }] }), { status: 200, headers: { "content-type": "application/json" } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "safe output" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } }));
        vi.stubGlobal("fetch", fetchMock);
        const client = new OpenAiCompatibleInferenceClient("https://inference.example/v1", "secret-token", "approved-model", "v1");
        await expect(client.healthCheck()).resolves.toBe(true);
        await expect(client.invoke({ purposeOfUse: "test", sections: [{ category: "summary", text: "synthetic" }] })).resolves.toMatchObject({ rawText: "safe output", modelVersion: "v1", usage: { promptTokens: 4, completionTokens: 2 } });
        expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer secret-token" });
        expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ Authorization: "Bearer secret-token" });
    });

    it("does not expose a provider response body in errors", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("synthetic patient content", { status: 500 })));
        const client = new OpenAiCompatibleInferenceClient("https://inference.example/v1", "secret-token", "approved-model", "v1");
        await expect(client.invoke({ purposeOfUse: "test", sections: [{ category: "summary", text: "synthetic" }] })).rejects.toThrow("HTTP 500");
        await expect(client.invoke({ purposeOfUse: "test", sections: [{ category: "summary", text: "synthetic" }] })).rejects.not.toThrow("patient content");
    });
});

describe("resolveCredentialReference", () => {
    it("resolves allowlisted environment references", () => expect(resolveCredentialReference("env:INFERENCE_KEY", { INFERENCE_KEY: "value" })).toBe("value"));
    it("rejects arbitrary reference formats", () => expect(() => resolveCredentialReference("vault:anywhere", {})).toThrow(/env:NAME/));
});
