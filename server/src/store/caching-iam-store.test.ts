import { describe, expect, it, vi } from "vitest";
import type { CacheFactory } from "../cache/cache.js";
import { MemoryCache } from "../cache/memory-cache.js";
import type { AuditActor } from "./audit-store.js";
import { CachingIamStore } from "./caching-iam-store.js";
import { InMemoryIamStore } from "./in-memory-iam-store.js";

// A fresh in-memory cache factory per test — same backend index.ts falls
// back to when REDIS_URL is unset, so these tests exercise real caching
// behavior without needing a Redis instance. Honors a per-namespace ttlMs
// override (namespaceOptions), matching create-cache.ts's real factory —
// needed so tests can actually observe findUserByExternalSubject's
// shorter negative-cache TTL taking effect, distinct from every other
// namespace's default.
const testCacheFactory: CacheFactory = <V>(_namespace: string, namespaceOptions?: { ttlMs?: number }) => new MemoryCache<V>(namespaceOptions?.ttlMs ?? 60_000);

// Every mutation now requires an AuditActor (see iam-store.ts's doc
// comment) — none of these tests are about auditing itself, so one shared
// dummy actor covers every call site here.
const ACTOR: AuditActor = { externalSubject: "idp|test-actor" };

async function seed(inner: InMemoryIamStore) {
    const org = await inner.createOrganization("Acme", ACTOR);
    const policy = await inner.createPolicy(
        {
            organizationId: org.id,
            name: "read-only",
            document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["cases:read"], resources: ["*"] }] },
        },
        ACTOR
    );
    const group = await inner.createGroup({ organizationId: org.id, name: "clinicians", policyIds: [policy.id] }, ACTOR);
    const user = await inner.createUser(
        {
            organizationId: org.id,
            externalSubject: "sub-1",
            displayName: "Dr. Test",
            groupIds: [group.id],
        },
        ACTOR
    );
    return { org, policy, group, user };
}

describe("CachingIamStore", () => {
    it("serves a second identical read from cache instead of the inner store", async () => {
        const inner = new InMemoryIamStore();
        const { user } = await seed(inner);
        const spy = vi.spyOn(inner, "getUser");
        const cached = new CachingIamStore(inner, testCacheFactory);

        await cached.getUser(user.id);
        await cached.getUser(user.id);

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("caches resolveEffectivePolicies — the hot /authz/check path", async () => {
        const inner = new InMemoryIamStore();
        const { user, policy } = await seed(inner);
        const spy = vi.spyOn(inner, "resolveEffectivePolicies");
        const cached = new CachingIamStore(inner, testCacheFactory);

        const first = await cached.resolveEffectivePolicies(user.id);
        const second = await cached.resolveEffectivePolicies(user.id);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(first.map((p) => p.id)).toEqual([policy.id]);
        expect(second.map((p) => p.id)).toEqual([policy.id]);
    });

    it("caches findUserByExternalSubject, the other hot per-request lookup", async () => {
        const inner = new InMemoryIamStore();
        const { org, user } = await seed(inner);
        const spy = vi.spyOn(inner, "findUserByExternalSubject");
        const cached = new CachingIamStore(inner, testCacheFactory);

        await cached.findUserByExternalSubject(org.id, user.externalSubject);
        await cached.findUserByExternalSubject(org.id, user.externalSubject);

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("invalidates a user's cached entry (and effective policies) on update", async () => {
        const inner = new InMemoryIamStore();
        const { user } = await seed(inner);
        const cached = new CachingIamStore(inner, testCacheFactory);

        await cached.getUser(user.id);
        await cached.resolveEffectivePolicies(user.id);
        await cached.updateUser(user.id, { status: "suspended" }, ACTOR);

        const refreshed = await cached.getUser(user.id);
        expect(refreshed?.status).toBe("suspended");
    });

    it("invalidates findUserByExternalSubject after the user it resolved to is updated", async () => {
        const inner = new InMemoryIamStore();
        const { org, user } = await seed(inner);
        const cached = new CachingIamStore(inner, testCacheFactory);

        await cached.findUserByExternalSubject(org.id, user.externalSubject);
        await cached.updateUser(user.id, { displayName: "Dr. Renamed" }, ACTOR);

        const refreshed = await cached.findUserByExternalSubject(org.id, user.externalSubject);
        expect(refreshed?.displayName).toBe("Dr. Renamed");
    });

    describe("negative caching (findUserByExternalSubject)", () => {
        it("caches a 'no such user' result too, unlike every other id lookup", async () => {
            const inner = new InMemoryIamStore();
            const { org } = await seed(inner);
            const spy = vi.spyOn(inner, "findUserByExternalSubject");
            const cached = new CachingIamStore(inner, testCacheFactory);

            const first = await cached.findUserByExternalSubject(org.id, "no-such-subject");
            const second = await cached.findUserByExternalSubject(org.id, "no-such-subject");

            expect(first).toBeNull();
            expect(second).toBeNull();
            expect(spy).toHaveBeenCalledTimes(1); // the second call hit the negative cache, not the store
        });

        it("createUser invalidates a cached negative result — a new account is visible immediately, not after the negative TTL", async () => {
            const inner = new InMemoryIamStore();
            const org = await inner.createOrganization("Acme", ACTOR);
            const cached = new CachingIamStore(inner, testCacheFactory);

            const before = await cached.findUserByExternalSubject(org.id, "sub-new");
            expect(before).toBeNull(); // cached negatively

            const created = await cached.createUser({ organizationId: org.id, externalSubject: "sub-new", displayName: "New User" }, ACTOR);

            const after = await cached.findUserByExternalSubject(org.id, "sub-new");
            expect(after?.id).toBe(created.id); // not the stale negative result
        });

        it("uses a shorter TTL for a negative result than for a found user", async () => {
            vi.useFakeTimers();
            try {
                const inner = new InMemoryIamStore();
                const { org, user } = await seed(inner);
                const spy = vi.spyOn(inner, "findUserByExternalSubject");
                // testCacheFactory's default is 60s; a 100ms negative TTL is
                // unambiguously "much shorter."
                const cached = new CachingIamStore(inner, testCacheFactory, { negativeCacheTtlMs: 100 });

                await cached.findUserByExternalSubject(org.id, "no-such-subject"); // negative, cached
                await cached.findUserByExternalSubject(org.id, user.externalSubject); // positive, cached

                vi.advanceTimersByTime(101); // past the negative TTL, nowhere near the 60s positive TTL

                await cached.findUserByExternalSubject(org.id, "no-such-subject"); // re-fetched: negative TTL expired
                await cached.findUserByExternalSubject(org.id, user.externalSubject); // still cached: positive TTL alive

                expect(spy).toHaveBeenCalledTimes(3); // 1 (negative) + 1 (positive) + 1 (negative re-fetch); not 4
            } finally {
                vi.useRealTimers();
            }
        });

        it("defaults to a 5-second negative TTL when no override is given in the constructor", async () => {
            vi.useFakeTimers();
            try {
                const inner = new InMemoryIamStore();
                const { org } = await seed(inner);
                const spy = vi.spyOn(inner, "findUserByExternalSubject");
                const cached = new CachingIamStore(inner, testCacheFactory); // no negativeCacheTtlMs override

                await cached.findUserByExternalSubject(org.id, "no-such-subject");
                vi.advanceTimersByTime(4_999);
                await cached.findUserByExternalSubject(org.id, "no-such-subject");
                expect(spy).toHaveBeenCalledTimes(1); // still within the 5s default

                vi.advanceTimersByTime(2);
                await cached.findUserByExternalSubject(org.id, "no-such-subject");
                expect(spy).toHaveBeenCalledTimes(2); // now past it
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("subjectKey collision resistance", () => {
        it("does not conflate two (organizationId, externalSubject) pairs that would collide under a naive separator-joined key", async () => {
            const inner = new InMemoryIamStore();
            const cached = new CachingIamStore(inner, testCacheFactory);

            // Under the old `${organizationId} ${externalSubject}` scheme,
            // both pairs below join to the identical string "org-a b c" —
            // a real cross-tenant cache collision, not just a hypothetical
            // one.
            const orgA = await inner.createOrganization("org-a", ACTOR);
            const orgAB = await inner.createOrganization("org-a b", ACTOR); // note the embedded space
            const userInA = await inner.createUser({ organizationId: orgA.id, externalSubject: "b c", displayName: "User In A" }, ACTOR);
            const userInAB = await inner.createUser({ organizationId: orgAB.id, externalSubject: "c", displayName: "User In A B" }, ACTOR);

            const foundInA = await cached.findUserByExternalSubject(orgA.id, "b c");
            const foundInAB = await cached.findUserByExternalSubject(orgAB.id, "c");

            expect(foundInA?.id).toBe(userInA.id);
            expect(foundInAB?.id).toBe(userInAB.id);
            // The second lookup must not have returned the first
            // organization's cached user (or vice versa).
            expect(foundInA?.id).not.toBe(foundInAB?.id);
        });
    });

    it("clears every cached effective-policy result when a policy changes", async () => {
        const inner = new InMemoryIamStore();
        const { user, policy } = await seed(inner);
        const cached = new CachingIamStore(inner, testCacheFactory);

        const before = await cached.resolveEffectivePolicies(user.id);
        expect(before.some((p) => p.name === "read-only")).toBe(true);

        await cached.updatePolicy(policy.id, { name: "read-only-renamed" }, ACTOR);

        const after = await cached.resolveEffectivePolicies(user.id);
        expect(after.some((p) => p.name === "read-only-renamed")).toBe(true);
    });

    it("clears every cached effective-policy result when a group's policies change", async () => {
        const inner = new InMemoryIamStore();
        const { user, group } = await seed(inner);
        const cached = new CachingIamStore(inner, testCacheFactory);

        await cached.resolveEffectivePolicies(user.id); // warm the cache
        await cached.updateGroup(group.id, { policyIds: [] }, ACTOR);

        const after = await cached.resolveEffectivePolicies(user.id);
        expect(after).toEqual([]);
    });

    it("invalidates the org's user list on create", async () => {
        const inner = new InMemoryIamStore();
        const { org } = await seed(inner);
        const cached = new CachingIamStore(inner, testCacheFactory);

        const before = await cached.listUsersByOrganization(org.id);
        expect(before).toHaveLength(1);

        await cached.createUser({ organizationId: org.id, externalSubject: "sub-2", displayName: "Second User" }, ACTOR);

        const after = await cached.listUsersByOrganization(org.id);
        expect(after).toHaveLength(2);
    });

    it("reflects a policy deletion after cache invalidation", async () => {
        const inner = new InMemoryIamStore();
        const org = await inner.createOrganization("Acme", ACTOR);
        const policy = await inner.createPolicy(
            {
                organizationId: org.id,
                name: "deletable",
                document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["cases:read"], resources: ["*"] }] },
            },
            ACTOR
        );
        const cached = new CachingIamStore(inner, testCacheFactory);

        await cached.getPolicy(policy.id); // warm the cache
        const deleted = await cached.deletePolicy(policy.id, ACTOR);
        expect(deleted).toBe(true);

        expect(await cached.getPolicy(policy.id)).toBeNull();
        expect(await cached.listPoliciesByOrganization(org.id)).toEqual([]);
    });

    it("reports per-sub-cache hit/miss/size stats", async () => {
        const inner = new InMemoryIamStore();
        const { user } = await seed(inner);
        const cached = new CachingIamStore(inner, testCacheFactory);

        await cached.getUser(user.id);
        await cached.getUser(user.id);

        const stats = await cached.stats();
        expect(stats.users).toEqual({
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

    describe("concurrent invalidation during an in-flight resolveEffectivePolicies() load", () => {
        // Makes inner.resolveEffectivePolicies() pause mid-flight (as if a
        // real Postgres round trip were slow) until the test releases it,
        // signaling via `started` the moment it's actually been called —
        // so the test can deterministically run a mutation *while* the read
        // is suspended, regardless of how many microtask hops
        // CachingIamStore/Cache take to reach the call.
        //
        // Reads the store *before* awaiting the gate, not after — a real
        // slow query still executes against a fixed snapshot of the data as
        // of when it started (the store's own MVCC snapshot; here,
        // InMemoryIamStore's resolveEffectivePolicies is synchronous
        // under its `async` signature — see its own doc comment — so
        // calling it captures that snapshot immediately). Awaiting the
        // gate only delays *returning* that already-captured result,
        // exactly matching "the query was in flight when the mutation
        // committed, and its result reflects data from before the
        // mutation."
        function delayResolveEffectivePolicies(inner: InMemoryIamStore): { started: Promise<void>; release: () => void } {
            const original = inner.resolveEffectivePolicies.bind(inner);
            let markStarted!: () => void;
            const started = new Promise<void>((res) => {
                markStarted = res;
            });
            let release!: () => void;
            const gate = new Promise<void>((res) => {
                release = res;
            });
            vi.spyOn(inner, "resolveEffectivePolicies").mockImplementation(async (userId: string) => {
                const snapshot = await original(userId);
                markStarted();
                await gate;
                return snapshot;
            });
            return { started, release };
        }

        it("a policy revocation (namespace-wide clear) is not overwritten by an in-flight request's stale read", async () => {
            const inner = new InMemoryIamStore();
            const { user, policy } = await seed(inner);
            const cached = new CachingIamStore(inner, testCacheFactory);
            const { started, release } = delayResolveEffectivePolicies(inner);

            // Request A: starts reading effective policies (capturing the
            // cache generation as it was before the revocation below) but
            // is suspended mid-load.
            const requestA = cached.resolveEffectivePolicies(user.id);
            await started;

            // Request B: revokes the policy (Deny-all) and completes first,
            // while A is still in flight. updatePolicy() calls
            // effectivePolicies.clear() — the namespace-wide invalidation
            // path.
            await cached.updatePolicy(
                policy.id,
                { document: { version: "2026-01-01", statements: [{ effect: "Deny", actions: ["*"], resources: ["*"] }] } },
                ACTOR
            );

            // Let A's stale (pre-revocation) read finish and attempt to
            // cache its result.
            release();
            const staleSeenByA = await requestA;
            expect(staleSeenByA.find((p) => p.id === policy.id)?.document.statements[0]?.effect).toBe("Allow");

            // The race under test: a later read must see the revocation,
            // not whatever A tried to write back to the cache.
            const after = await cached.resolveEffectivePolicies(user.id);
            expect(after.find((p) => p.id === policy.id)?.document.statements[0]?.effect).toBe("Deny");
        });

        it("a user's group membership being revoked (per-key delete) is not overwritten by an in-flight request's stale read", async () => {
            const inner = new InMemoryIamStore();
            const { user } = await seed(inner);
            const cached = new CachingIamStore(inner, testCacheFactory);
            const { started, release } = delayResolveEffectivePolicies(inner);

            const requestA = cached.resolveEffectivePolicies(user.id);
            await started;

            // updateUser() calls effectivePolicies.delete(user.id) — the
            // per-key invalidation path.
            await cached.updateUser(user.id, { groupIds: [] }, ACTOR);

            release();
            const staleSeenByA = await requestA;
            expect(staleSeenByA.length).toBeGreaterThan(0); // A's stale read still had the group's policy

            const after = await cached.resolveEffectivePolicies(user.id);
            expect(after).toEqual([]); // must reflect the revocation, not A's stale write
        });
    });

    describe("durable authorization epoch (surviving a Redis data rollback — see class doc comment)", () => {
        it("a normal repeated read is still served from cache, without recomputing, when nothing has changed", async () => {
            const inner = new InMemoryIamStore();
            const { user } = await seed(inner);
            const cached = new CachingIamStore(inner, testCacheFactory);
            const spy = vi.spyOn(inner, "resolveEffectivePolicies");

            await cached.resolveEffectivePolicies(user.id);
            await cached.resolveEffectivePolicies(user.id);
            expect(spy).toHaveBeenCalledTimes(1); // second read was a cache hit, epoch matched
        });

        it("a stale cached entry — simulating a Redis restore-from-backup that undid a mutation's own cache clear() — is detected and recomputed, not served", async () => {
            vi.useFakeTimers();
            try {
                const inner = new InMemoryIamStore();
                const { policy, group, user } = await seed(inner);
                const cached = new CachingIamStore(inner, testCacheFactory);

                // Warm cached's effectivePolicies entry for this user at
                // epoch 1 — this also warms cached's own short-TTL
                // in-process epoch cache at 1.
                const before = await cached.resolveEffectivePolicies(user.id);
                expect(before.map((p) => p.id)).toEqual([policy.id]);

                // Revoke the policy directly through `inner`, bypassing
                // `cached` entirely — the worst case a Redis restore-from-
                // backup can produce: the durable store has moved on
                // (epoch bumped, policy detached from the group) but the
                // cache layer's own clear() either never ran against this
                // snapshot or was undone by the restore, so `cached`'s
                // effectivePolicies entry for this user is untouched,
                // still sitting there tagged epoch: 1.
                await inner.updateGroup(group.id, { policyIds: [] }, ACTOR);
                expect(await inner.getAuthorizationEpoch((await inner.getGroup(group.id))!.organizationId)).toBe(2);

                // Some real time passing before the next request is the
                // realistic case (an operator's restore and a clinician's
                // next click are never truly simultaneous) — advance past
                // the epoch cache's own short TTL so its bounded staleness
                // window (documented on EPOCH_CACHE_TTL_MS) has elapsed,
                // rather than asserting an instantaneity this design never
                // promised.
                vi.advanceTimersByTime(2_001);

                const after = await cached.resolveEffectivePolicies(user.id);
                expect(after).toEqual([]); // revocation honored despite the untouched stale cache entry
            } finally {
                vi.useRealTimers();
            }
        });

        it.each([
            [
                "updatePolicy",
                async (inner: InMemoryIamStore, ids: { policyId: string }) => inner.updatePolicy(ids.policyId, { name: "renamed" }, ACTOR),
            ],
            ["deletePolicy", async (inner: InMemoryIamStore, ids: { policyId: string }) => inner.deletePolicy(ids.policyId, ACTOR)],
        ])("%s bumps the organization's authorization epoch", async (_name, mutate) => {
            const inner = new InMemoryIamStore();
            const { org, policy } = await seed(inner);
            expect(await inner.getAuthorizationEpoch(org.id)).toBe(1);
            await mutate(inner, { policyId: policy.id });
            expect(await inner.getAuthorizationEpoch(org.id)).toBe(2);
        });

        it("updateGroup bumps the organization's authorization epoch", async () => {
            const inner = new InMemoryIamStore();
            const { org, group } = await seed(inner);
            expect(await inner.getAuthorizationEpoch(org.id)).toBe(1);
            await inner.updateGroup(group.id, { name: "renamed" }, ACTOR);
            expect(await inner.getAuthorizationEpoch(org.id)).toBe(2);
        });

        it("updateUser does NOT bump the organization's authorization epoch (its own per-key delete already handles it)", async () => {
            const inner = new InMemoryIamStore();
            const { org, user } = await seed(inner);
            await inner.updateUser(user.id, { groupIds: [] }, ACTOR);
            expect(await inner.getAuthorizationEpoch(org.id)).toBe(1);
        });

        it("an organization that has never had a group/policy mutation reports epoch 1", async () => {
            const inner = new InMemoryIamStore();
            const org = await inner.createOrganization("Fresh Org", ACTOR);
            expect(await inner.getAuthorizationEpoch(org.id)).toBe(1);
        });
    });
});
