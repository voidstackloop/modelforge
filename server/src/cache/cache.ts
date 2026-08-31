export interface CacheStats {
    hits: number;
    misses: number;
    size: number;
    /** Number of times `getOrLoad()`'s `loader()` was actually invoked — a
     * strict subset of `misses`: a miss that instead joined an already-
     * in-flight load (see `coalesced`) doesn't call `loader()` again. */
    loads: number;
    /** Number of `getOrLoad()` calls that found a load for the same key
     * already in flight and awaited its result instead of starting a
     * second one — see each implementation's doc comment for the
     * concurrent-miss ("cache stampede") coalescing this counts. */
    coalesced: number;
    /** Sum of wall-clock time (ms) spent inside `loader()` across every
     * call counted in `loads` — divide by `loads` for an average. Cache
     * hits aren't timed (their cost is deliberately negligible); this is
     * meant to answer "how much is the backing store costing us," not to
     * profile the cache itself. */
    loadTimeMsTotal: number;
    /** Entries removed for being over this cache's capacity bound, before
     * their TTL expired. Always 0 for RedisCache — Redis itself, not this
     * process, owns eviction under memory pressure (see
     * create-cache.ts's CacheFactoryOptions.maxSize doc comment). */
    evictions: number;
    /** Entries removed for having outlived their TTL — whether caught
     * lazily (on a `get()` that finds a stale entry) or by MemoryCache's
     * periodic housekeeping sweep (see ttl-cache.ts). Always 0 for
     * RedisCache — Redis expires keys internally; this process never
     * observes that happening and so can't count it. */
    expirations: number;
    /** Number of `delete()`/`clear()` calls that took effect (i.e.
     * genuinely advanced a generation counter) — one count per call, not
     * per key affected, since a `clear()` invalidates an unknown number of
     * keys at once by design (see caching-iam-store.ts's "why broad
     * invalidation" doc comment). A `delete()`/`clear()` that failed
     * (RedisCache only — see `degraded`) is not counted here. */
    invalidations: number;
    /** RedisCache only: count of caught Redis operation failures (get,
     * set, incr, scan) since this cache was created. Always 0 for
     * MemoryCache. A rising count with the process otherwise healthy is
     * the leading indicator of a degrading Redis connection. */
    redisErrors: number;
    /** RedisCache only: whether this cache is currently bypassing reads
     * and refusing to trust a cached value, because a delete()/clear()
     * couldn't confirm it took effect — see redis-cache.ts's class doc
     * comment. Always false for MemoryCache (invalidation there can't
     * fail). */
    degraded: boolean;
}

/**
 * Backend-agnostic cache shape — implemented by both memory-cache.ts (the
 * zero-dependency default) and redis-cache.ts (used when REDIS_URL is
 * configured; see create-cache.ts). Async even for the in-memory
 * implementation, so caching-iam-store.ts (the only caller) never has to
 * know or care which backend it's talking to.
 *
 * There's deliberately no plain get()/set() here — see caching-iam-store.ts
 * (git history) for the race that shape allowed: a caller that does
 * `get()`, misses, loads from the store, then `set()`s the result can have
 * an unrelated delete()/clear() land in between the load and the set(),
 * and the set() then resurrects exactly the value the delete/clear was
 * trying to get rid of. getOrLoad() closes that window by owning both the
 * "what generation was current when this load started" capture and the
 * eventual write, atomically from the caller's perspective — see each
 * implementation's own doc comment for the generation-tagging scheme that
 * makes a write from a stale load land somewhere no future read will ever
 * look, rather than trying to detect and reject it after the fact.
 *
 * getOrLoad() also owns concurrent-miss ("cache stampede") coalescing: if
 * two callers ask for the same key while a load for it is already in
 * flight, the second joins the first's in-flight promise instead of
 * starting a redundant second call to `loader()` — see each
 * implementation's doc comment for how that's kept safe under a concurrent
 * invalidation (it never coalesces across a generation boundary).
 */
export interface Cache<V> {
    /**
     * Returns the cached value for `key` if present and valid; otherwise
     * calls `loader()`, and — unless `shouldCache` is given and returns
     * false for the loaded value — caches the result before returning it.
     * `shouldCache` exists so callers wrapping a `T | null` "look up by id"
     * read (getUser, getOrganization, ...) can opt out of caching a `null`
     * miss, matching this cache's pre-existing behavior of never caching
     * "not found" for those (see caching-iam-store.ts's call sites) —
     * without it, every value `loader()` produces is cached, including an
     * empty array (a fully legitimate, meaningfully-different-from-"not
     * cached" result for a list endpoint).
     *
     * `ttlMsForValue`, when given, is called with the loaded value (only
     * when it's actually being cached) to pick a TTL for *this write*
     * instead of the cache's configured default — returning `undefined`
     * (or omitting this option entirely) keeps the default. This exists
     * for negative caching: caching-iam-store.ts's findUserByExternalSubject
     * caches a "no such user" result too (unlike every other id lookup, to
     * bound repeated store round trips from an authenticated-but-
     * unprovisioned caller), but at a much shorter TTL than a real, found
     * User — see that method's doc comment.
     */
    getOrLoad(
        key: string,
        loader: () => Promise<V>,
        shouldCache?: (value: V) => boolean,
        ttlMsForValue?: (value: V) => number | undefined
    ): Promise<V>;
    /** Invalidates every cached entry for this one key. Safe under a
     * concurrent in-flight getOrLoad() for the same key — see each
     * implementation's doc comment. */
    delete(key: string): Promise<void>;
    /** Invalidates every cached entry in this cache's namespace — used when
     * a group or policy mutation invalidates every cached effective-policy
     * result (see caching-iam-store.ts), since there's no reverse index
     * cheap enough to invalidate just the affected users. Safe under a
     * concurrent in-flight getOrLoad() for any key. */
    clear(): Promise<void>;
    stats(): Promise<CacheStats>;
}

/** Per-namespace options a CacheFactory caller can request — every field
 * optional, falling back to whatever the factory itself was built with
 * (see create-cache.ts's CacheFactoryOptions). */
export interface CacheOptions {
    /** Overrides the factory's default TTL for every entry in this one
     * namespace (not per-entry — for that, see getOrLoad()'s
     * `ttlMsForValue`). Used for caching-iam-store.ts's negative-cache
     * namespace, which needs a shorter default than every other cache. */
    ttlMs?: number;
}

/** Builds one Cache<V> per named sub-cache (organizations, users,
 * effectivePolicies, ...) — see create-cache.ts for the concrete
 * implementations this resolves to. */
export type CacheFactory = <V>(namespace: string, options?: CacheOptions) => Cache<V>;
