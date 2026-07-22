import { describe, it, expect } from "vitest";
import { computeLineDiff } from "./diff";

describe("computeLineDiff", () => {
    it("marks identical text as all same", () => {
        const diff = computeLineDiff("a\nb\nc", "a\nb\nc");
        expect(diff.every((d) => d.type === "same")).toBe(true);
    });

    it("marks new content as additions when there's nothing to keep", () => {
        const diff = computeLineDiff("", "a\nb");
        expect(diff.filter((d) => d.type === "add").map((d) => d.text)).toEqual(["a", "b"]);
    });

    it("detects a single changed line surrounded by unchanged context", () => {
        const diff = computeLineDiff("a\nb\nc", "a\nX\nc");
        expect(diff).toEqual([
            { type: "same", text: "a" },
            { type: "remove", text: "b" },
            { type: "add", text: "X" },
            { type: "same", text: "c" },
        ]);
    });

    it("detects a pure insertion", () => {
        const diff = computeLineDiff("a\nc", "a\nb\nc");
        expect(diff).toEqual([
            { type: "same", text: "a" },
            { type: "add", text: "b" },
            { type: "same", text: "c" },
        ]);
    });

    it("detects a pure deletion", () => {
        const diff = computeLineDiff("a\nb\nc", "a\nc");
        expect(diff).toEqual([
            { type: "same", text: "a" },
            { type: "remove", text: "b" },
            { type: "same", text: "c" },
        ]);
    });
});
