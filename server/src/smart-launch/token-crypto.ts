import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * At-rest encryption for an EHR access/refresh token this server holds on
 * a user's behalf (server/src/store/smart-launch-store.ts) — same AES-256-
 * GCM envelope shape as imaging/object-store.ts's own
 * LocalFilesystemImagingObjectStore (`iv || authTag || ciphertext`, same
 * byte lengths), applied to a short string instead of pixel data. A real
 * OAuth access/refresh token is exactly as sensitive as a password — this
 * server must never store one in plaintext, and must never log it (no
 * caller in this codebase passes a decrypted token to a logger; grep for
 * any future violation of that before trusting this comment alone).
 *
 * Public-client only (PKCE, no client_secret) is a deliberate scope
 * boundary, not an oversight: a confidential client's client_secret would
 * need this exact same at-rest protection PLUS a decision about how an
 * operator provisions/rotates it per trusted issuer — a real, separate
 * secrets-management problem this pass doesn't attempt to solve.
 */
const GCM_AUTH_TAG_LENGTH_BYTES = 16;
const GCM_IV_LENGTH_BYTES = 12;

export class SmartLaunchEncryptionKeyError extends Error {}

/** Validates and returns the 32-byte key from a base64 env value — throws
 * a clear, specific error rather than a cryptic node:crypto failure deep
 * inside encrypt/decrypt when misconfigured. */
export function loadTokenEncryptionKey(base64Key: string | undefined): Buffer {
    if (!base64Key) throw new SmartLaunchEncryptionKeyError("SMART_LAUNCH_ENCRYPTION_KEY is not configured.");
    const decoded = Buffer.from(base64Key, "base64");
    if (decoded.length !== 32) throw new SmartLaunchEncryptionKeyError("SMART_LAUNCH_ENCRYPTION_KEY must be base64 for exactly 32 bytes.");
    return decoded;
}

export function encryptToken(plaintext: string, key: Buffer): string {
    const iv = randomBytes(GCM_IV_LENGTH_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_AUTH_TAG_LENGTH_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptToken(envelopeBase64: string, key: Buffer): string {
    const envelope = Buffer.from(envelopeBase64, "base64");
    const iv = envelope.subarray(0, GCM_IV_LENGTH_BYTES);
    const authTag = envelope.subarray(GCM_IV_LENGTH_BYTES, GCM_IV_LENGTH_BYTES + GCM_AUTH_TAG_LENGTH_BYTES);
    const ciphertext = envelope.subarray(GCM_IV_LENGTH_BYTES + GCM_AUTH_TAG_LENGTH_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_AUTH_TAG_LENGTH_BYTES });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
