import type { Cache, CacheStats } from "./cache.js";
import { TtlCache } from "./ttl-cache.js";

/**
 * The zero-dependency Cache<V> backend — this is what create-cache.ts falls
 * back to when REDIS_URL isn't set, matching this service's existing
 * "optional, falls back to in-memory" shape (see index.ts's
 * DATABASE_URL/InMemoryIamStore).
 *
 * Even single-process, the race caching-iam-store.ts's git history
 * describes is real: `await loader()` (a Postgres round trip) yields the
 * event loop, so a concurrent delete()/clear() from a different request can
 * run to completion while a getOrLoad() for the same key is suspended
 * mid-load — Node being single-threaded prevents data races, not this kind
 * of interleaving. So this cache uses the same generation-tagged-key scheme
 * as redis-cache.ts, not just a bare Map:
 *
 * Every key is stored under a *namespace* generation (bumped by clear())
 * and a *per-key* generation (bumped by delete()), both captured by
 * getOrLoad() before it calls loader() — not after. The eventual write
 * targets that captured (namespaceGen, keyGen) pair, never whatever's
 * current when the write actually happens. If either counter advanced
 * while the load was in flight, the write lands under a storage key that
 * `storageKey()` will never compute again for a future read — the value is
 * written, but effectively unreachable, exactly as if the write had been
 * silently dropped. No read ever needs to check "is this stale" after the
 * fact; staleness is unreachable by construction rather than detected.
 *
 * ## Stampede coalescing
 *
 * `inFlightLoads` maps a storage key to the in-flight `loader()` promise
 * currently populating it. A second (or third, or hundredth) concurrent
 * getOrLoad() for the same key joins that promise instead of calling
 * `loader()` again — the common case this protects is a burst of
 * simultaneous requests all missing on the same freshly-expired
 * effective-policy or user lookup at once. Keying this map by the same
 * generation-tagged *storage* key (not the bare `key` argument) is what
 * keeps it safe under a concurrent invalidation: a delete()/clear() that
 * lands mid-load changes what storage key the *next* caller computes, so
 * that caller misses the in-flight-loads map too (a different key) and
 * starts its own fresh load under the new generation, rather than
 * incorrectly joining a load that was already stale when it started.
 */
export class MemoryCache<V> implements Cache<V> {
    private readonly inner: TtlCache<string, V>;
    private namespaceGeneration = 0;
    private readonly keyGenerations = new Map<string, number>();
    private readonly inFlightLoads = new Map<string, Promise<V>>();
    private loads = 0;
    private coalesced = 0;
    private loadTimeMsTotal = 0;
    private invalidations = 0;

    constructor(ttlMs: number, maxSize = 10_000) {
        this.inner = new TtlCache(ttlMs, maxSize);
    }

    private keyGenerationOf(key: string): number {
        return this.keyGenerations.get(key) ?? 0;
    }

    private storageKey(namespaceGen: number, keyGen: number, key: string): string {
        return `${namespaceGen}:${keyGen}:${key}`;
    }

    async getOrLoad(
        key: string,
        loader: () => Promise<V>,
        shouldCache?: (value: V) => boolean,
        ttlMsForValue?: (value: V) => number | undefined
    ): Promise<V> {
        // Captured now, before loader() below can yield to anything that
        // might call delete()/clear() — see class doc comment.
        const namespaceGen = this.namespaceGeneration;
        const keyGen = this.keyGenerationOf(key);
        const storageKey = this.storageKey(namespaceGen, keyGen, key);

        const cached = this.inner.get(storageKey);
        if (cached !== undefined) return cached;

        const inFlight = this.inFlightLoads.get(storageKey);
        if (inFlight) {
            this.coalesced++;
            return inFlight;
        }

        const loadPromise = (async () => {
            const startedAt = Date.now();
            try {
                const value = await loader();
                this.loads++;
                this.loadTimeMsTotal += Date.now() - startedAt;
                if (!shouldCache || shouldCache(value)) {
                    this.inner.set(storageKey, value, ttlMsForValue?.(value));
                }
                return value;
            } finally {
                this.inFlightLoads.delete(storageKey);
            }
        })();
        this.inFlightLoads.set(storageKey, loadPromise);
        return loadPromise;
    }

    async delete(key: string): Promise<void> {
        this.keyGenerations.set(key, this.keyGenerationOf(key) + 1);
        this.invalidations++;
    }

    async clear(): Promise<void> {
        this.namespaceGeneration++;
        this.keyGenerations.clear();
        this.invalidations++;
        // Not required for correctness (every entry from before this point
        // is already unreachable — its storage key embeds the old
        // namespace generation, which storageKey() will never produce
        // again) but keeps this cache's memory bounded rather than relying
        // solely on maxSize/LRU eviction to reclaim now-dead entries.
        this.inner.clear();
    }

    async stats(): Promise<CacheStats> {
        const inner = this.inner.stats;
        return {
            hits: inner.hits,
            misses: inner.misses,
            size: inner.size,
            loads: this.loads,
            coalesced: this.coalesced,
            loadTimeMsTotal: this.loadTimeMsTotal,
            evictions: inner.evictions,
            expirations: inner.expirations,
            invalidations: this.invalidations,
            redisErrors: 0,
            degraded: false,
        };
    }
}
