import { Redis } from "ioredis";
import type { CacheFactory, CacheOptions } from "./cache.js";
import { MemoryCache } from "./memory-cache.js";
import { RedisCache } from "./redis-cache.js";

/** The one piece of RedisCache this module needs to track per instance —
 * deliberately not `RedisCache<unknown>` (see the `instances` doc comment
 * below for why that shape can't be constructed here without losing the
 * per-call generic type). `recoverIfDegraded()`'s own signature doesn't
 * mention `V` at all, so any `RedisCache<V>` structurally satisfies this
 * regardless of what V a given call site asked for. */
interface Recoverable {
    recoverIfDegraded(): Promise<void>;
}

export interface CacheFactoryOptions {
    /** Standard `redis://[:password@]host:port[/db]` connection string. If
     * unset, every sub-cache falls back to the in-memory MemoryCache — same
     * "optional, falls back to in-memory" shape as index.ts's
     * DATABASE_URL/InMemoryIamStore, so local development and this
     * package's own test suite need no Redis instance at all. See
     * server/docker-compose.yml for a local one. */
    redisUrl?: string;
    ttlMs: number;
    /** MemoryCache only — RedisCache has no equivalent bound. Redis itself,
     * not this process, owns memory pressure/eviction; a deployment
     * running this service against Redis should configure Redis's own
     * `maxmemory` + `maxmemory-policy` (e.g. `volatile-lru`, since every
     * key this service writes carries a TTL already — see
     * server/README.md's "Caching" section). This process doesn't (and,
     * without a second network round trip per write, can't cheaply)
     * enforce a size bound of its own against Redis. */
    maxSize?: number;
}

export interface CacheHandle {
    factory: CacheFactory;
    /** Closes the underlying Redis connection, if one was opened. A no-op
     * for the in-memory backend. Call on process shutdown. */
    close: () => Promise<void>;
}

// ioredis's own default (10s) — made explicit rather than implicit, so
// it's a documented, intentional choice rather than "whatever the library
// happens to default to today."
const CONNECT_TIMEOUT_MS = 10_000;
// Bounds *reconnection* backoff (distinct from maxRetriesPerRequest below,
// which bounds a single in-flight command's own retries) — ioredis calls
// this on every dropped connection with an increasing attempt count, and
// keeps retrying indefinitely by design: Redis coming back should be
// picked up automatically, without an operator having to restart this
// service. The cap just stops the delay between attempts from growing
// without bound the longer an outage lasts.
const MAX_RECONNECT_DELAY_MS = 5_000;

/**
 * Builds the CacheFactory caching-iam-store.ts uses to create one Cache<V>
 * per sub-cache. With REDIS_URL set, every sub-cache is a RedisCache
 * sharing a single connection — the actual reason to reach for Redis over
 * the in-memory default: a multi-instance deployment gets one shared,
 * coherent cache (an update from one instance is visible to every other
 * instance's next read) instead of each instance carrying its own
 * this-process-only cache, each cold on its own TTL after every restart.
 *
 * ## Connection lifecycle
 *
 * `lazyConnect: true` — the connection attempt happens on first command,
 * not at construction, so building this factory never itself blocks
 * startup on Redis being reachable (index.ts's caller doesn't await
 * anything here). Every connection-state transition is logged as a single-
 * line structured event (`redis_cache_*`) so an operator can correlate a
 * degraded-cache period in the app's own logs with what Redis itself was
 * doing, without this process ever logging connection credentials (the
 * `redisUrl` itself, which may embed a password, is never logged — only
 * ioredis's own event payloads, which don't include it).
 *
 * `ready` — fired once a connection is confirmed healthy (after `connect`
 * and, if configured, auth/select) — is when every RedisCache this factory
 * has ever created gets `recoverIfDegraded()` called on it, so a namespace
 * that isn't being actively read doesn't sit degraded (safe, but slower)
 * for longer than it takes Redis to actually come back.
 */
export function createCacheFactory(options: CacheFactoryOptions): CacheHandle {
    if (!options.redisUrl) {
        return {
            factory: (_namespace, namespaceOptions) => new MemoryCache(namespaceOptions?.ttlMs ?? options.ttlMs, options.maxSize),
            close: async () => {},
        };
    }

    const redis = new Redis(options.redisUrl, {
        lazyConnect: true,
        // maxRetriesPerRequest: 1 keeps a single failed command
        // fast-failing into RedisCache's own catch (see its doc comment)
        // rather than retrying for a long time on the hot request path
        // while Redis is down.
        maxRetriesPerRequest: 1,
        connectTimeout: CONNECT_TIMEOUT_MS,
        retryStrategy: (attempt) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
    });

    // Tracks every RedisCache this factory has handed out, purely so the
    // `ready` handler below can call recoverIfDegraded() on each. Typed as
    // Recoverable[], not RedisCache<unknown>[] — the latter would force
    // `factory` below to construct a RedisCache<unknown> and return it as
    // Cache<V>, which isn't type-safe for an arbitrary caller-chosen V
    // (that's exactly the assignability error this shape avoids).
    const instances: Recoverable[] = [];

    redis.on("error", (err) => console.warn(JSON.stringify({ event: "redis_cache_connection_error", message: err.message })));
    redis.on("close", () => console.warn(JSON.stringify({ event: "redis_cache_connection_closed" })));
    redis.on("reconnecting", (delayMs: number) => console.warn(JSON.stringify({ event: "redis_cache_reconnecting", delayMs })));
    redis.on("ready", () => {
        console.log(JSON.stringify({ event: "redis_cache_ready" }));
        for (const cache of instances) void cache.recoverIfDegraded();
    });

    return {
        // Explicitly generic (`<V>`), not inferred from context — once
        // this function's body does anything beyond a single direct
        // `return new RedisCache(...)` (here, tracking the instance too),
        // TypeScript stops flowing the caller's requested V into `new
        // RedisCache(...)`'s own type argument and would otherwise
        // silently collapse it to `unknown`. Declaring `<V>` explicitly
        // and instantiating `new RedisCache<V>(...)` sidesteps that
        // inference gap entirely.
        factory: <V>(namespace: string, namespaceOptions?: CacheOptions): RedisCache<V> => {
            const cache = new RedisCache<V>(redis, namespace, namespaceOptions?.ttlMs ?? options.ttlMs);
            instances.push(cache);
            return cache;
        },
        close: async () => {
            redis.disconnect();
        },
    };
}
