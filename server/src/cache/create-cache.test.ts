import { describe, expect, it } from "vitest";
import { createCacheFactory } from "./create-cache.js";
import { MemoryCache } from "./memory-cache.js";

// The Redis-backed path (redisUrl set) is deliberately not exercised here
// — it constructs a real `ioredis` client, which needs either a live
// Redis server or a refactor to inject a fake client factory. The logic
// that matters (generation-tagged correctness, coalescing,
// degraded/recovery) is unit-tested directly against RedisCache with
// FakeRedis in redis-cache.test.ts; what's left here (connection-lifecycle
// event wiring, the `ready`-triggered recoverIfDegraded() sweep) is
// covered by typechecking and code review rather than an automated test,
// the same boundary this package already draws around
// postgres-iam-store.test.ts (gated on a live DATABASE_URL).
describe("createCacheFactory", () => {
    it("falls back to MemoryCache when redisUrl is unset", () => {
        const { factory } = createCacheFactory({ ttlMs: 60_000 });
        const cache = factory<string>("test-namespace");
        expect(cache).toBeInstanceOf(MemoryCache);
    });

    it("the in-memory factory actually caches (end-to-end sanity check)", async () => {
        const { factory } = createCacheFactory({ ttlMs: 60_000 });
        const cache = factory<string>("test-namespace");

        let calls = 0;
        const load = async () => {
            calls++;
            return "v1";
        };

        expect(await cache.getOrLoad("k", load)).toBe("v1");
        expect(await cache.getOrLoad("k", load)).toBe("v1");
        expect(calls).toBe(1);
    });

    it("honors a per-namespace ttlMs override in the in-memory factory", async () => {
        const { factory } = createCacheFactory({ ttlMs: 60_000 });
        const cache = factory<string>("short-lived", { ttlMs: 1 });

        await cache.getOrLoad("k", async () => "v1");
        await new Promise((resolve) => setTimeout(resolve, 5));

        let calls = 0;
        await cache.getOrLoad("k", async () => {
            calls++;
            return "v2";
        });
        expect(calls).toBe(1); // expired under the 1ms override, not the 60s default
    });

    it("close() is a no-op for the in-memory backend", async () => {
        const { close } = createCacheFactory({ ttlMs: 60_000 });
        await expect(close()).resolves.toBeUndefined();
    });
});
