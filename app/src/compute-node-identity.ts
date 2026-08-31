import * as path from "node:path";
import * as fs from "node:fs";
import { X509Certificate } from "node:crypto";
import { app } from "electron";
import { generate as generateSelfSignedCert } from "selfsigned";
import * as secretsStore from "./secrets-store";
import { readJson, writeJson } from "./json-store";
import { logger } from "./logger";

/**
 * This node's mTLS client identity for the enterprise compute control plane
 * (server/src/routes/compute-control.ts's requireAgentNode() — see
 * docs/COMPUTE_CONTROL_PLANE.md). Every agent-scoped call (heartbeat,
 * assignments, lease acknowledge/renew/release) must present a TLS client
 * certificate. The SHA-256 fingerprint the server computes from the live
 * peer certificate (`socket.getPeerCertificate().fingerprint256` — a
 * colon-separated uppercase hex string) must match the fingerprint an
 * organization compute admin registered for this node via POST
 * /organizations/:organizationId/compute/nodes.
 *
 * Deliberately self-signed rather than issued by an institutional CA: this
 * repo has no CA infrastructure of its own, and the server only ever
 * compares the certificate's *fingerprint* against an admin-registered
 * value — it never validates a certificate chain — so a self-signed
 * certificate identifies this node exactly as well as a CA-issued one
 * would, at none of the CA-provisioning cost. Rotation is not implemented
 * yet: this generates one long-lived (10 year) identity per install and
 * keeps it forever, matching this MVP's disclosed scope (see
 * docs/COMPUTE_CONTROL_PLANE.md's agent section) — a real rotation flow
 * would need a way to tell the server "trust this new fingerprint for the
 * same node," which does not exist on the server side today either.
 */

interface StoredIdentity {
    certificatePem: string;
    fingerprint256: string;
    createdAt: string;
}

const PRIVATE_KEY_SECRET_KEY = "compute_node_private_key_pem";

function identityFilePath(): string {
    return path.join(app.getPath("userData"), "compute-node-identity.json");
}

function readStoredIdentity(): StoredIdentity | null {
    return readJson<StoredIdentity | null>(identityFilePath(), null);
}

async function createIdentity(): Promise<StoredIdentity> {
    const pems = await generateSelfSignedCert(
        [{ name: "commonName", value: "modelforge-compute-node" }],
        {
            keyType: "ec",
            curve: "P-256",
            algorithm: "sha256",
            notAfterDate: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
            extensions: [
                { name: "basicConstraints", cA: false },
                { name: "keyUsage", digitalSignature: true, keyEncipherment: false, critical: true },
                { name: "extKeyUsage", clientAuth: true },
            ],
        }
    );
    const fingerprint256 = new X509Certificate(pems.cert).fingerprint256;
    secretsStore.setSecret(PRIVATE_KEY_SECRET_KEY, pems.private);
    const identity: StoredIdentity = { certificatePem: pems.cert, fingerprint256, createdAt: new Date().toISOString() };
    writeJson(identityFilePath(), identity);
    logger.info(`compute-node-identity: generated a new node identity (fingerprint ${fingerprint256}).`);
    return identity;
}

/** Returns this install's node certificate + fingerprint, generating one on
 * first call. The fingerprint is what a compute admin needs to register
 * this device via POST /compute/nodes — surface it in Settings/Runtime
 * Manager for the user to copy. */
export async function getOrCreateNodeIdentity(): Promise<{ certificatePem: string; fingerprint256: string }> {
    const existing = readStoredIdentity();
    const privateKey = secretsStore.getSecret(PRIVATE_KEY_SECRET_KEY);
    if (existing && privateKey) return existing;
    return createIdentity();
}

/** The PEM private key paired with getOrCreateNodeIdentity()'s certificate —
 * kept out of that function's return value since it's only ever needed by
 * compute-agent-client.ts to configure an outgoing TLS connection, never by
 * a caller that might log or display it. Returns null if no identity has
 * been created yet (call getOrCreateNodeIdentity() first). */
export function getNodePrivateKeyPem(): string | null {
    return secretsStore.getSecret(PRIVATE_KEY_SECRET_KEY);
}

/** Permanently discards this node's identity — the next
 * getOrCreateNodeIdentity() call generates a fresh one with a new
 * fingerprint, which a compute admin would then need to re-register
 * server-side. Exposed for a future "reset device identity" Settings
 * action; not wired to any UI yet. */
export function deleteNodeIdentity(): void {
    try {
        fs.rmSync(identityFilePath(), { force: true });
    } catch {
        // A missing file is already the desired end state.
    }
    secretsStore.setSecret(PRIVATE_KEY_SECRET_KEY, "");
}
