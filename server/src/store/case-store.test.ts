import { describe, it, expect } from "vitest";
import { parseVersionCursor } from "./case-store.js";

describe("parseVersionCursor", () => {
    it("returns null for a null cursor (no filter — everything)", () => {
        expect(parseVersionCursor(null)).toBeNull();
    });

    it("parses a plain unsigned-integer string", () => {
        expect(parseVersionCursor("42")).toBe(42n);
    });

    it("parses \"0\" as a real cursor, not as absent", () => {
        expect(parseVersionCursor("0")).toBe(0n);
    });

    it("parses a value beyond JS's safe-integer range without precision loss", () => {
        expect(parseVersionCursor("9007199254740993")).toBe(9007199254740993n);
    });

    it.each(["", "abc", "-1", "1.5", "1e3", " 1", "1 ", "0x10"])("treats malformed cursor %j as absent rather than throwing", (bad) => {
        expect(parseVersionCursor(bad)).toBeNull();
    });
});
