import { describe, it, expect, beforeEach } from "vitest";
import * as caseEncryption from "./case-encryption";

describe("case-encryption", () => {
    beforeEach(() => {
        // Reset to a clean, disabled/locked state between tests.
        caseEncryption.clearConfig();
    });

    it("is disabled and locked before setup", () => {
        expect(caseEncryption.isEnabled()).toBe(false);
        expect(caseEncryption.isUnlocked()).toBe(false);
    });

    it("setup enables encryption and unlocks the session", () => {
        caseEncryption.setup("correct horse battery staple");
        expect(caseEncryption.isEnabled()).toBe(true);
        expect(caseEncryption.isUnlocked()).toBe(true);
        expect(caseEncryption.getSessionKey()).not.toBeNull();
    });

    it("lock clears the session key without disabling encryption", () => {
        caseEncryption.setup("correct horse battery staple");
        caseEncryption.lock();
        expect(caseEncryption.isEnabled()).toBe(true);
        expect(caseEncryption.isUnlocked()).toBe(false);
        expect(caseEncryption.getSessionKey()).toBeNull();
    });

    it("unlock succeeds with the correct passphrase after a lock", () => {
        caseEncryption.setup("correct horse battery staple");
        caseEncryption.lock();
        expect(caseEncryption.unlock("correct horse battery staple")).toBe(true);
        expect(caseEncryption.isUnlocked()).toBe(true);
    });

    it("unlock fails with an incorrect passphrase and stays locked", () => {
        caseEncryption.setup("correct horse battery staple");
        caseEncryption.lock();
        expect(caseEncryption.unlock("wrong passphrase")).toBe(false);
        expect(caseEncryption.isUnlocked()).toBe(false);
    });

    it("unlock fails when encryption was never set up", () => {
        expect(caseEncryption.unlock("anything")).toBe(false);
    });

    it("rotateKey changes the passphrase — old passphrase no longer unlocks, new one does", () => {
        caseEncryption.setup("old-passphrase");
        caseEncryption.rotateKey("new-passphrase");
        caseEncryption.lock();
        expect(caseEncryption.unlock("old-passphrase")).toBe(false);
        expect(caseEncryption.unlock("new-passphrase")).toBe(true);
    });

    it("clearConfig disables encryption entirely", () => {
        caseEncryption.setup("correct horse battery staple");
        caseEncryption.clearConfig();
        expect(caseEncryption.isEnabled()).toBe(false);
        expect(caseEncryption.isUnlocked()).toBe(false);
        expect(caseEncryption.unlock("correct horse battery staple")).toBe(false);
    });

    it("encrypt/decrypt round-trips arbitrary text", () => {
        caseEncryption.setup("correct horse battery staple");
        const key = caseEncryption.getSessionKey()!;
        const plaintext = JSON.stringify([{ title: "Synthetic case", allergies: ["Penicillin"] }]);
        const payload = caseEncryption.encrypt(plaintext, key);
        expect(payload.ciphertextHex).not.toContain("Penicillin");
        expect(caseEncryption.decrypt(payload, key)).toBe(plaintext);
    });

    it("decrypt fails (does not silently return garbage) with the wrong key", () => {
        caseEncryption.setup("correct horse battery staple");
        const key = caseEncryption.getSessionKey()!;
        const payload = caseEncryption.encrypt("sensitive text", key);
        const wrongKey = Buffer.alloc(32, 1);
        expect(() => caseEncryption.decrypt(payload, wrongKey)).toThrow();
    });

    it("decrypt fails if the ciphertext is tampered with (GCM auth tag catches it)", () => {
        caseEncryption.setup("correct horse battery staple");
        const key = caseEncryption.getSessionKey()!;
        const payload = caseEncryption.encrypt("sensitive text", key);
        const tampered = { ...payload, ciphertextHex: payload.ciphertextHex.replace(/.$/, payload.ciphertextHex.endsWith("0") ? "1" : "0") };
        expect(() => caseEncryption.decrypt(tampered, key)).toThrow();
    });
});
