import { createPublicKey, verify } from "node:crypto";
import type { CreateResourcePolicyInput } from "../store/compute-control-store.js";

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
    return value;
}

export function canonicalComputePolicyPayload(organizationId: string, input: CreateResourcePolicyInput): string {
    const { signature: _signature, ...unsigned } = input;
    return JSON.stringify(canonicalize({ organizationId, ...unsigned }));
}

export type ComputePolicySignatureResult = "valid" | "invalid" | "unconfigured";
export type ComputePolicySignatureVerifier = (organizationId: string, input: CreateResourcePolicyInput) => ComputePolicySignatureResult;

export function createComputePolicySignatureVerifier(publicKeyPem: string | undefined): ComputePolicySignatureVerifier {
    if (!publicKeyPem?.trim()) return () => "unconfigured";
    let key: ReturnType<typeof createPublicKey>;
    try { key = createPublicKey(publicKeyPem); }
    catch { return () => "unconfigured"; }
    return (organizationId, input) => {
        try {
            const signature = Buffer.from(input.signature, "base64");
            if (signature.length === 0) return "invalid";
            return verify(null, Buffer.from(canonicalComputePolicyPayload(organizationId, input), "utf8"), key, signature) ? "valid" : "invalid";
        } catch { return "invalid"; }
    };
}
