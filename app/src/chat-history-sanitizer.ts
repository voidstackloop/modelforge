import type { ChatMessage } from "./providers/types";

export type ContextExclusionReason =
    | "explicit"
    | "application-error"
    | "degenerate-output"
    | "repeated-output"
    | "runtime-failure-claim"
    | "context-reset"
    | "failed-turn-user";

export interface ContextExclusion {
    index: number;
    role: ChatMessage["role"];
    reason: ContextExclusionReason;
    chars: number;
}

export interface SanitizedChatHistory {
    messages: ChatMessage[];
    exclusions: ContextExclusion[];
    resetApplied: boolean;
}

function normalizedResponse(text: string): string {
    return text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/**
 * Detects the failure mode produced by severely degraded local generations:
 * a long response dominated by one token (for example, dozens of `0`/`O`
 * tokens). It deliberately requires a substantial sample so normal short
 * acknowledgements such as "OK" are never treated as corrupt output.
 */
export function isLikelyDegenerateAssistantOutput(text: string): boolean {
    const tokens = text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length < 20) return false;

    const counts = new Map<string, number>();
    let mostFrequent = 0;
    for (const token of tokens) {
        const count = (counts.get(token) ?? 0) + 1;
        counts.set(token, count);
        mostFrequent = Math.max(mostFrequent, count);
    }
    return mostFrequent / tokens.length >= 0.45 && counts.size / tokens.length <= 0.35;
}

/**
 * Removes failed local-inference turns before they are sent back to any
 * provider. Displayed session history remains untouched; this only builds the
 * inference context. Without this boundary, renderer-generated error cards,
 * degenerate `0/Zero` output, and a long response repeated across turns become
 * examples the next model is explicitly instructed to imitate.
 */
export function sanitizeChatHistory(messages: ChatMessage[]): SanitizedChatHistory {
    const excluded = new Map<number, ContextExclusionReason>();
    let latestUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            latestUserIndex = i;
            break;
        }
    }

    const repeatedCandidates = new Map<string, number[]>();
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role !== "assistant" || message.toolCalls?.length) continue;

        if (message.excludedFromContext) {
            excluded.set(i, "explicit");
            continue;
        }
        if (message.content.trimStart().startsWith("⚠️")) {
            excluded.set(i, "application-error");
            continue;
        }
        if (isLikelyDegenerateAssistantOutput(message.content)) {
            excluded.set(i, "degenerate-output");
            continue;
        }

        const normalized = normalizedResponse(message.content);
        if (normalized.length >= 80) {
            const indices = repeatedCandidates.get(normalized) ?? [];
            indices.push(i);
            repeatedCandidates.set(normalized, indices);
        }
    }

    for (const indices of repeatedCandidates.values()) {
        if (indices.length < 2) continue;
        for (const index of indices) excluded.set(index, "repeated-output");
    }

    // Once the transcript contains objective corruption evidence, later model
    // prose claiming it is "unable" because of llama.cpp/backend state is a
    // learned continuation of that corruption, not a real runtime diagnosis.
    // This intentionally depends on prior hard evidence so a legitimate user
    // conversation *about* backend configuration is not filtered by keywords.
    const hasCorruptionEvidence = [...excluded.values()].some(
        (reason) => reason === "degenerate-output" || reason === "repeated-output"
    );
    if (hasCorruptionEvidence) {
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (excluded.has(i) || message.role !== "assistant" || message.toolCalls?.length) continue;
            if (
                /\b(?:backend configuration issue|current operational state)\b/i.test(message.content) ||
                (/\b(?:unable|cannot)\b/i.test(message.content) && /\b(?:backend|llama\.cpp)\b/i.test(message.content))
            ) {
                excluded.set(i, "runtime-failure-claim");
            }
        }
    }

    // A failed assistant output and the user turn that elicited it form one
    // unusable example. Remove both sides; otherwise a run of old unanswered
    // user instructions ("write a story", "hi", ...) can still outweigh the
    // current prompt. The newest user message is always preserved.
    for (const assistantIndex of [...excluded.keys()]) {
        const userIndex = assistantIndex - 1;
        if (userIndex >= 0 && userIndex !== latestUserIndex && messages[userIndex].role === "user") {
            excluded.set(userIndex, "failed-turn-user");
        }
    }

    // A fresh user turn following hard corruption gets a clean inference
    // context. Keeping any older conversational examples here lets one
    // uncaught variant immediately regenerate the poison. The transcript is
    // not modified; only the context sent to the provider is reset. Tool-loop
    // continuations end in a tool message, not a user message, and therefore
    // deliberately do not take this recovery path.
    const resetApplied = messages.at(-1)?.role === "user" && [...excluded.values()].some(
        (reason) => reason === "degenerate-output" || reason === "repeated-output" || reason === "runtime-failure-claim"
    );
    if (resetApplied) {
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role !== "system" && i !== latestUserIndex && !excluded.has(i)) {
                excluded.set(i, "context-reset");
            }
        }
    }

    const exclusions: ContextExclusion[] = [...excluded.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, reason]) => ({ index, role: messages[index].role, reason, chars: messages[index].content.length }));

    return {
        messages: messages.filter((_message, index) => !excluded.has(index)),
        exclusions,
        resetApplied,
    };
}
