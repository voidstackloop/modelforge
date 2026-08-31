import { describe, it, expect } from "vitest";
import { summarizeSession, aggregateBy, formatEnergy } from "./usage";
import type { ChatSession } from "@/types/electron";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
    return {
        id: "1",
        title: "Test chat",
        model: "openai:gpt-4o-mini",
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("summarizeSession", () => {
    it("sums usage across messages and attributes it to the session's current model", () => {
        const usage = summarizeSession(
            makeSession({
                messages: [
                    { role: "user", content: "hi" },
                    { role: "assistant", content: "hello", usage: { promptTokens: 10, completionTokens: 5 } },
                    { role: "user", content: "more" },
                    { role: "assistant", content: "reply", usage: { promptTokens: 20, completionTokens: 8 } },
                ],
            })
        );

        expect(usage.provider).toBe("openai");
        expect(usage.modelId).toBe("gpt-4o-mini");
        expect(usage.promptTokens).toBe(30);
        expect(usage.completionTokens).toBe(13);
        expect(usage.cost).not.toBeNull();
    });

    it("returns null cost for a model with no known pricing", () => {
        const usage = summarizeSession(
            makeSession({
                model: "llamacpp:llama3.2",
                messages: [{ role: "assistant", content: "hi", usage: { promptTokens: 10, completionTokens: 5 } }],
            })
        );
        expect(usage.cost).toBeNull();
        expect(usage.promptTokens).toBe(10);
    });

    it("returns zero usage for a session with no usage data", () => {
        const usage = summarizeSession(makeSession({ messages: [{ role: "user", content: "hi" }] }));
        expect(usage.promptTokens).toBe(0);
        expect(usage.completionTokens).toBe(0);
    });
});

describe("aggregateBy", () => {
    it("groups and sums tokens/cost/session count by the given key", () => {
        const usages = [
            summarizeSession(
                makeSession({
                    id: "a",
                    model: "openai:gpt-4o-mini",
                    messages: [{ role: "assistant", content: "x", usage: { promptTokens: 10, completionTokens: 5 } }],
                })
            ),
            summarizeSession(
                makeSession({
                    id: "b",
                    model: "openai:gpt-4o-mini",
                    messages: [{ role: "assistant", content: "y", usage: { promptTokens: 20, completionTokens: 10 } }],
                })
            ),
            summarizeSession(
                makeSession({
                    id: "c",
                    model: "anthropic:claude-sonnet-5",
                    messages: [{ role: "assistant", content: "z", usage: { promptTokens: 5, completionTokens: 5 } }],
                })
            ),
        ];

        const byModel = aggregateBy(usages, (u) => u.modelId ?? "unknown");
        const gpt4oMini = byModel.find(([key]) => key === "gpt-4o-mini");
        expect(gpt4oMini?.[1].sessions).toBe(2);
        expect(gpt4oMini?.[1].tokens).toBe(45);
    });
});

describe("formatEnergy", () => {
    it("converts kWh to Wh using the correct factor", () => {
        expect(formatEnergy(0.0005)).toBe("0.5 Wh");
    });
});
