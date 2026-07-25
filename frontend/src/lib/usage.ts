import { parseModelRef } from "@/lib/providers";
import { estimateCost } from "@/lib/pricing";
import type { ChatSession, ProviderId } from "@/types/electron";

export interface SessionUsage {
    session: ChatSession;
    provider: ProviderId | null;
    modelId: string | null;
    promptTokens: number;
    completionTokens: number;
    cost: number | null;
}

export interface UsageAggregate {
    tokens: number;
    cost: number;
    sessions: number;
}

// Usage is aggregated per session, not per message — sessions only store a
// single `model` field (the app doesn't track which model produced any given
// message if the user switched mid-conversation), so a session's entire
// token usage is attributed to whatever model it's currently set to. This
// matches the same simplification the per-message cost display already uses
// in Chat.tsx.
export function summarizeSession(session: ChatSession): SessionUsage {
    let promptTokens = 0;
    let completionTokens = 0;
    for (const m of session.messages) {
        if (m.usage) {
            promptTokens += m.usage.promptTokens ?? 0;
            completionTokens += m.usage.completionTokens ?? 0;
        }
    }
    const parsed = session.model ? parseModelRef(session.model) : null;
    const cost = parsed ? estimateCost(parsed.modelId, promptTokens, completionTokens) : null;
    return {
        session,
        provider: parsed?.provider ?? null,
        modelId: parsed?.modelId ?? null,
        promptTokens,
        completionTokens,
        cost,
    };
}

export function formatEnergy(value: number): string {
    return value < 0.001 ? `${(value * 1_000).toFixed(1)} Wh` : `${value.toFixed(4)} kWh`;
}

export function aggregateBy(usages: SessionUsage[], keyOf: (u: SessionUsage) => string): [string, UsageAggregate][] {
    const map = new Map<string, UsageAggregate>();
    for (const u of usages) {
        const key = keyOf(u);
        const entry = map.get(key) ?? { tokens: 0, cost: 0, sessions: 0 };
        entry.tokens += u.promptTokens + u.completionTokens;
        entry.cost += u.cost ?? 0;
        entry.sessions += 1;
        map.set(key, entry);
    }
    return [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
}
