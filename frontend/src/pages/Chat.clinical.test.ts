import { describe, it, expect } from "vitest";
import { CLINICAL_MODES, CLINICAL_RESPONSE_CONTRACT, EMERGENCY_BANNER_TEXT } from "@/lib/clinical-constants";

describe("clinical response contract", () => {
    it("includes all eight required sections in order", () => {
        const sections = [
            "1. Summary",
            "2. Known patient facts",
            "3. Assessment or possible interpretations",
            "4. Missing information",
            "5. Red flags and urgent concerns",
            "6. Suggested next clinical steps",
            "7. Evidence and citations",
            "8. Uncertainty and limitations",
        ];
        let lastIndex = -1;
        for (const section of sections) {
            const index = CLINICAL_RESPONSE_CONTRACT.indexOf(section);
            expect(index).toBeGreaterThan(lastIndex);
            lastIndex = index;
        }
    });

    it("instructs the model not to fabricate patient facts or sources", () => {
        expect(CLINICAL_RESPONSE_CONTRACT).toMatch(/not fabricate/i);
    });

    it("clarifies this is decision support, not autonomous diagnosis", () => {
        expect(CLINICAL_RESPONSE_CONTRACT).toMatch(/not.*(an autonomous diagnosis|treating the patient)/i);
    });
});

describe("clinical modes", () => {
    it("defaults to a general, unopinionated mode", () => {
        expect(CLINICAL_MODES.none.instruction).toBeNull();
    });

    it("every non-default mode has a non-empty instruction", () => {
        for (const [key, mode] of Object.entries(CLINICAL_MODES)) {
            if (key === "none") continue;
            expect(mode.instruction).toBeTruthy();
        }
    });
});

describe("emergency banner text", () => {
    it("tells the user to contact emergency services, not to trust the AI response", () => {
        expect(EMERGENCY_BANNER_TEXT).toMatch(/emergency/i);
        expect(EMERGENCY_BANNER_TEXT).toMatch(/do not wait/i);
    });
});
