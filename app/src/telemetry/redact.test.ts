import { describe, it, expect } from "vitest";
import { redactText, redactDeep } from "./redact";

describe("redactText", () => {
    it("redacts an Authorization: Bearer header", () => {
        const input = "request failed, Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123";
        expect(redactText(input)).not.toMatch(/eyJ/);
        expect(redactText(input)).toContain("[redacted]");
    });

    it("redacts a bare bearer token fragment without the header prefix", () => {
        expect(redactText("token was bearer sk-abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    });

    it("redacts common API-key shapes", () => {
        for (const key of ["sk-abcdefghij1234567890", "ghp_abcdefghij1234567890", "xoxb-abcdefghij1234567890"]) {
            expect(redactText(`leaked key: ${key}`)).not.toContain(key);
        }
    });

    it("redacts a full URL including its query string", () => {
        const input = "GET https://api.example.com/v1/models?api_key=super-secret&user=alice failed";
        const result = redactText(input);
        expect(result).not.toContain("super-secret");
        expect(result).not.toContain("api.example.com");
    });

    it("redacts a Windows absolute path", () => {
        expect(redactText(String.raw`failed to read C:\Users\alice\AppData\Roaming\ModelForge\secrets.json`)).not.toMatch(/alice/);
    });

    it("redacts a UNC Windows path", () => {
        expect(redactText(String.raw`failed to read \\fileserver\share\patients\record.json`)).not.toMatch(/patients/);
    });

    it("redacts a POSIX home-directory path", () => {
        expect(redactText("failed to read /home/alice/.config/modelforge/settings.json")).not.toMatch(/alice/);
    });

    it("redacts an email address", () => {
        expect(redactText("account owner: dr.smith@example-hospital.test")).not.toMatch(/dr\.smith/);
    });

    it("redacts a representative PHI-shaped canary embedded in a free-text message", () => {
        const input = "failed while processing patient record for jane.doe@clinic.example at /home/clinician/cases/case-42.json";
        const result = redactText(input);
        expect(result).not.toMatch(/jane\.doe/);
        expect(result).not.toMatch(/case-42/);
    });

    it("leaves ordinary prose untouched", () => {
        expect(redactText("Download completed successfully after 3 retries.")).toBe("Download completed successfully after 3 retries.");
    });

    it("handles multiple distinct sensitive substrings in one message", () => {
        const input = "user dr.smith@example-hospital.test at /home/dr-smith hit https://api.example.com/x?token=abc";
        const result = redactText(input);
        expect(result).not.toMatch(/dr\.smith@|dr-smith|api\.example\.com/);
    });

    it("never throws on malformed/unusual input", () => {
        expect(() => redactText("")).not.toThrow();
        expect(() => redactText("\u0000\uFFFF")).not.toThrow();
    });
});

describe("redactDeep", () => {
    it("redacts string values nested in objects and arrays", () => {
        const input = {
            message: "failed for user at /home/alice/case.json",
            nested: { url: "https://api.example.com/x?token=abc" },
            list: ["plain text", "contact dr.smith@example-hospital.test"],
        };
        const result = redactDeep(input) as typeof input;
        expect(result.message).not.toMatch(/alice/);
        expect(result.nested.url).not.toMatch(/api\.example\.com/);
        expect(result.list[1]).not.toMatch(/dr\.smith/);
        expect(result.list[0]).toBe("plain text");
    });

    it("leaves numbers, booleans, and null untouched", () => {
        const input = { count: 42, ok: true, nothing: null };
        expect(redactDeep(input)).toEqual(input);
    });
});
