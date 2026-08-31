import type { RedisLike } from "./redis-cache.js";

interface Entry {
    value: string;
    expiresAt?: number;
}

function escapeRegExp(segment: string): string {
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
    return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
}

/**
 * A small in-process stand-in for ioredis's `Redis` client, implementing
 * just the RedisLike surface redis-cache.ts calls — enough to unit-test
 * RedisCache's generation/invalidation-failure behavior deterministically,
 * without a live Redis server. Not a general-purpose Redis emulator (no
 * pattern edge cases beyond the literal `*` wildcard this codebase's own
 * SCAN calls use, no expiry sweep — entries just check their own
 * expiresAt lazily on access, same as ttl-cache.ts).
 *
 * `failNextIncr`/`failNextGet`/`failNextSet` — each consumed by exactly one
 * call, then reset to false — let tests simulate a single transient Redis
 * failure (e.g. mid-outage) without needing a real network fault.
 */
export class FakeRedis implements RedisLike {
    private readonly store = new Map<string, Entry>();
    failNextIncr = false;
    failNextGet = false;
    failNextSet = false;

    private isLive(entry: Entry | undefined): entry is Entry {
        if (!entry) return false;
        if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) return false;
        return true;
    }

    async get(key: string): Promise<string | null> {
        if (this.failNextGet) {
            this.failNextGet = false;
            throw new Error("simulated Redis GET failure");
        }
        const entry = this.store.get(key);
        if (!this.isLive(entry)) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    async set(key: string, value: string, mode: "PX", ttlMs: number): Promise<"OK"> {
        if (this.failNextSet) {
            this.failNextSet = false;
            throw new Error("simulated Redis SET failure");
        }
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        return "OK";
    }

    async incr(key: string): Promise<number> {
        if (this.failNextIncr) {
            this.failNextIncr = false;
            throw new Error("simulated Redis INCR failure");
        }
        const entry = this.store.get(key);
        const current = this.isLive(entry) ? Number(entry.value) : 0;
        const next = current + 1;
        this.store.set(key, { value: String(next) });
        return next;
    }

    async del(...keys: string[]): Promise<number> {
        let count = 0;
        for (const key of keys) if (this.store.delete(key)) count++;
        return count;
    }

    async scan(_cursor: string, _matchToken: "MATCH", pattern: string, _countToken: "COUNT", _count: number): Promise<[string, string[]]> {
        const regex = globToRegExp(pattern);
        const keys = [...this.store.keys()].filter((k) => this.isLive(this.store.get(k)) && regex.test(k));
        return ["0", keys]; // single-pass: always reports scan complete
    }
}
