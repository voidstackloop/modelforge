import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CreateResourcePolicyInput } from "../store/compute-control-store.js";
import { canonicalComputePolicyPayload, createComputePolicySignatureVerifier } from "./policy-signature.js";

const input: CreateResourcePolicyInput = {
    name: "guardrails", poolId: "00000000-0000-4000-8000-000000000002", hardLimits: { maxCpuThreads: 8 }, workloadClassLimits: {},
    signature: "pending", issuedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-09-30T00:00:00.000Z",
};

describe("compute policy signatures", () => {
    it("verifies the canonical organization-bound payload and rejects tampering", () => {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const organizationId = "00000000-0000-4000-8000-000000000001";
        const signature = sign(null, Buffer.from(canonicalComputePolicyPayload(organizationId, input)), privateKey).toString("base64");
        const verifier = createComputePolicySignatureVerifier(publicKey.export({ type: "spki", format: "pem" }).toString());
        expect(verifier(organizationId, { ...input, signature })).toBe("valid");
        expect(verifier(organizationId, { ...input, signature, hardLimits: { maxCpuThreads: 9 } })).toBe("invalid");
        expect(verifier("00000000-0000-4000-8000-000000000099", { ...input, signature })).toBe("invalid");
    });

    it("fails closed when no trust key is configured", () => {
        expect(createComputePolicySignatureVerifier(undefined)("org", input)).toBe("unconfigured");
    });
});
