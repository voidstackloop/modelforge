import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./ttl-cache.js";

describe("TtlCache", () => {
    it("returns undefined and counts a miss for an absent key", () => {
        const cache = new TtlCache<string, number>(1000);
        expect(cache.get("a")).toBeUndefined();
        expect(cache.stats).toEqual({ hits: 0, misses: 1, size: 0, evictions: 0, expirations: 0 });
    });

    it("returns a set value and counts a hit", () => {
        const cache = new TtlCache<string, number>(1000);
        cache.set("a", 1);
        expect(cache.get("a")).toBe(1);
        expect(cache.stats).toEqual({ hits: 1, misses: 0, size: 1, evictions: 0, expirations: 0 });
    });

    it("expires an entry once its TTL elapses", () => {
        vi.useFakeTimers();
        try {
            const cache = new TtlCache<string, number>(1000);
            cache.set("a", 1);
            vi.advanceTimersByTime(999);
            expect(cache.get("a")).toBe(1);
            vi.advanceTimersByTime(2);
            expect(cache.get("a")).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("evicts the least-recently-used entry once maxSize is exceeded", () => {
        const cache = new TtlCache<string, number>(1000, 2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.get("a"); // touch "a" so "b" becomes the least-recently-used one
        cache.set("c", 3);

        expect(cache.get("a")).toBe(1);
        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("c")).toBe(3);
        expect(cache.stats.evictions).toBe(1);
    });

    it("removes an entry on delete", () => {
        const cache = new TtlCache<string, number>(1000);
        cache.set("a", 1);
        cache.delete("a");
        expect(cache.get("a")).toBeUndefined();
    });

    it("removes every entry on clear", () => {
        const cache = new TtlCache<string, number>(1000);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.clear();
        expect(cache.stats.size).toBe(0);
    });

    it("set() honors a per-entry TTL override instead of the cache's default", () => {
        vi.useFakeTimers();
        try {
            const cache = new TtlCache<string, number>(60_000); // long default TTL
            cache.set("short-lived", 1, 1_000); // this one entry expires much sooner
            cache.set("normal", 2); // default TTL applies

            vi.advanceTimersByTime(1_001);

            expect(cache.get("short-lived")).toBeUndefined(); // expired under its override
            expect(cache.get("normal")).toBe(2); // still alive under the 60s default
            cache.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("proactively reclaims expired entries via a periodic sweep, without needing a read to trigger it", () => {
        vi.useFakeTimers();
        try {
            const cache = new TtlCache<string, number>(1_000); // TTL shorter than the sweep interval's 30s floor
            cache.set("a", 1);
            expect(cache.stats.size).toBe(1);

            // Past both the entry's own TTL and the sweep interval — but
            // this test never calls cache.get("a"), so lazy expiry-on-read
            // can't be what removes it.
            vi.advanceTimersByTime(30_000);

            expect(cache.stats.size).toBe(0);
            expect(cache.stats.expirations).toBe(1);
            cache.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("dispose() stops the periodic sweep", () => {
        vi.useFakeTimers();
        try {
            const cache = new TtlCache<string, number>(1_000);
            cache.set("a", 1);
            cache.dispose();

            vi.advanceTimersByTime(60_000); // well past the sweep interval

            // The entry is still logically expired (TTL-wise), but with the
            // sweep stopped nothing proactively removed it — this only
            // confirms dispose() actually stopped the timer, not a claim
            // about read-time expiry (which still applies on the next get()).
            expect(cache.stats.expirations).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
