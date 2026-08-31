import type { IdempotencyRecord, IdempotencyStore } from "./idempotency-store.js";

/** How long a recorded response stays eligible for replay — long enough to
 * cover any realistic client retry/backoff window, short enough that a
 * long-lived process doesn't hold every idempotency key it has ever seen
 * forever. Same 24h horizon a fresh key can't outlive in either store
 * implementation. */
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredRecord extends IdempotencyRecord {
    storedAt: number;
}

/**
 * In-memory only — same disclosed scope boundary as InMemoryIamStore and
 * InMemoryCaseStore (see server/README.md): everything is lost on restart.
 *
 * Expired entries are swept lazily rather than on a timer: every `put`
 * first drops any of that organization's own records older than
 * RECORD_TTL_MS. This bounds growth for any organization that's actually
 * being written to (the realistic dev/test usage this store is meant for)
 * without needing a process-lifetime interval and its own dispose/teardown
 * path. An organization that stops being written to entirely stops
 * sweeping too, but its (now-idle) map also stops growing — the residual
 * memory is bounded by that organization's key count at the moment it went
 * idle, not unbounded.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
    private recordsByOrg = new Map<string, Map<string, StoredRecord>>();

    async get(organizationId: string, key: string): Promise<IdempotencyRecord | null> {
        const record = this.recordsByOrg.get(organizationId)?.get(key);
        if (!record) return null;
        if (Date.now() - record.storedAt > RECORD_TTL_MS) return null;
        const { requestHash, statusCode, responseBody } = record;
        return { requestHash, statusCode, responseBody };
    }

    async put(organizationId: string, key: string, record: IdempotencyRecord): Promise<void> {
        let records = this.recordsByOrg.get(organizationId);
        if (!records) {
            records = new Map();
            this.recordsByOrg.set(organizationId, records);
        }
        const now = Date.now();
        for (const [existingKey, existingRecord] of records) {
            if (now - existingRecord.storedAt > RECORD_TTL_MS) records.delete(existingKey);
        }
        records.set(key, { ...record, storedAt: now });
    }
}
