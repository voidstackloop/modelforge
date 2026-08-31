import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";
import { policyPayloadSchema, signedPolicySchema } from "./schemas";
import { logger } from "./logger";
import type { AppSettings } from "./settings-store";
import type { z } from "zod";

// Central, institution-managed policy. This is deliberately NOT a network
// client talking to a policy service this project doesn't operate — it's a
// signed, versioned JSON document an institution's admin tooling drops at a
// fixed, OS-conventional, machine-wide location (not Electron's per-user
// `userData` — a device's own user must not be able to edit or delete their
// own governance policy). The app's job is exactly three things: verify the
// signature against a trusted public key provisioned at that same location,
// enforce expiry/grace-period fail-closed semantics, and overlay the
// verified settings onto every read of AppSettings (see settings-store.ts's
// getSettings()/saveSettings()) so a managed field can't be changed locally
// regardless of which code path attempts it.
//
// Trust model, stated honestly: the public key lives next to the policy
// document in the same admin-controlled directory (see policyDir() below) —
// this is a "trust the directory's OS permissions" model (TOFU against
// whatever wrote that directory), not a hardware root of trust or a real PKI
// chain. Securing that directory to admin-only write access is the
// deploying institution's OS/MDM responsibility — the exact same boundary
// this codebase already draws for OS-level disk encryption and code-signing
// certificates (see docs/ENTERPRISE_READINESS_ASSESSMENT.md's threat model).
// A stronger trust anchor (a key baked into a per-institution build, or a
// real PKI/HSM-backed signer) is real future work, not something this
// module pretends to already have.

export type ManagedSettings = z.infer<typeof policyPayloadSchema>["settings"];

// Keep this list exactly in sync with schemas.ts's managedSettingsSchema —
// it's the runtime source of truth for "which AppSettings keys can a signed
// policy govern"; the schema is what actually rejects anything outside it.
export const MANAGED_SETTING_KEYS = [
    "networkToolsEnabled",
    "verificationEnabled",
    "verificationMaxRetries",
    "agentMaxSteps",
    "caseAutoLockMinutes",
    "redactBeforeRemoteSend",
    "auditLogRetentionDays",
    "auditLogBackend",
    "medicationSafetyProviderId",
    "patientCasesBackendId",
    "sessionsBackendId",
    "llamaCppGpuBackend",
    "llamaCppMaxCachedModels",
    "llamaCppMaxThreads",
    "llamaCppVramReserveGB",
    "llamaCppRamReserveGB",
    "llamaCppBatchSize",
    "llamaCppFlashAttention",
    "resourceBudgetMode",
    "resourceMaxRamMB",
    "resourceMaxVramMB",
    "resourceCpuThreadCeiling",
    "resourceRuntimeProfile",
] as const satisfies readonly (keyof AppSettings)[];

export type ManagedSettingKey = (typeof MANAGED_SETTING_KEYS)[number];

// A policy past its expiresAt keeps being enforced for this long before
// falling back to fail-closed (last-known-good, see below) — long enough
// that a clinician's device missing one refresh cycle (a laptop left off
// over a long weekend, a disconnected clinic) doesn't immediately lose
// governance, short enough that a genuinely stale/abandoned policy doesn't
// stay silently enforced indefinitely.
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

// Re-verifying (file reads + Ed25519 verify) on every single call would add
// real overhead to a hot path — settings-store.ts's getSettings() runs on
// every agent-mode network-tool-call gate (agent-tools.ts), among many other
// call sites. A local policy file changes rarely; re-checking every few
// seconds is "live enough" without paying verification cost per call.
const RECHECK_INTERVAL_MS = 5_000;

export interface PolicyPayload {
    version: 1;
    issuer: string;
    issuedAt: string;
    expiresAt: string;
    settings: ManagedSettings;
}

export type PolicyState = "unmanaged" | "active" | "expired_grace" | "invalid";

export interface PolicyStatus {
    state: PolicyState;
    /** The payload currently being enforced — the freshly verified one for
     * "active"/"expired_grace", the last-known-good cached one for
     * "invalid" if one exists, undefined for "unmanaged" or a first-ever
     * verification failure with no prior cache. */
    policy?: PolicyPayload;
    /** Human-readable reason, set for "invalid" and "expired_grace". Never
     * includes file contents or key material — just what went wrong. */
    error?: string;
    /** When the currently-enforced policy (fresh or cached) was last
     * successfully verified. Undefined for "unmanaged". */
    lastVerifiedAt?: string;
}

interface PolicyCache {
    policy: PolicyPayload;
    verifiedAt: string;
}

function policyDir(): string {
    // Override for tests and for institutions whose deployment tooling
    // prefers a different convention than the OS defaults below.
    const override = process.env.MODELFORGE_POLICY_DIR;
    if (override && override.trim().length > 0) return override;

    if (process.platform === "win32") return "C:\\ProgramData\\ModelForge Medical\\policy";
    if (process.platform === "darwin") return "/Library/Application Support/ModelForge Medical/policy";
    return "/etc/modelforge-medical/policy";
}

function policyFilePath(): string {
    return path.join(policyDir(), "policy.json");
}

function trustKeyPath(): string {
    return path.join(policyDir(), "trusted-public-key.pem");
}

// Local, per-device record of the last successfully verified policy — lives
// in userData (unlike the policy/trust-key files themselves) because it's
// not a trust anchor, just a fail-closed memory: if a later read of the
// admin-controlled policy file is tampered with, corrupted, or expired past
// its grace period, this is what keeps the device governed by its last
// known-good state instead of silently reverting to fully local control
// (which would make "corrupt the policy file" an effective way to escape
// governance).
function cacheFilePath(): string {
    return path.join(app.getPath("userData"), "policy-cache.json");
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

// Deterministic serialization so a signer and this verifier always compute
// over identical bytes regardless of key insertion order — mirrored exactly
// in app/scripts/sign-policy.js (a standalone Node script, not part of this
// TS build, so it can't import this function directly). Keep the two in
// sync; policy-store.test.ts's round-trip tests catch drift between them.
export function canonicalPayloadString(payload: PolicyPayload): string {
    return JSON.stringify(canonicalize(payload));
}

function verifySignature(payloadString: string, signatureHex: string, publicKeyPem: string): boolean {
    try {
        const publicKey = crypto.createPublicKey(publicKeyPem);
        return crypto.verify(null, Buffer.from(payloadString, "utf-8"), publicKey, Buffer.from(signatureHex, "hex"));
    } catch {
        // Malformed key/signature hex — not a verified signature either way.
        return false;
    }
}

// Plain text, not readJson: the trust key is a PEM file
// ("-----BEGIN PUBLIC KEY-----\n...") — not JSON — so JSON.parse-based
// reading would misfire on every valid key file (readJson exists for
// settings/data files that actually are JSON).
function readTrustKeyPem(): string | null {
    try {
        return fs.readFileSync(trustKeyPath(), "utf-8");
    } catch {
        return null;
    }
}

function readCache(): PolicyCache | null {
    return readJson<PolicyCache | null>(cacheFilePath(), null);
}

function writeCache(cache: PolicyCache): void {
    writeJson(cacheFilePath(), cache);
}

function isWithinGrace(expiresAt: string, now: Date): boolean {
    const expiry = new Date(expiresAt).getTime();
    if (Number.isNaN(expiry)) return false;
    return now.getTime() <= expiry + GRACE_PERIOD_MS;
}

function isExpired(expiresAt: string, now: Date): boolean {
    const expiry = new Date(expiresAt).getTime();
    if (Number.isNaN(expiry)) return true;
    return now.getTime() > expiry;
}

/**
 * Reads policy.json + trusted-public-key.pem from the fixed institutional
 * directory, verifies the signature, and applies expiry/grace-period logic.
 * Never throws — every failure mode (missing files, malformed JSON, schema
 * mismatch, bad signature, expired past grace) resolves to a PolicyStatus,
 * since a policy file being unreadable must never crash the app that
 * depends on it for settings.
 */
function verifyFromDisk(): PolicyStatus {
    const now = new Date();
    const signed = readJson<unknown>(policyFilePath(), null);
    const publicKeyPem = readTrustKeyPem();

    if (signed === null && publicKeyPem === null) {
        return { state: "unmanaged" };
    }

    const cache = readCache();
    const fallbackToCache = (error: string): PolicyStatus => {
        logger.error(`policy-store: ${error}`);
        if (cache) return { state: "invalid", policy: cache.policy, error, lastVerifiedAt: cache.verifiedAt };
        return { state: "invalid", error };
    };

    if (signed === null) return fallbackToCache("policy.json is missing or unreadable while a trusted public key is present");
    if (publicKeyPem === null) return fallbackToCache("trusted-public-key.pem is missing or unreadable while policy.json is present");

    const signedResult = signedPolicySchema.safeParse(signed);
    if (!signedResult.success) return fallbackToCache(`policy.json does not match the expected signed-envelope shape`);

    const { payload: payloadString, signatureHex, algorithm } = signedResult.data;
    if (algorithm !== "ed25519") return fallbackToCache(`unsupported signature algorithm "${algorithm}"`);

    if (!verifySignature(payloadString, signatureHex, publicKeyPem)) {
        return fallbackToCache("signature verification failed — policy.json does not match its claimed signature under the trusted public key");
    }

    let parsedPayload: unknown;
    try {
        parsedPayload = JSON.parse(payloadString);
    } catch {
        return fallbackToCache("signed payload is not valid JSON");
    }
    const payloadResult = policyPayloadSchema.safeParse(parsedPayload);
    if (!payloadResult.success) return fallbackToCache(`signed payload does not match the expected policy shape: ${payloadResult.error.issues.map((i) => i.path.join(".")).join(", ")}`);

    const payload = payloadResult.data;

    // Re-derive the canonical string from the parsed payload and require it
    // to match what was actually signed — otherwise a payload string with
    // extra whitespace/reordering that still parses to the "same" object
    // could be swapped in without invalidating the signature check above
    // (the signature covers the exact bytes signed, not the parsed value).
    if (canonicalPayloadString(payload) !== payloadString) {
        return fallbackToCache("signed payload is not in canonical form — treating as unverifiable rather than re-deriving trust from a non-canonical encoding");
    }

    if (isExpired(payload.expiresAt, now)) {
        if (isWithinGrace(payload.expiresAt, now)) {
            writeCache({ policy: payload, verifiedAt: now.toISOString() });
            return { state: "expired_grace", policy: payload, error: `policy expired at ${payload.expiresAt}; operating within the grace period`, lastVerifiedAt: now.toISOString() };
        }
        return fallbackToCache(`policy expired at ${payload.expiresAt} and the grace period has elapsed`);
    }

    writeCache({ policy: payload, verifiedAt: now.toISOString() });
    return { state: "active", policy: payload, lastVerifiedAt: now.toISOString() };
}

let throttled: { status: PolicyStatus; checkedAt: number } | null = null;

/** Current policy status, throttled to at most one disk read+verification
 * per RECHECK_INTERVAL_MS — see that constant's comment. Call reloadPolicy()
 * to force an immediate re-check (e.g. an explicit "Check for policy
 * update" action). */
export function getPolicyStatus(): PolicyStatus {
    const now = Date.now();
    if (throttled && now - throttled.checkedAt < RECHECK_INTERVAL_MS) return throttled.status;
    const status = verifyFromDisk();
    throttled = { status, checkedAt: now };
    return status;
}

/** Forces an immediate re-verification, bypassing the throttle. */
export function reloadPolicy(): PolicyStatus {
    throttled = null;
    return getPolicyStatus();
}

/** The settings currently enforced by policy — empty for "unmanaged", the
 * verified (or last-known-good cached) settings otherwise. Never throws. */
export function getManagedSettings(): Partial<AppSettings> {
    const status = getPolicyStatus();
    return status.policy?.settings ?? {};
}

export function isSettingManaged(key: ManagedSettingKey): boolean {
    return key in getManagedSettings();
}

/** Test-only: drops the throttle cache and local last-known-good cache file
 * so the next call re-reads from disk with no memory of prior state. */
export function resetPolicyStateForTests(): void {
    throttled = null;
    writeJson(cacheFilePath(), null);
}
