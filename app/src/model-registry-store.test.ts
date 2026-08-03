import { describe, it, expect, beforeEach } from "vitest";
import * as modelRegistry from "./model-registry-store";

describe("model-registry-store", () => {
    beforeEach(() => {
        for (const m of modelRegistry.listApprovedModels()) modelRegistry.removeModel(m.id);
    });

    it("is inactive (unrestricted) when empty — the default state", () => {
        expect(modelRegistry.isRegistryActive()).toBe(false);
        expect(modelRegistry.isApproved("openai", "gpt-5")).toBe(false);
    });

    it("approving a model makes it approved and activates the registry", () => {
        modelRegistry.approveModel("openai", "gpt-5", ["soap-notes"], "admin");
        expect(modelRegistry.isRegistryActive()).toBe(true);
        expect(modelRegistry.isApproved("openai", "gpt-5")).toBe(true);
        expect(modelRegistry.isApproved("openai", "gpt-4o")).toBe(false);
    });

    it("re-approving the same provider+model updates in place rather than duplicating", () => {
        modelRegistry.approveModel("openai", "gpt-5", ["soap-notes"]);
        modelRegistry.approveModel("openai", "gpt-5", ["soap-notes", "discharge-summary"]);
        const entries = modelRegistry.listApprovedModels().filter((m) => m.provider === "openai" && m.modelId === "gpt-5");
        expect(entries).toHaveLength(1);
        expect(entries[0].approvedUseCases).toEqual(["soap-notes", "discharge-summary"]);
    });

    it("retiring a model makes it no longer approved but keeps the record (retiredAt set)", () => {
        const entry = modelRegistry.approveModel("ollama", "llama3.2", []);
        modelRegistry.retireModel(entry.id);
        expect(modelRegistry.isApproved("ollama", "llama3.2")).toBe(false);
        const found = modelRegistry.listApprovedModels().find((m) => m.id === entry.id);
        expect(found?.retiredAt).toBeTruthy();
    });

    it("the registry stays active if at least one other model is still approved after a retirement", () => {
        modelRegistry.approveModel("openai", "gpt-5", []);
        const second = modelRegistry.approveModel("anthropic", "claude-sonnet-5", []);
        modelRegistry.retireModel(second.id);
        expect(modelRegistry.isRegistryActive()).toBe(true);
        expect(modelRegistry.isApproved("openai", "gpt-5")).toBe(true);
    });

    it("the registry becomes inactive again once every entry is retired", () => {
        const entry = modelRegistry.approveModel("openai", "gpt-5", []);
        modelRegistry.retireModel(entry.id);
        expect(modelRegistry.isRegistryActive()).toBe(false);
    });

    it("removeModel deletes the entry outright, unlike retire", () => {
        const entry = modelRegistry.approveModel("openai", "gpt-5", []);
        modelRegistry.removeModel(entry.id);
        expect(modelRegistry.listApprovedModels()).toHaveLength(0);
    });

    it("retiring or removing a non-existent id does not throw", () => {
        expect(() => modelRegistry.retireModel("does-not-exist")).not.toThrow();
        expect(() => modelRegistry.removeModel("does-not-exist")).not.toThrow();
    });
});
