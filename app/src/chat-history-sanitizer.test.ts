import { describe, expect, it } from "vitest";
import { isLikelyDegenerateAssistantOutput, sanitizeChatHistory } from "./chat-history-sanitizer";
import type { ChatMessage } from "./providers/types";

describe("isLikelyDegenerateAssistantOutput", () => {
    it("detects the repeated zero output observed from the local runtime", () => {
        const output = `This is 0. You 0. 1 This is 0 Zero ${"0 ".repeat(45)}This`;
        expect(isLikelyDegenerateAssistantOutput(output)).toBe(true);
    });

    it("does not reject a normal concise response", () => {
        expect(isLikelyDegenerateAssistantOutput("Cancer is a group of diseases involving uncontrolled cell growth.")).toBe(false);
    });
});

describe("sanitizeChatHistory", () => {
    it("removes application errors and their failed user turns but keeps the newest user request", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "Be helpful." },
            { role: "user", content: "hi" },
            { role: "assistant", content: "⚠️ llama.cpp is changing its backend." },
            { role: "user", content: "say something about cancer" },
        ];
        const result = sanitizeChatHistory(messages);

        expect(result.messages).toEqual([
            { role: "system", content: "Be helpful." },
            { role: "user", content: "say something about cancer" },
        ]);
        expect(result.resetApplied).toBe(false);
        expect(result.exclusions.map((item) => item.reason)).toEqual(["failed-turn-user", "application-error"]);
    });

    it("removes every copy of a long repeated assistant response and the associated user turns", () => {
        const repeated = "I cannot generate a story because my current operational state is displaying only zeros and backend errors.";
        const messages: ChatMessage[] = [
            { role: "user", content: "write a story" },
            { role: "assistant", content: repeated },
            { role: "user", content: "hi" },
            { role: "assistant", content: repeated },
            { role: "user", content: "say something about cancer" },
        ];
        const result = sanitizeChatHistory(messages);

        expect(result.messages).toEqual([{ role: "user", content: "say something about cancer" }]);
        expect(result.resetApplied).toBe(true);
        expect(result.exclusions.filter((item) => item.reason === "repeated-output")).toHaveLength(2);
    });

    it("honors the explicit exclusion marker used for newly created error cards", () => {
        const messages: ChatMessage[] = [
            { role: "user", content: "hi" },
            { role: "assistant", content: "runtime failed", excludedFromContext: true },
            { role: "user", content: "new question" },
        ];
        expect(sanitizeChatHistory(messages).messages).toEqual([{ role: "user", content: "new question" }]);
    });

    it("keeps repeated short acknowledgements because they are not evidence of context poisoning", () => {
        const messages: ChatMessage[] = [
            { role: "user", content: "thanks" },
            { role: "assistant", content: "You're welcome!" },
            { role: "user", content: "thanks again" },
            { role: "assistant", content: "You're welcome!" },
            { role: "user", content: "next question" },
        ];
        expect(sanitizeChatHistory(messages).messages).toEqual(messages);
    });

    it("resets a severely poisoned conversation to system messages and the newest user prompt", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "hi" },
            { role: "assistant", content: `This is 0 ${"0 ".repeat(40)}` },
            { role: "user", content: "try again" },
            { role: "assistant", content: "I am unable to answer because of a backend configuration issue with llama.cpp." },
            { role: "user", content: "Explain cancer in one sentence." },
        ];
        const result = sanitizeChatHistory(messages);

        expect(result.resetApplied).toBe(true);
        expect(result.messages).toEqual([
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Explain cancer in one sentence." },
        ]);
        expect(result.exclusions.some((item) => item.reason === "runtime-failure-claim")).toBe(true);
    });
});
