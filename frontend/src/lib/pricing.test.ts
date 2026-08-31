import { describe, it, expect } from "vitest";
import { estimateCost, formatCost } from "./pricing";

describe("estimateCost", () => {
    it("returns null for a model with no known pricing (e.g. any local GGUF model)", () => {
        expect(estimateCost("llama3.2", 1000, 500)).toBeNull();
    });

    it("computes input+output cost for a known model", () => {
        // gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output
        const cost = estimateCost("gpt-4o-mini", 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(0.15 + 0.6);
    });

    it("treats missing token counts as zero instead of throwing", () => {
        expect(estimateCost("gpt-4o-mini", undefined, undefined)).toBe(0);
    });
});

describe("formatCost", () => {
    it("shows a flat $0.00 for zero cost", () => {
        expect(formatCost(0)).toBe("$0.00");
    });

    it("uses extra precision for sub-cent costs", () => {
        expect(formatCost(0.0034)).toBe("$0.0034");
    });

    it("rounds to cents for larger costs", () => {
        expect(formatCost(1.2345)).toBe("$1.23");
    });
});
