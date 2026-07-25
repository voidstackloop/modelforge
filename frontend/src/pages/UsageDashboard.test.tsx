import { describe, expect, it } from "vitest";
import { formatEnergy } from "./UsageDashboard";

describe("formatEnergy", () => {
    it("converts kWh to Wh using the correct factor", () => {
        expect(formatEnergy(0.0005)).toBe("0.5 Wh");
    });
});
