import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as secretsStore from "./secrets-store";
import { app, safeStorage } from "electron";

function secretsFilePath(): string {
    return path.join(app.getPath("userData"), "secrets.json");
}

function writeRawSecretsFile(data: Record<string, string>): void {
    fs.mkdirSync(path.dirname(secretsFilePath()), { recursive: true });
    fs.writeFileSync(secretsFilePath(), JSON.stringify(data));
}

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(secretsFilePath(), { force: true });
});

describe("secrets-store", () => {
    it("reports a key as absent before it's set", () => {
        expect(secretsStore.hasSecret("does_not_exist")).toBe(false);
        expect(secretsStore.getSecret("does_not_exist")).toBeNull();
    });

    it("round-trips a secret through set/get", () => {
        secretsStore.setSecret("openai_api_key", "sk-test-123");
        expect(secretsStore.hasSecret("openai_api_key")).toBe(true);
        expect(secretsStore.getSecret("openai_api_key")).toBe("sk-test-123");
    });

    it("deletes a secret when set to an empty value", () => {
        secretsStore.setSecret("anthropic_api_key", "sk-ant-test");
        secretsStore.setSecret("anthropic_api_key", "");
        expect(secretsStore.hasSecret("anthropic_api_key")).toBe(false);
    });

    it("keeps unrelated keys untouched when one is deleted", () => {
        secretsStore.setSecret("openai_api_key", "sk-1");
        secretsStore.setSecret("anthropic_api_key", "sk-ant-1");

        secretsStore.setSecret("openai_api_key", "");

        expect(secretsStore.getSecret("openai_api_key")).toBeNull();
        expect(secretsStore.getSecret("anthropic_api_key")).toBe("sk-ant-1");
    });

    it("never stores the raw value in plaintext on disk", () => {
        const plaintext = "sk-should-be-encrypted";
        secretsStore.setSecret("openai_api_key", plaintext);

        const onDisk = fs.readFileSync(secretsFilePath(), "utf-8");
        expect(onDisk).not.toContain(plaintext);
        expect(secretsStore.getSecret("openai_api_key")).toBe(plaintext);
    });

    describe("with encryption unavailable (no OS credential store)", () => {
        function withEncryptionUnavailable(): void {
            vi.spyOn(safeStorage, "isEncryptionAvailable").mockReturnValue(false);
        }

        it("still stores and returns the value — never silently drops it", () => {
            withEncryptionUnavailable();
            secretsStore.setSecret("openai_api_key", "sk-plain");
            expect(secretsStore.getSecret("openai_api_key")).toBe("sk-plain");
        });

        it("logs a warning rather than failing silently", () => {
            withEncryptionUnavailable();
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            secretsStore.setSecret("openai_api_key", "sk-plain");
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/unencrypted/i));
        });

        it("persists the fallback value in plain text on disk — a disclosed, visible fallback rather than a hidden one", () => {
            withEncryptionUnavailable();
            secretsStore.setSecret("openai_api_key", "sk-plain-on-disk");
            const raw = fs.readFileSync(secretsFilePath(), "utf-8");
            expect(raw).toContain("sk-plain-on-disk");
        });

        it("exposes isEncryptionAvailable() so the Settings UI can show the plaintext-storage warning", () => {
            withEncryptionUnavailable();
            expect(secretsStore.isEncryptionAvailable()).toBe(false);
        });

        it("still deletes correctly", () => {
            withEncryptionUnavailable();
            secretsStore.setSecret("figma_token", "tok");
            secretsStore.setSecret("figma_token", "");
            expect(secretsStore.hasSecret("figma_token")).toBe(false);
        });
    });

    describe("legacy plaintext values (written before encryption was available or before it existed)", () => {
        it("reads a pre-existing plaintext value even though encryption is available now", () => {
            writeRawSecretsFile({ openai_api_key: "legacy-plain-value" });
            expect(secretsStore.getSecret("openai_api_key")).toBe("legacy-plain-value");
        });

        it("does not crash or throw when the legacy value isn't valid base64/ciphertext", () => {
            writeRawSecretsFile({ openai_api_key: "not-base64-ciphertext-at-all!" });
            expect(() => secretsStore.getSecret("openai_api_key")).not.toThrow();
            expect(secretsStore.getSecret("openai_api_key")).toBe("not-base64-ciphertext-at-all!");
        });
    });

    describe("migration (a legacy plaintext value gets encrypted the next time it's saved)", () => {
        it("re-saving a legacy plaintext key under now-available encryption stores it encrypted", () => {
            writeRawSecretsFile({ openai_api_key: "legacy-plain-value" });
            expect(secretsStore.getSecret("openai_api_key")).toBe("legacy-plain-value");

            // The normal save path (e.g. the user re-entering/confirming the
            // key in Settings) always uses the *current* isEncryptionAvailable()
            // state, so a value written while encryption was unavailable
            // naturally migrates forward the next time it's set — no separate
            // migration step needed, and nothing is overwritten without the
            // caller's own action.
            secretsStore.setSecret("openai_api_key", "legacy-plain-value");

            const raw = fs.readFileSync(secretsFilePath(), "utf-8");
            expect(raw).not.toContain("legacy-plain-value");
            expect(secretsStore.getSecret("openai_api_key")).toBe("legacy-plain-value");
        });

        it("does NOT rewrite a legacy plaintext value on read alone — only an explicit save migrates it", () => {
            // Deliberately conservative: a decrypt failure is ambiguous (it
            // could be a genuine legacy plaintext value, or ciphertext that
            // no longer decrypts because the OS credential store identity
            // changed, e.g. a profile copied to a new machine). Silently
            // rewriting on every read would risk permanently discarding
            // otherwise-recoverable ciphertext under a wrong guess; only ever
            // touching disk on an explicit setSecret() keeps that risk with
            // the caller's own action instead of a background guess.
            writeRawSecretsFile({ openai_api_key: "legacy-plain-value" });
            secretsStore.getSecret("openai_api_key");
            secretsStore.getSecret("openai_api_key");

            const raw = fs.readFileSync(secretsFilePath(), "utf-8");
            expect(raw).toContain("legacy-plain-value");
        });
    });
});
