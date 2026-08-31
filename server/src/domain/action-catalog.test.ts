import { describe, it, expect } from "vitest";
import { ACTION_CATALOG, isKnownActionPattern, unknownActionPatterns } from "./action-catalog.js";

describe("ACTION_CATALOG", () => {
    it("has no duplicate entries", () => {
        const actions = ACTION_CATALOG.map((e) => e.action);
        expect(new Set(actions).size).toBe(actions.length);
    });

    it("every entry has a non-empty description", () => {
        for (const entry of ACTION_CATALOG) {
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });
});

describe("isKnownActionPattern", () => {
    it("accepts an exact catalog action", () => {
        expect(isKnownActionPattern("patientCase:view")).toBe(true);
    });

    it("rejects a string that matches nothing in the catalog", () => {
        expect(isKnownActionPattern("notPatientCase:view")).toBe(false);
        expect(isKnownActionPattern("patientCase:viewx")).toBe(false);
        expect(isKnownActionPattern("xpatientCase:view")).toBe(false);
    });

    it("rejects a plausible-looking typo (missing trailing s)", () => {
        expect(isKnownActionPattern("iam:manageUser")).toBe(false);
    });

    it("accepts the universal wildcard", () => {
        expect(isKnownActionPattern("*")).toBe(true);
    });

    it("accepts a namespace wildcard that matches at least one real action", () => {
        expect(isKnownActionPattern("iam:*")).toBe(true);
        expect(isKnownActionPattern("patientCase:*")).toBe(true);
    });

    it("rejects a namespace wildcard that matches nothing real", () => {
        expect(isKnownActionPattern("notARealNamespace:*")).toBe(false);
    });
});

describe("unknownActionPatterns", () => {
    it("returns an empty array when every action across every statement is known", () => {
        const document = {
            statements: [
                { actions: ["patientCase:view", "patientCase:edit"] },
                { actions: ["iam:*"] },
            ],
        };
        expect(unknownActionPatterns(document)).toEqual([]);
    });

    it("returns each unknown pattern exactly once, even if repeated across statements", () => {
        const document = {
            statements: [
                { actions: ["patientCase:view", "bogus:action"] },
                { actions: ["bogus:action", "also:bogus"] },
            ],
        };
        const unknown = unknownActionPatterns(document);
        expect(unknown).toHaveLength(2);
        expect(unknown).toEqual(expect.arrayContaining(["bogus:action", "also:bogus"]));
    });

    it("a fully-wildcard document ('*') is never flagged", () => {
        expect(unknownActionPatterns({ statements: [{ actions: ["*"] }] })).toEqual([]);
    });
});
