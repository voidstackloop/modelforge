// Approximate published pricing in USD per 1M tokens. Providers change pricing
// over time — treat these as estimates, not billing-accurate figures.
export interface ModelPricing {
    inputPer1M: number;
    outputPer1M: number;
}

export const PRICING: Record<string, ModelPricing> = {
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
    o3: { inputPer1M: 2, outputPer1M: 8 },
    "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
    "claude-opus-4-8": { inputPer1M: 15, outputPer1M: 75 },
    "claude-sonnet-5": { inputPer1M: 3, outputPer1M: 15 },
    "claude-haiku-4-5-20251001": { inputPer1M: 0.8, outputPer1M: 4 },
};

export function estimateCost(
    modelId: string,
    promptTokens: number | undefined,
    completionTokens: number | undefined
): number | null {
    const pricing = PRICING[modelId];
    if (!pricing) return null;
    const inCost = ((promptTokens ?? 0) / 1_000_000) * pricing.inputPer1M;
    const outCost = ((completionTokens ?? 0) / 1_000_000) * pricing.outputPer1M;
    return inCost + outCost;
}

export function formatCost(cost: number): string {
    if (cost === 0) return "$0.00";
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}
