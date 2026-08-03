import { describe, it, expect } from "vitest";
import { shouldAutoLock } from "./case-auto-lock";

describe("shouldAutoLock", () => {
    it("never locks when the timeout is unset or zero (disabled)", () => {
        expect(shouldAutoLock(999_999_999, undefined)).toBe(false);
        expect(shouldAutoLock(999_999_999, 0)).toBe(false);
    });

    it("does not lock before the configured timeout has elapsed", () => {
        expect(shouldAutoLock(4 * 60_000, 5)).toBe(false);
    });

    it("locks once the configured timeout has elapsed", () => {
        expect(shouldAutoLock(5 * 60_000, 5)).toBe(true);
        expect(shouldAutoLock(10 * 60_000, 5)).toBe(true);
    });

    it("treats a negative timeout as disabled rather than locking immediately", () => {
        expect(shouldAutoLock(1, -5)).toBe(false);
    });
});
