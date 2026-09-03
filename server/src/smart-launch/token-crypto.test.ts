import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, loadTokenEncryptionKey, SmartLaunchEncryptionKeyError } from "./token-crypto.js";

const KEY = randomBytes(32);

describe("encryptToken / decryptToken", () => {
    it("round-trips a token exactly", () => {
        const token = "opaque-ehr-access-token-example-value";
        expect(decryptToken(encryptToken(token, KEY), KEY)).toBe(token);
    });

    it("produces a different ciphertext each time (random IV), even for the same plaintext", () => {
        const token = "same-token";
        expect(encryptToken(token, KEY)).not.toBe(encryptToken(token, KEY));
    });

    it("fails to decrypt with the wrong key — authenticated encryption, not just confidentiality", () => {
        const encrypted = encryptToken("secret", KEY);
        const wrongKey = randomBytes(32);
        expect(() => decryptToken(encrypted, wrongKey)).toThrow();
    });

    it("fails to decrypt tampered ciphertext", () => {
        const encrypted = encryptToken("secret-value", KEY);
        const buf = Buffer.from(encrypted, "base64");
        buf[buf.length - 1] ^= 0xff;
        expect(() => decryptToken(buf.toString("base64"), KEY)).toThrow();
    });
});

describe("loadTokenEncryptionKey", () => {
    it("decodes a valid 32-byte base64 key", () => {
        expect(loadTokenEncryptionKey(KEY.toString("base64"))).toEqual(KEY);
    });

    it("throws SmartLaunchEncryptionKeyError when unset", () => {
        expect(() => loadTokenEncryptionKey(undefined)).toThrow(SmartLaunchEncryptionKeyError);
    });

    it("throws SmartLaunchEncryptionKeyError for a key that isn't exactly 32 bytes", () => {
        expect(() => loadTokenEncryptionKey(randomBytes(16).toString("base64"))).toThrow(SmartLaunchEncryptionKeyError);
    });
});
