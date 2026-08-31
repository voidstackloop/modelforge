#!/usr/bin/env node
// Admin tooling: generates the Ed25519 keypair a signed organization policy
// (see app/src/policy-store.ts) is verified against. Run once per
// institution, kept outside this repository and outside version control —
// the private key must never be committed or shipped with the app.
//
// Usage: node app/scripts/generate-policy-keypair.js <output-dir>
//
// Writes:
//   <output-dir>/trusted-public-key.pem  — deploy this alongside policy.json
//                                           at the app's policy directory
//                                           (see policy-store.ts's
//                                           policyDir() for the OS-specific
//                                           default path).
//   <output-dir>/policy-signing-key.pem  — KEEP SECRET. Used by
//                                           sign-policy.js to sign policy
//                                           documents. Store it the way you'd
//                                           store any signing key (a
//                                           password manager, an HSM, an
//                                           offline vault) — this script does
//                                           not manage its lifecycle beyond
//                                           writing it to disk once.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const outputDir = process.argv[2];
if (!outputDir) {
    console.error("Usage: node generate-policy-keypair.js <output-dir>");
    process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

const publicPath = path.join(outputDir, "trusted-public-key.pem");
const privatePath = path.join(outputDir, "policy-signing-key.pem");

fs.writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }));
fs.writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

console.log(`Wrote ${publicPath} (deploy this with policy.json)`);
console.log(`Wrote ${privatePath} (KEEP SECRET — do not deploy, do not commit)`);
