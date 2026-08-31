export interface TtlCacheStats {
    hits: number;
    misses: number;
    size: number;
    evictions: number;
    expirations: number;
}

/** Sweep interval is derived from the cache's own TTL (no point sweeping
 * far more often than entries can actually expire) but clamped so a very
 * short TTL can't turn housekeeping into a hot background loop, and a very
 * long one still gets swept often enough to matter. */
const MIN_SWEEP_INTERVAL_MS = 30_000;
const MAX_SWEEP_INTERVAL_MS = 300_000;

/**
 * A small in-memory cache with both a per-entry TTL and an LRU eviction
 * bound — the two failure modes a bare `Map` cache doesn't guard against:
 * entries that outlive their usefulness (nothing ever expires them) and
 * unbounded growth (nothing ever evicts them). Used by
 * ../store/caching-iam-store.ts to sit in front of IamStore; kept generic
 * and dependency-free so any other hot read path in this service can reuse
 * it the same way.
 *
 * Map iteration order is insertion order, so re-inserting a key on every
 * `get`/`set` (delete-then-set) keeps the least-recently-used entry at the
 * front — that's what makes `evictIfFull`'s `.next().value` the right one
 * to drop.
 *
 * Expired entries are also reclaimed *without* being read: `get()` only
 * notices staleness on access, so a key nobody ever asks for again would
 * otherwise sit in the Map until `maxSize` forces an (unrelated, oldest-
 * insertion-order) eviction — memory stays bounded either way, but a cache
 * full of dead entries evicts genuinely-useful live ones sooner than it
 * should. A periodic sweep (below) removes anything past its TTL on a
 * timer, independent of whether it's ever read again.
 */
export class TtlCache<K, V> {
    private readonly entries = new Map<K, { value: V; expiresAt: number }>();
    private hits = 0;
    private misses = 0;
    private evictions = 0;
    private expirations = 0;
    private readonly sweepTimer: ReturnType<typeof setInterval>;

    constructor(
        private readonly ttlMs: number,
        private readonly maxSize: number = 10_000
    ) {
        const sweepIntervalMs = Math.min(Math.max(ttlMs, MIN_SWEEP_INTERVAL_MS), MAX_SWEEP_INTERVAL_MS);
        this.sweepTimer = setInterval(() => this.sweepExpired(), sweepIntervalMs);
        // Never keeps the process alive by itself — a long-lived server
        // wants this running for as long as the cache exists, but nothing
        // should have to explicitly stop it just to let the process exit
        // (relevant mainly to short-lived scripts/tests that construct
        // many of these).
        this.sweepTimer.unref?.();
    }

    private sweepExpired(): void {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(key);
                this.expirations++;
            }
        }
    }

    get(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            this.misses++;
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            this.expirations++;
            this.misses++;
            return undefined;
        }
        // Re-insert to mark as most-recently-used.
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.hits++;
        return entry.value;
    }

    /** `ttlMsOverride` replaces this cache's configured TTL for this one
     * entry only — see cache.ts's getOrLoad() doc comment for why (a
     * shorter-lived negative-cache entry alongside normal, longer-lived
     * ones in the same cache). */
    set(key: K, value: V, ttlMsOverride?: number): void {
        this.entries.delete(key);
        this.evictIfFull();
        this.entries.set(key, { value, expiresAt: Date.now() + (ttlMsOverride ?? this.ttlMs) });
    }

    private evictIfFull(): void {
        if (this.entries.size < this.maxSize) return;
        const oldest = this.entries.keys().next();
        if (!oldest.done) {
            this.entries.delete(oldest.value);
            this.evictions++;
        }
    }

    delete(key: K): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }

    /** Stops the periodic sweep — only needed by tests constructing many
     * short-lived instances; production caches live for the process's
     * whole lifetime and never call this. Safe to call more than once. */
    dispose(): void {
        clearInterval(this.sweepTimer);
    }

    get stats(): TtlCacheStats {
        return { hits: this.hits, misses: this.misses, size: this.entries.size, evictions: this.evictions, expirations: this.expirations };
    }
}
