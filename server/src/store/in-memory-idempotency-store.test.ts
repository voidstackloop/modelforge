import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryIdempotencyStore } from "./in-memory-idempotency-store.js";

// Basic get/put/scoping behavior is already exercised end-to-end through
// app.test.ts's "Idempotency-Key" describe block (via routes/cases.ts). This
// file covers what that HTTP-level coverage can't: the time-dependent TTL
// expiry, which needs control over the clock.
describe("InMemoryIdempotencyStore", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("returns null for a key that was never put", async () => {
        const store = new InMemoryIdempotencyStore();
        expect(await store.get("org-1", "missing")).toBeNull();
    });

    it("returns a put record verbatim before its TTL elapses", async () => {
        const store = new InMemoryIdempotencyStore();
        await store.put("org-1", "key-1", { requestHash: "h1", statusCode: 201, responseBody: { id: "case-1" } });

        vi.advanceTimersByTime(60_000); // well within the 24h horizon
        expect(await store.get("org-1", "key-1")).toEqual({ requestHash: "h1", statusCode: 201, responseBody: { id: "case-1" } });
    });

    it("treats a record older than 24h as absent", async () => {
        const store = new InMemoryIdempotencyStore();
        await store.put("org-1", "key-1", { requestHash: "h1", statusCode: 201, responseBody: {} });

        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
        expect(await store.get("org-1", "key-1")).toBeNull();
    });

    it("scopes keys by organization — the same key in a different org is a separate record", async () => {
        const store = new InMemoryIdempotencyStore();
        await store.put("org-1", "shared-key", { requestHash: "h1", statusCode: 201, responseBody: { org: 1 } });
        await store.put("org-2", "shared-key", { requestHash: "h1", statusCode: 201, responseBody: { org: 2 } });

        expect(await store.get("org-1", "shared-key")).toMatchObject({ responseBody: { org: 1 } });
        expect(await store.get("org-2", "shared-key")).toMatchObject({ responseBody: { org: 2 } });
    });

    it("put overwrites an existing key's record (create-or-replace, not merge)", async () => {
        const store = new InMemoryIdempotencyStore();
        await store.put("org-1", "key-1", { requestHash: "h1", statusCode: 201, responseBody: { v: 1 } });
        await store.put("org-1", "key-1", { requestHash: "h2", statusCode: 200, responseBody: { v: 2 } });

        expect(await store.get("org-1", "key-1")).toEqual({ requestHash: "h2", statusCode: 200, responseBody: { v: 2 } });
    });
});
