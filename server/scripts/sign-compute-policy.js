#!/usr/bin/env node
// Admin tooling: signs a compute-control-plane resource policy for
// POST /organizations/:organizationId/compute/policies (see
// server/src/compute/policy-signature.ts and
// server/src/routes/compute-control.ts). This is a *different* signed
// policy from app/scripts/sign-policy.js's desktop central-policy (a local
// AppSettings lockdown) — this one governs the compute fleet's hard CPU/GPU
// guardrails, and its verifier lives server-side, not in the desktop app.
//
// Usage:
//   node server/scripts/sign-compute-policy.js <draft.json> <private-key.pem> <organization-id> [output.json]
//
// <draft.json> shape (matches ResourcePolicyInput minus signature/issuedAt/
// expiresAt, which this script fills in):
//   {
//     "name": "Interactive pool guardrails",
//     "poolId": "3f2a...-uuid (optional — omit for an org-wide policy)",
//     "expiresInDays": 30,
//     "hardLimits": { "maxCpuThreads": 32, "maxAccelerators": 2 },
//     "workloadClassLimits": {
//       "background": { "maxCpuThreads": 8, "allowCpuFallback": true }
//     }
//   }
//
// The private key must be an Ed25519 PEM (see
// app/scripts/generate-policy-keypair.js's --curve ed25519 mode, or any
// `openssl genpkey -algorithm ed25519` key) — the server's
// createComputePolicySignatureVerifier() only ever verifies Ed25519.
//
// Output is the exact JSON body POST /compute/policies expects — pipe it
// straight into that request (e.g. via curl -d @output.json), or paste it
// into the admin console's "paste signed policy" step.

import * as crypto from "node:crypto";
import * as fs from "node:fs";

const [, , draftPath, privateKeyPath, organizationId, outputPathArg] = process.argv;
if (!draftPath || !privateKeyPath || !organizationId) {
    console.error("Usage: node sign-compute-policy.js <draft.json> <private-key.pem> <organization-id> [output.json]");
    process.exit(1);
}

const draft = JSON.parse(fs.readFileSync(draftPath, "utf-8"));
if (!draft.name || typeof draft.name !== "string") {
    console.error('draft.json must include a non-empty string "name"');
    process.exit(1);
}
if (!Number.isFinite(draft.expiresInDays) || draft.expiresInDays <= 0) {
    console.error('draft.json must include a positive number "expiresInDays"');
    process.exit(1);
}
if (!draft.hardLimits || typeof draft.hardLimits !== "object") {
    console.error('draft.json must include a "hardLimits" object (may be empty: {})');
    process.exit(1);
}

const now = new Date();
const expiresAt = new Date(now.getTime() + draft.expiresInDays * 24 * 60 * 60 * 1000);

// The exact unsigned shape createComputePolicySignatureVerifier() re-derives
// server-side and compares the signature against — every field here must
// match resourcePolicyInputSchema (minus signature) or the server's own
// recomputed canonical payload will differ and verification will fail.
const unsigned = {
    ...(draft.poolId ? { poolId: draft.poolId } : {}),
    name: draft.name,
    hardLimits: draft.hardLimits,
    workloadClassLimits: draft.workloadClassLimits ?? {},
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
};

// Mirrors server/src/compute/policy-signature.ts's canonicalize()/
// canonicalComputePolicyPayload() exactly — this script is standalone (not
// part of the server's TS build) so it can't import that function directly.
// If you change one, change both; policy-signature.test.ts's round-trip
// tests are what would catch drift on the server side.
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const sorted = {};
        for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
        return sorted;
    }
    return value;
}
function canonicalComputePolicyPayload(orgId, input) {
    return JSON.stringify(canonicalize({ organizationId: orgId, ...input }));
}

const payloadString = canonicalComputePolicyPayload(organizationId, unsigned);
const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath, "utf-8"));
// Unlike sign-policy.js's desktop central-policy (hex signature), the
// compute-policy verifier expects base64 — see
// createComputePolicySignatureVerifier()'s `Buffer.from(input.signature,
// "base64")`. Getting this encoding wrong is the single easiest way to
// produce a policy that silently fails verification (400
// invalid_compute_policy_signature) despite a technically-correct signature.
const signature = crypto.sign(null, Buffer.from(payloadString, "utf-8"), privateKey);

const signed = { ...unsigned, signature: signature.toString("base64") };

const outputPath = outputPathArg ?? "compute-policy.json";
fs.writeFileSync(outputPath, JSON.stringify(signed, null, 2));

console.log(`Wrote ${outputPath}`);
console.log(`  name:      ${signed.name}`);
console.log(`  poolId:    ${signed.poolId ?? "(org-wide)"}`);
console.log(`  issuedAt:  ${signed.issuedAt}`);
console.log(`  expiresAt: ${signed.expiresAt}`);
console.log(`\nPOST this file's contents to /organizations/${organizationId}/compute/policies to create it.`);
