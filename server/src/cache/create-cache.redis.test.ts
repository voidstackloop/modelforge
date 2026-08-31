import { describe, it, expect, afterEach } from "vitest";
import { createCacheFactory, type CacheHandle } from "./create-cache.js";
import { RedisCache } from "./redis-cache.js";

// Same disclosure as store/postgres-case-store.test.ts: gated on REDIS_URL,
// skipped (not failed) when absent. create-cache.test.ts's own doc comment
// explains why the real-`ioredis` path (redisUrl set) was previously
// exercised nowhere at all — not even gated-and-skipped — "covered by
// typechecking and code review rather than an automated test." This file is
// that automated test: it proves createCacheFactory's connection-lifecycle
// wiring (lazyConnect, the `ready` handler, close()) actually works against
// a real Redis, not just that RedisCache's own logic is correct against
// redis-cache.test.ts's FakeRedis.
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("createCacheFactory with a real Redis (integration — requires REDIS_URL)", () => {
    let handle: CacheHandle;

    afterEach(async () => {
        await handle?.close();
    });

    it("returns a RedisCache, not the in-memory fallback, once redisUrl is set", () => {
        handle = createCacheFactory({ redisUrl: REDIS_URL, ttlMs: 60_000 });
        const cache = handle.factory<string>(`ci-test-${Date.now()}`);
        expect(cache).toBeInstanceOf(RedisCache);
    });

    it("actually round-trips through Redis — a second getOrLoad for the same key hits the cache, not the loader", async () => {
        handle = createCacheFactory({ redisUrl: REDIS_URL, ttlMs: 60_000 });
        const cache = handle.factory<string>(`ci-test-${Date.now()}`);

        let calls = 0;
        const load = async () => {
            calls++;
            return "real-redis-value";
        };

        expect(await cache.getOrLoad("k", load)).toBe("real-redis-value");
        expect(await cache.getOrLoad("k", load)).toBe("real-redis-value");
        expect(calls).toBe(1); // second call was served from Redis, not re-loaded
    });

    it("delete() actually clears the key in Redis, not just in this process", async () => {
        handle = createCacheFactory({ redisUrl: REDIS_URL, ttlMs: 60_000 });
        const cache = handle.factory<string>(`ci-test-${Date.now()}`);

        let calls = 0;
        const load = async () => {
            calls++;
            return `v${calls}`;
        };

        expect(await cache.getOrLoad("k", load)).toBe("v1");
        await cache.delete("k");
        expect(await cache.getOrLoad("k", load)).toBe("v2"); // reloaded — the old entry is really gone
    });

    it("close() disconnects cleanly without throwing", async () => {
        handle = createCacheFactory({ redisUrl: REDIS_URL, ttlMs: 60_000 });
        await expect(handle.close()).resolves.toBeUndefined();
    });
});
