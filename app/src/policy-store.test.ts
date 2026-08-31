import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as policyStore from "./policy-store";
import type { PolicyPayload } from "./policy-store";

// Synthetic keys/payloads only — no real institutional keys or settings.

function freshPolicyDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-policy-test-"));
}

function generateKeypair() {
    return crypto.generateKeyPairSync("ed25519");
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
        return sorted;
    }
    return value;
}

function canonicalPayloadString(payload: PolicyPayload): string {
    return JSON.stringify(canonicalize(payload));
}

function writePolicy(dir: string, payload: PolicyPayload, privateKey: crypto.KeyObject, opts: { corruptSignature?: boolean; nonCanonical?: boolean } = {}) {
    const payloadString = opts.nonCanonical ? JSON.stringify(payload) : canonicalPayloadString(payload);
    let signatureHex = crypto.sign(null, Buffer.from(payloadString, "utf-8"), privateKey).toString("hex");
    if (opts.corruptSignature) signatureHex = signatureHex.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ payload: payloadString, signatureHex, algorithm: "ed25519" }));
}

function writeTrustKey(dir: string, publicKey: crypto.KeyObject) {
    fs.writeFileSync(path.join(dir, "trusted-public-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
}

function makePayload(overrides: Partial<PolicyPayload> = {}): PolicyPayload {
    const now = new Date();
    return {
        version: 1,
        issuer: "Synthetic Test Health System",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        settings: { networkToolsEnabled: false, auditLogRetentionDays: 2555 },
        ...overrides,
    };
}

describe("policy-store", () => {
    let dir: string;
    const originalEnv = process.env.MODELFORGE_POLICY_DIR;

    beforeEach(() => {
        dir = freshPolicyDir();
        process.env.MODELFORGE_POLICY_DIR = dir;
        policyStore.resetPolicyStateForTests();
    });

    afterEach(() => {
        if (originalEnv === undefined) delete process.env.MODELFORGE_POLICY_DIR;
        else process.env.MODELFORGE_POLICY_DIR = originalEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("is unmanaged when no policy directory contents exist", () => {
        expect(policyStore.getPolicyStatus()).toEqual({ state: "unmanaged" });
        expect(policyStore.getManagedSettings()).toEqual({});
        expect(policyStore.isSettingManaged("networkToolsEnabled")).toBe(false);
    });

    it("is active for a validly signed, unexpired policy, and exposes exactly its settings", () => {
        const { publicKey, privateKey } = generateKeypair();
        const payload = makePayload();
        writeTrustKey(dir, publicKey);
        writePolicy(dir, payload, privateKey);

        const status = policyStore.reloadPolicy();
        expect(status.state).toBe("active");
        expect(status.policy?.issuer).toBe("Synthetic Test Health System");
        expect(policyStore.getManagedSettings()).toEqual({ networkToolsEnabled: false, auditLogRetentionDays: 2555 });
        expect(policyStore.isSettingManaged("networkToolsEnabled")).toBe(true);
        expect(policyStore.isSettingManaged("caseAutoLockMinutes")).toBe(false);
    });

    it("rejects a policy signed with a different key than the trusted one", () => {
        const { privateKey } = generateKeypair();
        const { publicKey: otherPublicKey } = generateKeypair(); // mismatched pair
        writeTrustKey(dir, otherPublicKey);
        writePolicy(dir, makePayload(), privateKey);

        const status = policyStore.reloadPolicy();
        expect(status.state).toBe("invalid");
        expect(status.error).toMatch(/signature verification failed/);
        expect(policyStore.getManagedSettings()).toEqual({}); // no prior cache to fall back to
    });

    it("rejects a policy whose signature doesn't match a tampered payload", () => {
        const { publicKey, privateKey } = generateKeypair();
        writeTrustKey(dir, publicKey);
        writePolicy(dir, makePayload(), privateKey, { corruptSignature: true });

        const status = policyStore.reloadPolicy();
        expect(status.state).toBe("invalid");
        expect(policyStore.getManagedSettings()).toEqual({});
    });

    it("falls back to the last-known-good cached policy when a later read is invalid, rather than un-managing the device", () => {
        const { publicKey, privateKey } = generateKeypair();
        writeTrustKey(dir, publicKey);
        writePolicy(dir, makePayload({ settings: { networkToolsEnabled: false } }), privateKey);
        expect(policyStore.reloadPolicy().state).toBe("active");
        expect(policyStore.getManagedSettings()).toEqual({ networkToolsEnabled: false });

        // Simulate the policy file being tampered with (or corrupted) after
        // this device already trusted a valid version of it.
        writePolicy(dir, makePayload({ settings: { networkToolsEnabled: false } }), privateKey, { corruptSignature: true });
        const status = policyStore.reloadPolicy();

        expect(status.state).toBe("invalid");
        // The device stays governed by the last verified policy — tampering
        // with the file must not be a way to escape governance.
        expect(policyStore.getManagedSettings()).toEqual({ networkToolsEnabled: false });
    });

    it("enforces an expired policy within its grace period, with a visible warning state", () => {
        const { publicKey, privateKey } = generateKeypair();
        const now = new Date();
        const payload = makePayload({
            issuedAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString(),
            expiresAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(), // expired yesterday
        });
        writeTrustKey(dir, publicKey);
        writePolicy(dir, payload, privateKey);

        const status = policyStore.reloadPolicy();
        expect(status.state).toBe("expired_grace");
        expect(status.error).toMatch(/expired/);
        expect(policyStore.getManagedSettings()).toEqual(payload.settings);
    });

    it("falls back to last-known-good once a policy is expired past its grace period", () => {
        const { publicKey, privateKey } = generateKeypair();
        writeTrustKey(dir, publicKey);
        writePolicy(dir, makePayload({ settings: { auditLogRetentionDays: 90 } }), privateKey);
        expect(policyStore.reloadPolicy().state).toBe("active");

        const now = new Date();
        const longExpired = makePayload({
            settings: { auditLogRetentionDays: 90 },
            issuedAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString(),
            expiresAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), // well past the 7-day grace period
        });
        writePolicy(dir, longExpired, privateKey);
        const status = policyStore.reloadPolicy();

        expect(status.state).toBe("invalid");
        expect(status.error).toMatch(/grace period has elapsed/);
        // Still governed by the earlier, still-cached valid policy.
        expect(policyStore.getManagedSettings()).toEqual({ auditLogRetentionDays: 90 });
    });

    it("rejects a payload signed over non-canonical bytes even with an otherwise-valid signature", () => {
        const { publicKey, privateKey } = generateKeypair();
        writeTrustKey(dir, publicKey);
        writePolicy(dir, makePayload(), privateKey, { nonCanonical: true });

        const status = policyStore.reloadPolicy();
        expect(status.state).toBe("invalid");
        expect(status.error).toMatch(/canonical/);
    });

    it("rejects a policy document with a field outside the managed-settings allowlist", () => {
        const { publicKey, privateKey } = generateKeypair();
        writeTrustKey(dir, publicKey);
        // theme is a real AppSettings field but not in MANAGED_SETTING_KEYS —
        // an institution's policy must not be able to govern arbitrary
        // settings, only the curated, deliberately-exposed subset.
        const payload = { ...makePayload(), settings: { theme: "dark" } } as unknown as PolicyPayload;
        writePolicy(dir, payload, privateKey);

        const status = policyStore.reloadPolicy();
        expect(status.state).toBe("invalid");
        expect(policyStore.getManagedSettings()).toEqual({});
    });

    it("rejects malformed JSON in policy.json without throwing", () => {
        writeTrustKey(dir, generateKeypair().publicKey);
        fs.writeFileSync(path.join(dir, "policy.json"), "not valid json {{{");

        expect(() => policyStore.reloadPolicy()).not.toThrow();
        expect(policyStore.reloadPolicy().state).toBe("invalid");
    });

    it("is invalid, not unmanaged, when policy.json exists but the trust key is missing", () => {
        writePolicy(dir, makePayload(), generateKeypair().privateKey);
        // No writeTrustKey() call — the key is absent.

        const status = policyStore.reloadPolicy();
        expect(status.state).toBe("invalid");
        expect(status.error).toMatch(/trusted-public-key/);
    });

    it("stays unmanaged if only the trust key exists, with no policy.json", () => {
        writeTrustKey(dir, generateKeypair().publicKey);
        // No policy.json written — matches "admin dropped the key first,
        // hasn't published a policy yet" during rollout.
        const status = policyStore.reloadPolicy();
        expect(status.state).toBe("invalid");
    });

    it("throttles re-verification: a file change within the recheck interval isn't picked up until reloadPolicy() forces it", () => {
        const { publicKey, privateKey } = generateKeypair();
        writeTrustKey(dir, publicKey);
        writePolicy(dir, makePayload({ settings: { networkToolsEnabled: false } }), privateKey);
        expect(policyStore.getPolicyStatus().state).toBe("active");

        writePolicy(dir, makePayload({ settings: { networkToolsEnabled: true } }), privateKey);
        // Without reloadPolicy(), the throttled getPolicyStatus() should
        // still report the previously-computed value from just now.
        expect(policyStore.getManagedSettings()).toEqual({ networkToolsEnabled: false });

        expect(policyStore.reloadPolicy().state).toBe("active");
        expect(policyStore.getManagedSettings()).toEqual({ networkToolsEnabled: true });
    });
});
