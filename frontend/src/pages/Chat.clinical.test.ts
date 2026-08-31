import { describe, it, expect } from "vitest";
import {
    CLINICAL_MODES,
    CLINICAL_RESPONSE_CONTRACT,
    EMERGENCY_BANNER_TEXT,
    RESPONSE_CONTRACT_SECTION_HEADINGS,
    checkResponseContractCompliance,
} from "@/lib/clinical-constants";

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

describe("checkResponseContractCompliance", () => {
    it("is not applicable to a short, non-clinical reply with no section headings", () => {
        const result = checkResponseContractCompliance("Thanks, that's helpful!");
        expect(result.applicable).toBe(false);
        expect(result.missingSections).toEqual([]);
    });

    it("reports no missing sections for a fully compliant response", () => {
        const fullResponse = RESPONSE_CONTRACT_SECTION_HEADINGS.map((h) => `${h}\nSome content here.`).join("\n\n");
        const result = checkResponseContractCompliance(fullResponse);
        expect(result.applicable).toBe(true);
        expect(result.missingSections).toEqual([]);
    });

    it("flags a specific missing section on a response that attempted the contract but dropped one", () => {
        const partial = RESPONSE_CONTRACT_SECTION_HEADINGS.filter((h) => h !== "5. Red flags and urgent concerns")
            .map((h) => `${h}\nSome content.`)
            .join("\n\n");
        const result = checkResponseContractCompliance(partial);
        expect(result.applicable).toBe(true);
        expect(result.missingSections).toEqual(["5. Red flags and urgent concerns"]);
    });

    it("flags multiple missing sections, in contract order, not discovery order", () => {
        // Only sections 1 and 8 present — 2 through 7 should all be reported,
        // in their original contract order regardless of how the response
        // itself is structured.
        const partial = "1. Summary\nBrief note.\n\n8. Uncertainty and limitations\nSome uncertainty.";
        const result = checkResponseContractCompliance(partial);
        expect(result.applicable).toBe(true);
        expect(result.missingSections).toEqual([
            "2. Known patient facts",
            "3. Assessment or possible interpretations",
            "4. Missing information",
            "5. Red flags and urgent concerns",
            "6. Suggested next clinical steps",
            "7. Evidence and citations",
        ]);
    });

    it("is applicable as soon as even one section heading is present, not requiring a majority", () => {
        const result = checkResponseContractCompliance("1. Summary\nJust this one section.");
        expect(result.applicable).toBe(true);
        expect(result.missingSections).toHaveLength(7);
    });
});
