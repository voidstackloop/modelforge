import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";

// Optional, passphrase-based encryption at rest for patient-cases.json —
// the one store in this app that holds real clinical detail (allergies,
// medications, conditions, notes). Everything else (chat sessions, evidence
// sources, audit log) stays out of scope for this module; the audit log in
// particular is deliberately designed to carry no clinical content at all
// (see audit-log-store.ts), so encrypting it wouldn't add protection.
//
// Threat model this actually addresses: the case data file being read by
// someone/something with filesystem access but not the passphrase (a stolen
// laptop that's powered off, a backup tool, a synced folder). It does NOT
// protect against an attacker with control of the running, unlocked app —
// that's what session locking (case-encryption "lock" + the renderer's
// inactivity timer) narrows the window on, not eliminates.
//
// The passphrase itself is never stored anywhere, in any form. Only a salt
// (safe to store — it's not secret, its job is making rainbow tables
// useless) and a verifier (an HMAC computed from the derived key, letting a
// wrong passphrase be rejected without ever comparing key material) persist
// to disk. The derived key lives only in this process's memory for as long
// as the app considers itself "unlocked".

interface EncryptionConfig {
    enabled: boolean;
    saltHex: string;
    verifierHex: string;
}

const SCRYPT_KEY_LEN = 32; // AES-256
const VERIFIER_MESSAGE = "modelforge-medical-case-encryption-verifier";

function configPath(): string {
    return path.join(app.getPath("userData"), "case-encryption-config.json");
}

function readConfig(): EncryptionConfig | null {
    return readJson<EncryptionConfig | null>(configPath(), null);
}

function writeConfig(config: EncryptionConfig | null): void {
    if (config === null) {
        try {
            fs.rmSync(configPath(), { force: true });
        } catch {
            // Best effort — a missing file is already the desired end state.
        }
        return;
    }
    writeJson(configPath(), config);
}

// Thrown by any store gated on this module (patient-cases-store.ts,
// sessions-store.ts) instead of silently returning empty data — an empty
// store and "the data exists but you haven't unlocked it" are very
// different situations, and collapsing them would make a locked app look
// like it had lost everything.
export class CaseDataLockedError extends Error {
    constructor() {
        super("This data is encrypted and locked — unlock it with the passphrase first.");
        this.name = "CaseDataLockedError";
    }
}

let sessionKey: Buffer | null = null;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return crypto.scryptSync(passphrase, salt, SCRYPT_KEY_LEN);
}

function computeVerifier(key: Buffer): string {
    return crypto.createHmac("sha256", key).update(VERIFIER_MESSAGE).digest("hex");
}

export function isEnabled(): boolean {
    return readConfig()?.enabled ?? false;
}

export function isUnlocked(): boolean {
    return sessionKey !== null;
}

/** First-time setup: derives a key from `passphrase`, persists salt/verifier,
 * and unlocks the session with the new key. Does not touch case data itself
 * — the caller (encryption IPC handler) is responsible for migrating
 * existing plaintext content, since that requires coordinating with
 * patient-cases-store.ts and this module can't import that without creating
 * a circular dependency. */
export function setup(passphrase: string): void {
    const salt = crypto.randomBytes(16);
    const key = deriveKey(passphrase, salt);
    writeConfig({ enabled: true, saltHex: salt.toString("hex"), verifierHex: computeVerifier(key) });
    sessionKey = key;
}

/** Derives the key from `passphrase` against the stored salt and checks it
 * against the stored verifier — never compares the passphrase itself.
 * Unlocks (sets the in-memory session key) only on a match. */
export function unlock(passphrase: string): boolean {
    const config = readConfig();
    if (!config) return false;
    const key = deriveKey(passphrase, Buffer.from(config.saltHex, "hex"));
    if (!crypto.timingSafeEqual(Buffer.from(computeVerifier(key), "hex"), Buffer.from(config.verifierHex, "hex"))) {
        return false;
    }
    sessionKey = key;
    return true;
}

/** Clears the in-memory key only — case data on disk is untouched and
 * becomes unreadable again until the correct passphrase is entered. This is
 * what an inactivity timeout calls; it is not the same as disabling
 * encryption. */
export function lock(): void {
    sessionKey = null;
}

/** Generates a new salt/key/verifier for a passphrase change and unlocks
 * with it. The caller must re-encrypt existing case data under the new key
 * afterward (read it before calling this, using the old key, then write it
 * back after) — this function only rotates the key material. */
export function rotateKey(newPassphrase: string): void {
    const salt = crypto.randomBytes(16);
    const key = deriveKey(newPassphrase, salt);
    writeConfig({ enabled: true, saltHex: salt.toString("hex"), verifierHex: computeVerifier(key) });
    sessionKey = key;
}

/** Turns encryption off entirely: removes the stored salt/verifier and
 * clears the session key. The caller must re-save case data as plaintext
 * *before* calling this (using getSessionKey() while still enabled) — once
 * this runs, decrypt()/getSessionKey() no longer have anything to work
 * with. */
export function clearConfig(): void {
    writeConfig(null);
    sessionKey = null;
}

export function getSessionKey(): Buffer | null {
    return sessionKey;
}

export interface EncryptedPayload {
    ivHex: string;
    ciphertextHex: string;
    authTagHex: string;
}

export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    return { ivHex: iv.toString("hex"), ciphertextHex: ciphertext.toString("hex"), authTagHex: cipher.getAuthTag().toString("hex") };
}

export function decrypt(payload: EncryptedPayload, key: Buffer): string {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(payload.authTagHex, "hex"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertextHex, "hex")), decipher.final()]);
    return plaintext.toString("utf-8");
}
