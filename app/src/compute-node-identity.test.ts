import { X509Certificate } from "node:crypto";
import { describe, it, expect } from "vitest";
import { getOrCreateNodeIdentity, getNodePrivateKeyPem, deleteNodeIdentity } from "./compute-node-identity";

describe("compute-node-identity", () => {
    it("generates a certificate and private key on first call", async () => {
        deleteNodeIdentity();
        const identity = await getOrCreateNodeIdentity();
        expect(identity.certificatePem).toContain("BEGIN CERTIFICATE");
        expect(identity.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
        expect(getNodePrivateKeyPem()).toContain("BEGIN");
    });

    it("returns the same identity on subsequent calls instead of regenerating", async () => {
        deleteNodeIdentity();
        const first = await getOrCreateNodeIdentity();
        const second = await getOrCreateNodeIdentity();
        expect(second.fingerprint256).toBe(first.fingerprint256);
        expect(second.certificatePem).toBe(first.certificatePem);
    });

    it("the stored fingerprint matches Node's own X509Certificate computation for the same cert", async () => {
        deleteNodeIdentity();
        const identity = await getOrCreateNodeIdentity();
        expect(identity.fingerprint256).toBe(new X509Certificate(identity.certificatePem).fingerprint256);
    });

    it("generates a fresh, different identity after deleteNodeIdentity()", async () => {
        deleteNodeIdentity();
        const first = await getOrCreateNodeIdentity();
        deleteNodeIdentity();
        const second = await getOrCreateNodeIdentity();
        expect(second.fingerprint256).not.toBe(first.fingerprint256);
    });

    it("regenerates if the certificate file exists but the private key was lost", async () => {
        deleteNodeIdentity();
        const first = await getOrCreateNodeIdentity();
        // Simulates secrets.json being wiped/corrupted independently of
        // compute-node-identity.json (they're two separate files) — the
        // module must never hand back a certificate with no usable key.
        const secretsStore = await import("./secrets-store");
        secretsStore.setSecret("compute_node_private_key_pem", "");
        const second = await getOrCreateNodeIdentity();
        expect(getNodePrivateKeyPem()).toContain("BEGIN");
        expect(second.fingerprint256).not.toBe(first.fingerprint256);
    });
});
