#!/usr/bin/env node
// Admin tooling: signs an organization policy document for ModelForge
// Medical's central-policy control (see app/src/policy-store.ts). Produces
// the exact envelope the app verifies — deploy the result as policy.json
// next to trusted-public-key.pem (see generate-policy-keypair.js) at the
// app's policy directory.
//
// Usage:
//   node app/scripts/sign-policy.js <draft.json> <private-key.pem> [output.json]
//
// <draft.json> shape:
//   {
//     "issuer": "Example Health System IT",
//     "expiresInDays": 30,
//     "settings": {
//       "networkToolsEnabled": false,
//       "auditLogRetentionDays": 2555
//     }
//   }
//
// `settings` may only contain keys from MANAGED_SETTING_KEYS in
// policy-store.ts (networkToolsEnabled, verificationEnabled,
// verificationMaxRetries, agentMaxSteps, caseAutoLockMinutes,
// redactBeforeRemoteSend, auditLogRetentionDays, auditLogBackend,
// medicationSafetyProviderId, patientCasesBackendId) — the app's own schema
// (schemas.ts's managedSettingsSchema, .strict()) rejects anything else at
// verification time, so a typo here surfaces as a rejected policy, not a
// silently-ignored field.

const crypto = require("node:crypto");
const fs = require("node:fs");

const [, , draftPath, privateKeyPath, outputPathArg] = process.argv;
if (!draftPath || !privateKeyPath) {
    console.error("Usage: node sign-policy.js <draft.json> <private-key.pem> [output.json]");
    process.exit(1);
}

const draft = JSON.parse(fs.readFileSync(draftPath, "utf-8"));
if (!draft.issuer || typeof draft.issuer !== "string") {
    console.error('draft.json must include a non-empty string "issuer"');
    process.exit(1);
}
if (!Number.isFinite(draft.expiresInDays) || draft.expiresInDays <= 0) {
    console.error('draft.json must include a positive number "expiresInDays"');
    process.exit(1);
}

const now = new Date();
const expiresAt = new Date(now.getTime() + draft.expiresInDays * 24 * 60 * 60 * 1000);

const payload = {
    version: 1,
    issuer: draft.issuer,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    settings: draft.settings ?? {},
};

// Mirrors app/src/policy-store.ts's canonicalize()/canonicalPayloadString()
// exactly — this script is standalone (not part of the TS build) so it
// can't import that function directly. If you change one, change both;
// policy-store.test.ts's round-trip tests are what would catch drift.
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const sorted = {};
        for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
        return sorted;
    }
    return value;
}
function canonicalPayloadString(p) {
    return JSON.stringify(canonicalize(p));
}

const payloadString = canonicalPayloadString(payload);
const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath, "utf-8"));
const signature = crypto.sign(null, Buffer.from(payloadString, "utf-8"), privateKey);

const signed = {
    payload: payloadString,
    signatureHex: signature.toString("hex"),
    algorithm: "ed25519",
};

const outputPath = outputPathArg ?? "policy.json";
fs.writeFileSync(outputPath, JSON.stringify(signed, null, 2));

console.log(`Wrote ${outputPath}`);
console.log(`  issuer:    ${payload.issuer}`);
console.log(`  issuedAt:  ${payload.issuedAt}`);
console.log(`  expiresAt: ${payload.expiresAt}`);
console.log(`  settings:  ${JSON.stringify(payload.settings)}`);
console.log("\nDeploy this file as policy.json next to trusted-public-key.pem at the app's policy directory.");
