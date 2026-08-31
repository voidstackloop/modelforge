import { describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./fake-redis.js";
import { RedisCache } from "./redis-cache.js";

function loaderGate(): { started: Promise<void>; release: (value: string) => void; loader: () => Promise<string> } {
    let markStarted!: () => void;
    const started = new Promise<void>((res) => {
        markStarted = res;
    });
    let release!: (value: string) => void;
    const gate = new Promise<string>((res) => {
        release = res;
    });
    return {
        started,
        release,
        loader: async () => {
            markStarted();
            return gate;
        },
    };
}

describe("RedisCache", () => {
    it("serves a cached value on a second load without calling the loader again", async () => {
        const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
        let calls = 0;
        const load = async () => {
            calls++;
            return "v1";
        };

        expect(await cache.getOrLoad("k", load)).toBe("v1");
        expect(await cache.getOrLoad("k", load)).toBe("v1");
        expect(calls).toBe(1);
    });

    it("does not resurrect a stale value when delete() races an in-flight load for the same key", async () => {
        const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
        const gate = loaderGate();

        const inFlight = cache.getOrLoad("k", gate.loader);
        await gate.started;
        await cache.delete("k");
        gate.release("stale");

        expect(await inFlight).toBe("stale"); // the in-flight reader still sees what it read

        let calls = 0;
        const after = await cache.getOrLoad("k", async () => {
            calls++;
            return "fresh";
        });
        expect(after).toBe("fresh"); // a later read must not see the stale write delete() raced against
        expect(calls).toBe(1);
    });

    it("does not resurrect a stale value when clear() races an in-flight load", async () => {
        const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
        const gate = loaderGate();

        const inFlight = cache.getOrLoad("k", gate.loader);
        await gate.started;
        await cache.clear();
        gate.release("stale");

        expect(await inFlight).toBe("stale");

        const after = await cache.getOrLoad("k", async () => "fresh");
        expect(after).toBe("fresh");
    });

    it("delete() invalidates only the targeted key, leaving other keys cached", async () => {
        const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
        await cache.getOrLoad("a", async () => "a1");
        await cache.getOrLoad("b", async () => "b1");

        await cache.delete("a");

        let bCalls = 0;
        expect(
            await cache.getOrLoad("b", async () => {
                bCalls++;
                return "b2";
            })
        ).toBe("b1");
        expect(bCalls).toBe(0);

        expect(await cache.getOrLoad("a", async () => "a2")).toBe("a2");
    });

    it("clear() invalidates every key in the namespace", async () => {
        const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
        await cache.getOrLoad("a", async () => "a1");
        await cache.getOrLoad("b", async () => "b1");

        await cache.clear();

        expect(await cache.getOrLoad("a", async () => "a2")).toBe("a2");
        expect(await cache.getOrLoad("b", async () => "b2")).toBe("b2");
    });

    it("never caches a value shouldCache rejects (e.g. a null 'not found')", async () => {
        const cache = new RedisCache<string | null>(new FakeRedis(), "ns", 60_000);
        const notNull = (v: string | null): boolean => v !== null;

        expect(await cache.getOrLoad("k", async () => null, notNull)).toBeNull();

        let calls = 0;
        expect(
            await cache.getOrLoad(
                "k",
                async () => {
                    calls++;
                    return "found-now";
                },
                notNull
            )
        ).toBe("found-now");
        expect(calls).toBe(1);
    });

    it("treats a read failure as a safe miss, never throwing or serving stale data", async () => {
        const redis = new FakeRedis();
        const cache = new RedisCache<string>(redis, "ns", 60_000);
        await cache.getOrLoad("k", async () => "v1"); // warm the cache

        redis.failNextGet = true;
        let calls = 0;
        const result = await cache.getOrLoad("k", async () => {
            calls++;
            return "v2";
        });

        expect(result).toBe("v2"); // fell through to the loader rather than throwing
        expect(calls).toBe(1);
    });

    it("does not claim a failed delete() succeeded, and bypasses the cache until recovery", async () => {
        const redis = new FakeRedis();
        const cache = new RedisCache<string>(redis, "ns", 60_000);
        let calls = 0;
        const load = async (v: string) => {
            calls++;
            return v;
        };

        await cache.getOrLoad("k", () => load("v1")); // warm the cache, calls=1

        redis.failNextIncr = true;
        await cache.delete("k"); // invalidation fails — must not be silently treated as success

        // Recovery happens on the very next getOrLoad call: its
        // opportunistic generation bump succeeds (Redis is healthy again),
        // which both clears "degraded" and — being a fresh generation —
        // forces a real reload rather than risking the pre-"invalidation"
        // cached value ("v1").
        expect(await cache.getOrLoad("k", () => load("v2"))).toBe("v2");
        expect(calls).toBe(2);

        // Cache is healthy again: this read hits what the recovery call
        // cached, without invoking the loader.
        expect(await cache.getOrLoad("k", () => load("v3"))).toBe("v2");
        expect(calls).toBe(2);
    });

    it("does not claim a failed clear() succeeded, and bypasses the cache until recovery", async () => {
        const redis = new FakeRedis();
        const cache = new RedisCache<string>(redis, "ns", 60_000);
        let calls = 0;
        const load = async (v: string) => {
            calls++;
            return v;
        };

        await cache.getOrLoad("k", () => load("v1"));

        redis.failNextIncr = true;
        await cache.clear(); // fails — degraded

        expect(await cache.getOrLoad("k", () => load("v2"))).toBe("v2"); // recovers + forces reload
        expect(calls).toBe(2);

        expect(await cache.getOrLoad("k", () => load("v3"))).toBe("v2"); // cache healthy again
        expect(calls).toBe(2);
    });

    it("reports hit/miss/size stats without counting generation-counter keys", async () => {
        const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
        await cache.getOrLoad("k", async () => "v1"); // miss
        await cache.getOrLoad("k", async () => "v1"); // hit

        expect(await cache.stats()).toEqual({
            hits: 1,
            misses: 1,
            size: 1,
            loads: 1,
            coalesced: 0,
            loadTimeMsTotal: expect.any(Number),
            evictions: 0,
            expirations: 0,
            invalidations: 0,
            redisErrors: 0,
            degraded: false,
        });
    });

    it("counts a successful invalidation but not a failed one", async () => {
        const redis = new FakeRedis();
        const cache = new RedisCache<string>(redis, "ns", 60_000);

        await cache.delete("a");
        await cache.clear();
        expect((await cache.stats()).invalidations).toBe(2);

        redis.failNextIncr = true;
        await cache.delete("b"); // fails — must not be counted
        expect((await cache.stats()).invalidations).toBe(2);
    });

    it("counts each caught Redis operation failure in redisErrors", async () => {
        const redis = new FakeRedis();
        const cache = new RedisCache<string>(redis, "ns", 60_000);
        await cache.getOrLoad("k", async () => "v1");

        redis.failNextGet = true;
        await cache.getOrLoad("k", async () => "v2");
        expect((await cache.stats()).redisErrors).toBe(1);

        redis.failNextIncr = true;
        await cache.delete("k");
        expect((await cache.stats()).redisErrors).toBe(2);
    });

    describe("recoverIfDegraded()", () => {
        it("is a no-op when the cache isn't degraded", async () => {
            const redis = new FakeRedis();
            const cache = new RedisCache<string>(redis, "ns", 60_000);

            await cache.recoverIfDegraded();

            expect((await cache.stats()).degraded).toBe(false);
            expect((await cache.stats()).invalidations).toBe(0); // no generation bump was attempted
        });

        it("clears degraded mode proactively, without waiting for the next getOrLoad()", async () => {
            const redis = new FakeRedis();
            const cache = new RedisCache<string>(redis, "ns", 60_000);
            await cache.getOrLoad("k", async () => "v1");

            redis.failNextIncr = true;
            await cache.delete("k"); // fails — degraded
            expect((await cache.stats()).degraded).toBe(true);

            await cache.recoverIfDegraded(); // Redis is healthy again
            expect((await cache.stats()).degraded).toBe(false);

            // Confirms the recovery was a real generation bump, not just a
            // flag flip: the pre-degradation value must not be served.
            let calls = 0;
            const after = await cache.getOrLoad("k", async () => {
                calls++;
                return "v2";
            });
            expect(after).toBe("v2");
            expect(calls).toBe(1);
        });
    });

    describe("stampede coalescing", () => {
        // Unlike MemoryCache, RedisCache's normal (non-degraded) path does
        // several real awaited FakeRedis calls (two generation reads, then
        // a data GET) before it ever reaches the in-flight-loads check —
        // each one a genuine microtask hop, even though FakeRedis has no
        // artificial latency. A concurrent caller created right after
        // `gate.started` resolves hasn't necessarily finished its own
        // chain of those hops yet, so releasing the gate immediately can
        // let the first load complete (and remove itself from the
        // in-flight map) before a second, still-catching-up caller ever
        // checks it — a race in the test's synchronization, not in
        // RedisCache itself. Draining the microtask queue with
        // `setImmediate` (a macrotask boundary, so it only runs once every
        // currently-queued microtask — including every concurrent
        // caller's pending awaits — has settled) before releasing the gate
        // makes these tests deterministic.
        function flushMicrotasks(): Promise<void> {
            return new Promise((resolve) => setImmediate(resolve));
        }

        function loaderGate(): { started: Promise<void>; release: (value: string) => void; loader: () => Promise<string> } {
            let markStarted!: () => void;
            const started = new Promise<void>((res) => {
                markStarted = res;
            });
            let release!: (value: string) => void;
            const gate = new Promise<string>((res) => {
                release = res;
            });
            return {
                started,
                release,
                loader: async () => {
                    markStarted();
                    return gate;
                },
            };
        }

        it("joins an in-flight load instead of calling the loader again for concurrent misses on the same key", async () => {
            const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
            const gate = loaderGate();

            const first = cache.getOrLoad("k", gate.loader);
            await gate.started;

            const second = cache.getOrLoad("k", async () => "should-not-run");
            const third = cache.getOrLoad("k", async () => "should-not-run");
            await flushMicrotasks(); // let second/third's own generation-read + GET hops reach the in-flight check

            gate.release("v1");

            expect(await first).toBe("v1");
            expect(await second).toBe("v1");
            expect(await third).toBe("v1");

            const stats = await cache.stats();
            expect(stats.loads).toBe(1);
            expect(stats.coalesced).toBe(2);
        });

        it("does not coalesce across a concurrent invalidation", async () => {
            const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
            const gate = loaderGate();

            const first = cache.getOrLoad("k", gate.loader);
            await gate.started;

            await cache.delete("k");

            let secondCalls = 0;
            const second = cache.getOrLoad("k", async () => {
                secondCalls++;
                return "v2";
            });

            gate.release("v1");

            expect(await first).toBe("v1");
            expect(await second).toBe("v2");
            expect(secondCalls).toBe(1);
            expect((await cache.stats()).coalesced).toBe(0);
        });

        it("also coalesces concurrent misses while degraded, protecting the backing store during a Redis outage", async () => {
            const redis = new FakeRedis();
            const cache = new RedisCache<string>(redis, "ns", 60_000);

            redis.failNextIncr = true;
            await cache.delete("k"); // -> degraded

            // Each getOrLoad() call while degraded attempts its own
            // opportunistic recovery bump first — both must fail here so
            // both calls actually take the degraded (coalescing) path
            // instead of one of them recovering and diverging onto the
            // normal generation-keyed path.
            const gate = loaderGate();
            redis.failNextIncr = true;
            const first = cache.getOrLoad("k", gate.loader);
            await gate.started;

            redis.failNextIncr = true;
            const second = cache.getOrLoad("k", async () => "should-not-run");
            await flushMicrotasks(); // let second's own (failed) recovery attempt reach the in-flight check

            gate.release("v1");

            expect(await first).toBe("v1");
            expect(await second).toBe("v1");
            expect((await cache.stats()).coalesced).toBe(1);
            expect((await cache.stats()).degraded).toBe(true); // never recovered during this test
        });
    });

    describe("per-value TTL override", () => {
        it("ttlMsForValue overrides the cache's default TTL for that one write", async () => {
            vi.useFakeTimers();
            try {
                const cache = new RedisCache<string>(new FakeRedis(), "ns", 60_000);
                await cache.getOrLoad("k", async () => "short-lived", undefined, () => 1_000);

                vi.advanceTimersByTime(1_001);

                let calls = 0;
                const after = await cache.getOrLoad("k", async () => {
                    calls++;
                    return "reloaded";
                });
                expect(after).toBe("reloaded");
                expect(calls).toBe(1);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
