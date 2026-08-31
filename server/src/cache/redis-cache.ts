import type { Cache, CacheStats } from "./cache.js";

/** The subset of ioredis's `Redis` client this module actually calls —
 * kept minimal and separate from the concrete `ioredis` type so tests can
 * pass a small in-process fake (see fake-redis.ts) instead of a live Redis
 * server. A real `Redis` instance satisfies this structurally. */
export interface RedisLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
    incr(key: string): Promise<number>;
    del(...keys: string[]): Promise<number>;
    /** Matches only the exact call shape stats() below uses — ioredis's
     * real `scan` is a much wider overload set, but structurally matching
     * just the shape actually called is enough for `Redis` to satisfy this
     * interface, and simpler than reproducing the whole overload set here. */
    scan(cursor: string, matchToken: "MATCH", pattern: string, countToken: "COUNT", count: number): Promise<[string, string[]]>;
}

const SCAN_COUNT = 200;
/** Prefixes every degraded-mode coalescing key — see getOrLoad()'s doc
 * comment. Distinct from dataKey()'s `iam-cache:` prefix so the two key
 * spaces can never collide. */
const DEGRADED_COALESCE_PREFIX = "degraded";

/**
 * Redis-backed Cache<V> — see create-cache.ts for when this is chosen over
 * memory-cache.ts, and cache.ts's doc comment for why there's no plain
 * get()/set() to build getOrLoad() out of at the call site.
 *
 * ## Generation-tagged keys, not SCAN+DEL, for correctness
 *
 * Every cached value lives at a key that embeds two counters: this
 * namespace's generation (`{namespace}:ns-gen`, bumped by clear()) and this
 * specific key's generation (`{namespace}:key-gen:{key}`, bumped by
 * delete()). getOrLoad() reads both counters *before* calling `loader()`,
 * and writes the loaded value to the data key computed from that captured
 * pair — not whatever the counters say once the load (a real Postgres
 * round trip, awaited across the network) finishes.
 *
 * That's what makes a concurrent invalidation during an in-flight load
 * safe: bumping a counter is a single atomic INCR, and it changes what key
 * *future* reads compute for that namespace/key — it never has to find and
 * delete the in-flight load's eventual write, because that write lands
 * under the *old* counter value, which nothing will ever ask for again.
 * Previously (see git history) invalidation ran a non-atomic SCAN+DEL over
 * the namespace's keys, which a load that raced it could simply out-live —
 * the load's `set()` after the DEL pass re-created exactly the entry the
 * DEL was trying to remove. Counter keys have no TTL of their own (unlike
 * data keys, which still carry the configured ttlMs) — they're small
 * integers, one per distinct key ever deleted or cleared, bounded by this
 * service's actual entity count rather than by time; data keys under a
 * stale counter value are left for Redis's own TTL to reap rather than
 * hunted down and deleted, exactly as the design calls for ("old-generation
 * keys may expire naturally by TTL; cleanup is best-effort only").
 *
 * ## Stampede coalescing
 *
 * `inFlightLoads` maps a data key to its in-flight `loader()` promise, so
 * concurrently-arriving requests for the same key join one load instead of
 * each issuing their own Postgres query (and, ordinarily, their own
 * redundant Redis SET afterward). Keying by the *data* key (which embeds
 * both generation counters) gives the same safety property MemoryCache's
 * coalescing has: a concurrent delete()/clear() changes what data key the
 * *next* caller computes, so it can never join a load that a since-landed
 * invalidation has already made stale.
 *
 * While degraded (below), there's no generation to key by — every value is
 * a direct, uncached passthrough to `loader()`, so a `DEGRADED_COALESCE_PREFIX`-
 * prefixed key derived from the bare `key` argument is used instead. This
 * is exactly when coalescing matters most: a Redis outage is precisely the
 * condition under which a burst of concurrent requests could otherwise
 * each fall through to Postgres independently and turn a cache outage into
 * a database overload too.
 *
 * ## Failed invalidation must never be silent
 *
 * If the INCR behind delete()/clear() itself fails (Redis unreachable),
 * this cache cannot claim the invalidation happened — the counter didn't
 * move, so any value cached under the old counter is still exactly as
 * reachable as before the call. Silently treating that as success (as a
 * bare "log and swallow" would) is how a Redis outage during a permission
 * revocation could leave the revoked grant servable from cache once Redis
 * reconnects. Instead this cache flips into a `degraded` state: every
 * getOrLoad() bypasses the cache entirely (reads the store directly,
 * caches nothing) until a generation bump actually succeeds. Recovery
 * happens two ways: opportunistically, retried on the next getOrLoad()
 * call while degraded; and proactively, via `recoverIfDegraded()`, which
 * create-cache.ts calls on every cache instance when the shared ioredis
 * client reports its `ready` event (i.e. as soon as the connection itself
 * is confirmed healthy again, without waiting for the next request to this
 * particular namespace). A successful bump, however it's reached, is by
 * itself sufficient to guarantee correctness again: it advances the
 * namespace generation past whatever an in-flight load from *before* or
 * *during* the outage could have captured, so any such load's eventual
 * write is orphaned exactly like the normal case above.
 *
 * This only protects the process that observed the failure. A
 * multi-instance deployment sharing one Redis needs every instance to
 * agree "this generation is dead" — which the shared INCR already gives
 * them, since it's one counter in Redis, not one per process. The failure
 * mode this guards is narrower: an instance that *itself* couldn't confirm
 * its own invalidation stays degraded (safe) until it can, rather than
 * assuming success and letting some other instance's cached read serve
 * data that instance never confirmed was invalidated.
 */
export class RedisCache<V> implements Cache<V> {
    private hits = 0;
    private misses = 0;
    private loads = 0;
    private coalesced = 0;
    private loadTimeMsTotal = 0;
    private invalidations = 0;
    private redisErrors = 0;
    private degraded = false;
    private readonly inFlightLoads = new Map<string, Promise<V>>();

    constructor(
        private readonly redis: RedisLike,
        private readonly namespace: string,
        private readonly ttlMs: number
    ) {}

    private logError(op: string, err: unknown): void {
        this.redisErrors++;
        // Structured (one JSON object per line) and deliberately limited to
        // { op, namespace, message } — never the key or value involved, so
        // this can never leak a subject identifier, a user id, or policy
        // content into logs. See cache.ts's CacheStats doc comment for the
        // same constraint applied to the programmatic stats() surface.
        console.warn(JSON.stringify({ event: "cache_redis_error", op, namespace: this.namespace, message: (err as Error).message }));
    }

    private namespaceGenKey(): string {
        return `iam-cache:${this.namespace}:ns-gen`;
    }

    private keyGenKey(key: string): string {
        return `iam-cache:${this.namespace}:key-gen:${key}`;
    }

    private dataKey(namespaceGen: number, keyGen: number, key: string): string {
        return `iam-cache:${this.namespace}:data:${namespaceGen}:${keyGen}:${key}`;
    }

    private async readGeneration(genKey: string): Promise<number> {
        const raw = await this.redis.get(genKey);
        return raw === null ? 0 : Number(raw);
    }

    /** Atomically advances the namespace generation. Returns whether it
     * actually succeeded — callers must not treat a thrown/caught error as
     * success. */
    private async bumpNamespaceGeneration(): Promise<boolean> {
        try {
            await this.redis.incr(this.namespaceGenKey());
            return true;
        } catch (err) {
            this.logError("invalidate", err);
            return false;
        }
    }

    private setDegraded(degraded: boolean): void {
        if (this.degraded === degraded) return;
        this.degraded = degraded;
        console.warn(JSON.stringify({ event: degraded ? "cache_degraded" : "cache_recovered", namespace: this.namespace }));
    }

    /** Called by create-cache.ts when the underlying Redis connection
     * reports healthy again — a proactive counterpart to the opportunistic
     * recovery attempt inside getOrLoad() below, so a namespace that isn't
     * being actively read doesn't stay degraded (safe, but slower —
     * uncached) indefinitely just because nothing happened to retry it. A
     * no-op when not currently degraded, so it's cheap to call
     * unconditionally on every reconnect. */
    async recoverIfDegraded(): Promise<void> {
        if (!this.degraded) return;
        if (await this.bumpNamespaceGeneration()) this.setDegraded(false);
    }

    private async runLoad(coalesceKey: string, loader: () => Promise<V>): Promise<V> {
        const inFlight = this.inFlightLoads.get(coalesceKey);
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
                return value;
            } finally {
                this.inFlightLoads.delete(coalesceKey);
            }
        })();
        this.inFlightLoads.set(coalesceKey, loadPromise);
        return loadPromise;
    }

    async getOrLoad(
        key: string,
        loader: () => Promise<V>,
        shouldCache?: (value: V) => boolean,
        ttlMsForValue?: (value: V) => number | undefined
    ): Promise<V> {
        if (this.degraded) {
            // A namespace-wide bump is always a sufficient recovery step
            // regardless of whether the original failure was a delete()
            // (per-key) or a clear() (namespace-wide) — it invalidates
            // everything in this namespace, a strict superset of either,
            // so it's safe to use as the one recovery path for both.
            const recovered = await this.bumpNamespaceGeneration();
            if (recovered) {
                this.setDegraded(false);
            } else {
                this.misses++;
                return this.runLoad(`${DEGRADED_COALESCE_PREFIX}:${this.namespace}:${key}`, loader);
            }
        }

        let namespaceGen: number;
        let keyGen: number;
        try {
            [namespaceGen, keyGen] = await Promise.all([this.readGeneration(this.namespaceGenKey()), this.readGeneration(this.keyGenKey(key))]);
        } catch (err) {
            // A failed *read* never risks staleness (nothing is served or
            // written), so this only costs a cache miss — not degraded
            // mode, which exists solely for failed invalidation.
            this.logError("get", err);
            this.misses++;
            return this.runLoad(`${DEGRADED_COALESCE_PREFIX}:${this.namespace}:${key}`, loader);
        }

        const dataKey = this.dataKey(namespaceGen, keyGen, key);
        try {
            const raw = await this.redis.get(dataKey);
            if (raw !== null) {
                this.hits++;
                return JSON.parse(raw) as V;
            }
        } catch (err) {
            this.logError("get", err);
        }
        this.misses++;

        const value = await this.runLoad(dataKey, loader);
        if (!shouldCache || shouldCache(value)) {
            try {
                await this.redis.set(dataKey, JSON.stringify(value), "PX", ttlMsForValue?.(value) ?? this.ttlMs);
            } catch (err) {
                this.logError("set", err);
            }
        }
        return value;
    }

    async delete(key: string): Promise<void> {
        try {
            await this.redis.incr(this.keyGenKey(key));
            this.invalidations++;
        } catch (err) {
            this.logError("delete", err);
            this.setDegraded(true);
        }
    }

    async clear(): Promise<void> {
        const ok = await this.bumpNamespaceGeneration();
        if (ok) {
            this.invalidations++;
            this.setDegraded(false);
        } else {
            this.setDegraded(true);
        }
    }

    async stats(): Promise<CacheStats> {
        // Best-effort observability only (see class doc comment) — never
        // consulted on the read/write path, so a SCAN here can't
        // reintroduce the correctness problem generation-tagging was
        // built to remove. Counts only data keys, not the generation
        // counters themselves.
        let size = 0;
        try {
            const pattern = `iam-cache:${this.namespace}:data:*`;
            let cursor = "0";
            do {
                const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
                cursor = next;
                size += keys.length;
            } while (cursor !== "0");
        } catch (err) {
            this.logError("stats", err);
        }
        return {
            hits: this.hits,
            misses: this.misses,
            size,
            loads: this.loads,
            coalesced: this.coalesced,
            loadTimeMsTotal: this.loadTimeMsTotal,
            evictions: 0,
            expirations: 0,
            invalidations: this.invalidations,
            redisErrors: this.redisErrors,
            degraded: this.degraded,
        };
    }
}
