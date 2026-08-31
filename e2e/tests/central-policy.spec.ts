import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// Exercises app/src/policy-store.ts end to end: renderer (Audit & Privacy's
// "Organization policy" section) -> typed preload API (window.api.policy) ->
// validated IPC (policy:status) -> domain logic (signature verification,
// expiry) -> the settings-store.ts overlay that actually locks a managed
// control. Synthetic keypair/policy fixtures only.

let instance: LaunchedApp | undefined;
let policyDir: string | undefined;
const originalPolicyDirEnv = process.env.MODELFORGE_POLICY_DIR;

test.afterEach(async () => {
    await instance?.close();
    instance = undefined;
    if (policyDir) fs.rmSync(policyDir, { recursive: true, force: true });
    policyDir = undefined;
    if (originalPolicyDirEnv === undefined) delete process.env.MODELFORGE_POLICY_DIR;
    else process.env.MODELFORGE_POLICY_DIR = originalPolicyDirEnv;
});

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
        return sorted;
    }
    return value;
}

function writeSignedPolicy(dir: string, settings: Record<string, unknown>): void {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const now = new Date();
    const payload = {
        version: 1,
        issuer: "Synthetic E2E Health System",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        settings,
    };
    const payloadString = JSON.stringify(canonicalize(payload));
    const signatureHex = crypto.sign(null, Buffer.from(payloadString, "utf-8"), privateKey).toString("hex");
    fs.writeFileSync(path.join(dir, "trusted-public-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
    fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ payload: payloadString, signatureHex, algorithm: "ed25519" }));
}

test("with no policy configured, Audit & Privacy shows the device as locally controlled", async () => {
    policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-policy-"));
    process.env.MODELFORGE_POLICY_DIR = policyDir; // empty dir — no policy.json/trust key

    instance = await launchApp({ userDataDir: makeUserDataDir(), settings: { onboardingComplete: true } });
    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();

    const section = instance.window.locator("div.rounded-xl", { hasText: "Organization policy" });
    await expect(section).toBeVisible();
    await expect(section.getByText("Not configured")).toBeVisible();
    await expect(section.getByText(/isn't governed by a signed organization policy/)).toBeVisible();
});

test("a validly signed policy shows as Active and locks its governed control in the Settings UI", async () => {
    policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-policy-"));
    writeSignedPolicy(policyDir, { auditLogRetentionDays: 2555, networkToolsEnabled: false });
    process.env.MODELFORGE_POLICY_DIR = policyDir;

    instance = await launchApp({ userDataDir: makeUserDataDir(), settings: { onboardingComplete: true } });
    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();

    const policySection = instance.window.locator("div.rounded-xl", { hasText: "Organization policy" });
    await expect(policySection).toBeVisible();
    await expect(policySection.getByText("Active", { exact: true })).toBeVisible();
    await expect(policySection.getByText("Synthetic E2E Health System")).toBeVisible();
    await expect(policySection.getByText("Audit log retention")).toBeVisible();
    await expect(policySection.getByText("Agent network tools")).toBeVisible();

    // The retention select this policy governs is now disabled, with its own
    // "Organization managed" badge — not just the summary card above saying
    // the key is managed in the abstract.
    const auditLogRow = instance.window.locator("label", { hasText: "Retain for" });
    await expect(auditLogRow.getByRole("combobox")).toBeDisabled();
    await expect(auditLogRow.getByText("Organization managed")).toBeVisible();
});

test("a policy signed with an untrusted key is rejected and reported as invalid, not silently ignored", async () => {
    policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-policy-"));
    // Sign with one keypair, but write a *different* keypair's public half as
    // the trusted key — simulates a tampered or mismatched deployment.
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const { publicKey: wrongPublicKey } = crypto.generateKeyPairSync("ed25519");
    const now = new Date();
    const payload = {
        version: 1,
        issuer: "Untrusted Signer",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        settings: { networkToolsEnabled: false },
    };
    const payloadString = JSON.stringify(canonicalize(payload));
    const signatureHex = crypto.sign(null, Buffer.from(payloadString, "utf-8"), privateKey).toString("hex");
    fs.writeFileSync(path.join(policyDir, "trusted-public-key.pem"), wrongPublicKey.export({ type: "spki", format: "pem" }));
    fs.writeFileSync(path.join(policyDir, "policy.json"), JSON.stringify({ payload: payloadString, signatureHex, algorithm: "ed25519" }));
    process.env.MODELFORGE_POLICY_DIR = policyDir;

    instance = await launchApp({ userDataDir: makeUserDataDir(), settings: { onboardingComplete: true } });
    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();

    const policySection = instance.window.locator("div.rounded-xl", { hasText: "Organization policy" });
    await expect(policySection).toBeVisible();
    await expect(policySection.getByText("Invalid", { exact: true })).toBeVisible();
    await expect(policySection.getByText(/could not be verified/)).toBeVisible();
    // Never silently falls through to "Not configured" / unmanaged.
    await expect(policySection.getByText("Not configured")).not.toBeVisible();
});
