export interface IdempotencyRecord {
    requestHash: string;
    statusCode: number;
    responseBody: unknown;
}

/**
 * Backs the Idempotency-Key handling in routes/idempotency.ts (used by
 * routes/cases.ts's POST/PUT) — see that file's doc comment for the full
 * contract. Keyed by (organizationId, key): idempotency keys are only
 * meaningful within the caller's own organization scope, same as every
 * other per-tenant store in this service.
 *
 * `put` is create-or-replace, never merge. The route only ever calls it
 * once per genuinely new key (after `get` has already returned null for
 * that key), so the create-or-replace race this leaves open — two
 * concurrent requests reusing the same brand-new key before either has
 * written — is a client bug (a key is meant to identify one logical
 * attempt, not be reused concurrently for two), not a case this interface
 * needs to detect or serialize against.
 */
export interface IdempotencyStore {
    get(organizationId: string, key: string): Promise<IdempotencyRecord | null>;
    put(organizationId: string, key: string, record: IdempotencyRecord): Promise<void>;
}
