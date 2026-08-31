import { randomBytes } from "node:crypto";
import * as secretsStore from "./secrets-store";

// The encryption key for case-offline-cache.ts's local cache/outbox of
// SHARED-backend patient cases — a different trust model from
// case-encryption.ts's passphrase-derived key. The shared/institutional
// mode already has an OIDC-authenticated session; gating its offline cache
// behind a second passphrase the clinician must remember and unlock every
// session would be the wrong UX layer here. Instead this reuses
// secrets-store.ts's OS-keychain-backed safeStorage (already used for OAuth
// tokens) — matching the roadmap's own "per-account keys... sealed to the
// OS secure store" language (docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md §13
// Phase 4) — no passphrase, no prompt, transparent whenever the OS session
// itself is unlocked.
//
// Namespaced per organization (not one global key) so a consultant
// connected to two institutions, or a device that's switched from one
// institution to another, can never have one org's cache key decrypt
// another's cached data. That guarantee depends on organizationId actually
// identifying one real organization — reject anything that isn't a
// well-formed UUID rather than trusting it, the same defense-in-depth
// posture case-offline-cache.ts's filePath() takes for the same value used
// as a path component.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretKeyFor(organizationId: string): string {
    if (!UUID_PATTERN.test(organizationId)) {
        throw new Error(`shared-cache-key: refusing a non-UUID organizationId: ${organizationId}`);
    }
    return `shared-cache-key:${organizationId}`;
}

/** Returns this organization's cache key, generating and persisting a new
 * random 256-bit one on first use. Idempotent — a second call for the same
 * organizationId returns the same key. */
export function getOrCreateCacheKey(organizationId: string): Buffer {
    const existing = secretsStore.getSecret(secretKeyFor(organizationId));
    if (existing) return Buffer.from(existing, "base64");

    const key = randomBytes(32);
    secretsStore.setSecret(secretKeyFor(organizationId), key.toString("base64"));
    return key;
}

/** Deletes this organization's cache key — the cached/queued data itself
 * becomes permanently unrecoverable ciphertext without it, which is exactly
 * the point when paired with case-offline-cache.ts's own file deletion on
 * sign-out (deleting both is belt-and-suspenders: either alone already
 * makes the data unrecoverable). */
export function clearCacheKey(organizationId: string): void {
    secretsStore.setSecret(secretKeyFor(organizationId), "");
}
