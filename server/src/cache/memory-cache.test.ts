import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./memory-cache.js";

/** Resolves once the in-flight getOrLoad's loader() has actually started —
 * lets a test deterministically invalidate *while* a load is suspended
 * mid-flight, regardless of how many microtask hops getOrLoad takes to
 * reach the loader() call. */
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

describe("MemoryCache", () => {
    it("serves a cached value on a second load without calling the loader again", async () => {
        const cache = new MemoryCache<string>(60_000);
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
        const cache = new MemoryCache<string>(60_000);
        const gate = loaderGate();

        const inFlight = cache.getOrLoad("k", gate.loader);
        await gate.started; // the load has captured its generation and is now suspended
        await cache.delete("k"); // invalidates before the load resolves
        gate.release("stale");

        expect(await inFlight).toBe("stale"); // the in-flight reader still sees what it read — not a bug

        let calls = 0;
        const after = await cache.getOrLoad("k", async () => {
            calls++;
            return "fresh";
        });
        expect(after).toBe("fresh"); // but a later read must not see the stale write
        expect(calls).toBe(1);
    });

    it("does not resurrect a stale value when clear() races an in-flight load", async () => {
        const cache = new MemoryCache<string>(60_000);
        const gate = loaderGate();

        const inFlight = cache.getOrLoad("k", gate.loader);
        await gate.started;
        await cache.clear();
        gate.release("stale");

        expect(await inFlight).toBe("stale");

        const after = await cache.getOrLoad("k", async () => "fresh");
        expect(after).toBe("fresh");
    });

    it("delete() invalidates only the targeted key", async () => {
        const cache = new MemoryCache<string>(60_000);
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
        const cache = new MemoryCache<string>(60_000);
        await cache.getOrLoad("a", async () => "a1");
        await cache.getOrLoad("b", async () => "b1");

        await cache.clear();

        expect(await cache.getOrLoad("a", async () => "a2")).toBe("a2");
        expect(await cache.getOrLoad("b", async () => "b2")).toBe("b2");
    });

    it("never caches a value shouldCache rejects (e.g. a null 'not found')", async () => {
        const cache = new MemoryCache<string | null>(60_000);
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
        expect(calls).toBe(1); // the null result above was never cached, so this was a real load
    });

    it("reports hit/miss/size stats", async () => {
        const cache = new MemoryCache<string>(60_000);
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

    describe("stampede coalescing", () => {
        it("joins an in-flight load instead of calling the loader again for concurrent misses on the same key", async () => {
            const cache = new MemoryCache<string>(60_000);
            const gate = loaderGate();

            const first = cache.getOrLoad("k", gate.loader);
            await gate.started; // the first call is now suspended mid-load

            // Three more concurrent callers arrive while it's still in
            // flight — none of them should start their own load.
            const second = cache.getOrLoad("k", async () => "should-not-run");
            const third = cache.getOrLoad("k", async () => "should-not-run");

            gate.release("v1");

            expect(await first).toBe("v1");
            expect(await second).toBe("v1");
            expect(await third).toBe("v1");

            const stats = await cache.stats();
            expect(stats.loads).toBe(1);
            expect(stats.coalesced).toBe(2);
        });

        it("does not coalesce across a concurrent invalidation — a caller after delete() starts its own fresh load", async () => {
            const cache = new MemoryCache<string>(60_000);
            const gate = loaderGate();

            const first = cache.getOrLoad("k", gate.loader);
            await gate.started;

            await cache.delete("k"); // bumps this key's generation before the second caller arrives

            let secondCalls = 0;
            const second = cache.getOrLoad("k", async () => {
                secondCalls++;
                return "v2";
            });

            gate.release("v1");

            expect(await first).toBe("v1");
            expect(await second).toBe("v2"); // did NOT receive the stale in-flight load's result
            expect(secondCalls).toBe(1); // started its own load rather than coalescing

            const stats = await cache.stats();
            expect(stats.coalesced).toBe(0);
        });

        it("coalesced callers still get a rejection if the shared load fails, and don't poison later loads", async () => {
            const cache = new MemoryCache<string>(60_000);
            let markStarted!: () => void;
            const started = new Promise<void>((res) => {
                markStarted = res;
            });
            let reject!: (err: Error) => void;
            const gate = new Promise<string>((_res, rej) => {
                reject = rej;
            });

            const first = cache.getOrLoad("k", async () => {
                markStarted();
                return gate;
            });
            await started;
            const second = cache.getOrLoad("k", async () => "should-not-run");

            reject(new Error("backing store unavailable"));

            await expect(first).rejects.toThrow("backing store unavailable");
            await expect(second).rejects.toThrow("backing store unavailable");

            // The failed load must not have left anything in the in-flight
            // map — a later call is a genuinely fresh attempt, not another
            // rejection of the same dead promise.
            const after = await cache.getOrLoad("k", async () => "recovered");
            expect(after).toBe("recovered");
        });
    });

    describe("per-value TTL override", () => {
        it("ttlMsForValue overrides the cache's default TTL for that one write", async () => {
            vi.useFakeTimers();
            try {
                const cache = new MemoryCache<string>(60_000); // long default TTL
                await cache.getOrLoad("k", async () => "short-lived", undefined, () => 1_000);

                vi.advanceTimersByTime(1_001);

                let calls = 0;
                const after = await cache.getOrLoad("k", async () => {
                    calls++;
                    return "reloaded";
                });
                expect(after).toBe("reloaded"); // expired well before the 60s default would have
                expect(calls).toBe(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("a value ttlMsForValue declines to override (returns undefined) keeps the cache's default TTL", async () => {
            vi.useFakeTimers();
            try {
                const cache = new MemoryCache<string>(60_000);
                await cache.getOrLoad("k", async () => "v1", undefined, () => undefined);

                vi.advanceTimersByTime(59_000); // well under the 60s default

                let calls = 0;
                const stillCached = await cache.getOrLoad("k", async () => {
                    calls++;
                    return "v2";
                });
                expect(stillCached).toBe("v1");
                expect(calls).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
