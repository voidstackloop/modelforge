import type { Cache, CacheFactory, CacheStats } from "../cache/cache.js";
import { MemoryCache } from "../cache/memory-cache.js";
import type { Group, Organization, Policy, PolicyDocument, User } from "../domain/types.js";
import type { AuditActor } from "./audit-store.js";
import type { IamStore } from "./iam-store.js";
import { bindTenantIamStore, type TenantContext, type TenantIamRepository } from "../tenant-context.js";

/** Default TTL for findUserByExternalSubject's negative-cache entries when
 * CachingIamStoreOptions.negativeCacheTtlMs isn't given — see
 * findUserByExternalSubject's doc comment. Kept well under any plausible
 * CACHE_TTL_MS (config.ts's own validation floor is 1000ms) so the default
 * is never accidentally the *longer* of the two. */
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5_000;

/** How long a fetched authorization epoch (see IamStore.getAuthorizationEpoch)
 * is trusted before this class re-fetches it from `inner` — see
 * resolveEffectivePolicies's doc comment for what this bounds: the maximum
 * time a permission revocation could still appear cached even in the worst
 * case (a Redis restore-from-backup immediately after the revoking
 * mutation). 2s is short enough that this window is a non-issue
 * operationally, while still keeping the common case (repeated authz
 * checks against an unchanged organization) from hitting the epoch's
 * backing store on every single request. */
const EPOCH_CACHE_TTL_MS = 2_000;

/**
 * Composes an (organizationId, externalSubject) pair into one cache key.
 * JSON-encoded, not just joined with a separator (` `, `:`, ...) — an
 * OIDC `sub` claim is opaque, IdP-controlled text with no format this
 * service constrains (see domain/types.ts's User.externalSubject), so it
 * could in principle contain any character, including whatever separator
 * a naive join picked. A separator-based key can collide: organizationId
 * "a" + subject "b c" and organizationId "a b" + subject "c" both join to
 * "a b c" under a space separator, which would let one org's cached
 * lookup answer another org's — a cross-tenant authorization bug, not
 * just a cache inefficiency. JSON.stringify's string escaping is
 * unambiguous for arbitrary content, so two distinct pairs can never
 * produce the same key.
 */
function subjectKey(organizationId: string, externalSubject: string): string {
    return JSON.stringify([organizationId, externalSubject]);
}

/** Shared by every `T | null` "look up by id" cache below (getUser,
 * getOrganization, getGroup, getPolicy), so a miss is never cached — see
 * cache.ts's getOrLoad() doc comment for why that matters, and
 * findUserByExternalSubject's doc comment for the one lookup that
 * deliberately does cache its miss.
 *
 * Not applied to entity-by-id lookups because their ids are server-
 * generated `randomUUID()` values (in-memory-iam-store.ts,
 * postgres-iam-store.ts) that a legitimate caller only ever has *after*
 * the entity exists — a "not found" there is either a bug, a stale
 * reference to something since deleted, or an attacker guessing at
 * random, none of which benefit from caching (the first two are rare
 * one-offs; the third has a namespace far too large to matter). */
function notNull<T>(value: T | null): boolean {
    return value !== null;
}

/**
 * Read-through/write-invalidating cache decorator over any IamStore —
 * same swappable-seam shape as this module's own callers expect (an
 * IamStore is an IamStore), so index.ts can wrap either InMemoryIamStore or
 * PostgresIamStore with this without either implementation, or any route
 * handler, knowing caching happened at all. See server/README.md's
 * "Persistence" section for why both concrete stores exist; this class
 * doesn't care which one it's wrapping — and doesn't care whether
 * `cacheFactory` (see ../cache/create-cache.ts) hands it in-memory or
 * Redis-backed caches either.
 *
 * What's cached and why: every read method IamStore exposes, because every
 * one of them is called at least once per authenticated request
 * (requireOrgUser → findUserByExternalSubject; requirePermission /
 * /authz/check → resolveEffectivePolicies) and the Postgres implementation
 * turns each of those into a real round trip. Mutations invalidate
 * precisely where an id is known (a user/group/policy update invalidates
 * that entity plus the list it belongs to); resolveEffectivePolicies —
 * which depends on a user's own policies *and* every group it belongs to's
 * policies, with no reverse index from group/policy back to affected users
 * — is invalidated per-user on a user update, but wholesale (clear()) on
 * any group or policy mutation, since under-invalidating there would leak
 * a stale Allow/Deny decision rather than just cost an extra query. Group
 * and policy writes are rare admin operations; /authz/check is not, so this
 * trade favors the hot path.
 *
 * Every read below goes through Cache<V>.getOrLoad() rather than a
 * get()-then-set() pair — see cache.ts's doc comment for the
 * read/invalidate race that shape used to allow, and each Cache
 * implementation's own doc comment for how getOrLoad() closes it. The
 * "before" record a few mutations below need (to know which cached list
 * entries to invalidate) is always fetched from `inner` directly, never
 * from cache — these are rare admin writes, not the hot path, so the extra
 * store round trip is cheap, and it sidesteps needing a cache-peek API
 * that getOrLoad()'s race-closing design deliberately doesn't expose.
 *
 * ## Negative caching
 *
 * Every `T | null` lookup here caches a hit but not a miss (`notNull`,
 * above) — with one deliberate exception: findUserByExternalSubject, whose
 * miss ("authenticated identity, no account in this organization") is a
 * request pattern that genuinely repeats, not a one-off, since
 * requireOrgUser (routes/guards.ts) calls it on *every* request to an
 * org-scoped route, including from an outsider who never gets an account.
 * That miss is cached too, but at a much shorter TTL — see that method's
 * own doc comment for why this is safe under the same "must never extend
 * revoked access" constraint as everything else here, and why it doesn't
 * need any new invalidation wiring beyond what createUser/updateUser
 * already do.
 *
 * ## Durable authorization epochs (surviving a Redis data rollback)
 *
 * Every cache above is invalidated by an explicit `.delete()`/`.clear()`
 * call at the point of mutation — correct as long as whatever backs the
 * cache actually keeps that invalidation. It doesn't if the backing store
 * is Redis and an operator restores it from a backup taken *before* the
 * revoking mutation: the restore silently undoes the clear() along with
 * everything else, and the stale "Allow" would be served again under its
 * original key, same key as always. `resolveEffectivePolicies` (the actual
 * authorization decision, not just an entity lookup) closes this specific
 * gap without touching that key or any existing `.delete()`/`.clear()`
 * call (in particular, updateUser's existing per-key `effectivePolicies
 * .delete(id)` keeps working exactly as it always has): the cached *value*
 * is tagged with the epoch it was computed under
 * (`{ epoch, policies }`, not a bare `Policy[]`), and every read compares
 * that tag against `inner.getAuthorizationEpoch()` — served through this
 * class's own short-TTL, *always in-process, never Redis-backed*
 * `authorizationEpochs` cache, so the comparison target itself can't be
 * rolled back along with Redis. A rolled-back Redis entry's `epoch` reads
 * as older than the (Postgres-sourced, unaffected by a Redis-only restore)
 * current epoch, so it's treated as a miss and recomputed — see
 * `IamStore.getAuthorizationEpoch`'s doc comment for where the epoch
 * itself is bumped.
 */
export class CachingIamStore implements IamStore {
    bindTenant(context: TenantContext): TenantIamRepository {
        // Tenant/RLS correctness takes priority over caching. The bound
        // repository delegates to the inner store's checked-out connection;
        // ordinary discovery/bootstrap calls still use this cache layer.
        return bindTenantIamStore(this.inner, context);
    }
    private readonly organizations: Cache<Organization | null>;
    private readonly users: Cache<User | null>;
    private readonly userBySubject: Cache<User | null>;
    private readonly usersByOrg: Cache<User[]>;
    private readonly usersBySubject: Cache<User[]>;
    private readonly groups: Cache<Group | null>;
    private readonly groupsByOrg: Cache<Group[]>;
    private readonly policies: Cache<Policy | null>;
    private readonly policiesByOrg: Cache<Policy[]>;
    /** Value is tagged with the epoch it was computed under, not a bare
     * Policy[] — see class doc comment's "Durable authorization epochs"
     * section. The cache *key* is still plain `userId`, unchanged from
     * before that mechanism existed, so every existing invalidation call
     * site (updateUser's per-key delete, updateGroup/updatePolicy/
     * deletePolicy's wholesale clear) keeps working unmodified. */
    private readonly effectivePolicies: Cache<{ epoch: number; policies: Policy[] }>;
    private readonly negativeCacheTtlMs: number;
    /** Deliberately NOT built via `cacheFactory` — see class doc comment's
     * "Durable authorization epochs" section for why this one cache must
     * never be Redis-backed regardless of what the rest of this class uses. */
    private readonly authorizationEpochs = new MemoryCache<number>(EPOCH_CACHE_TTL_MS);

    constructor(
        private readonly inner: IamStore,
        cacheFactory: CacheFactory,
        options: { negativeCacheTtlMs?: number } = {}
    ) {
        this.negativeCacheTtlMs = options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
        this.organizations = cacheFactory<Organization | null>("organizations");
        this.users = cacheFactory<User | null>("users");
        this.userBySubject = cacheFactory<User | null>("userBySubject");
        this.usersByOrg = cacheFactory<User[]>("usersByOrg");
        this.usersBySubject = cacheFactory<User[]>("usersBySubject");
        this.groups = cacheFactory<Group | null>("groups");
        this.groupsByOrg = cacheFactory<Group[]>("groupsByOrg");
        this.policies = cacheFactory<Policy | null>("policies");
        this.policiesByOrg = cacheFactory<Policy[]>("policiesByOrg");
        this.effectivePolicies = cacheFactory<{ epoch: number; policies: Policy[] }>("effectivePolicies");
    }

    async createOrganization(name: string, actor: AuditActor): Promise<Organization> {
        return this.inner.createOrganization(name, actor);
    }

    async getOrganization(id: string): Promise<Organization | null> {
        return this.organizations.getOrLoad(id, () => this.inner.getOrganization(id), notNull);
    }

    /** A rare compensating-cleanup path (see IamStore.deleteOrganization's
     * doc comment), not a normal user-facing operation — invalidated the
     * same way any other org-wide-impact mutation here is: the one cached
     * organization entry, this org's own list caches, and effectivePolicies
     * wholesale (no reverse index from org to affected users, same reason
     * updateGroup/updatePolicy already clear it wholesale too). */
    async deleteOrganization(id: string): Promise<void> {
        await this.inner.deleteOrganization(id);
        await Promise.all([
            this.organizations.delete(id),
            this.usersByOrg.delete(id),
            this.groupsByOrg.delete(id),
            this.policiesByOrg.delete(id),
            this.effectivePolicies.clear(),
        ]);
    }

    async createUser(
        input: {
            organizationId: string;
            externalSubject: string;
            displayName: string;
            email?: string;
            groupIds?: string[];
            policyIds?: string[];
            permissionBoundaryPolicyId?: string;
        },
        actor: AuditActor
    ): Promise<User> {
        const user = await this.inner.createUser(input, actor);
        await Promise.all([
            this.usersByOrg.delete(user.organizationId),
            this.usersBySubject.delete(user.externalSubject),
            this.userBySubject.delete(subjectKey(user.organizationId, user.externalSubject)),
        ]);
        return user;
    }

    async getUser(id: string): Promise<User | null> {
        return this.users.getOrLoad(id, () => this.inner.getUser(id), notNull);
    }

    /**
     * The one negative-cached lookup in this class — see class doc
     * comment's "Negative caching" section for the request pattern that
     * justifies it. `shouldCache` is `() => true` here (not `notNull`):
     * both a found user and a "no such user" both get cached, but
     * `ttlMsForValue` gives the null case a much shorter TTL
     * (`negativeCacheTtlMs`, default 5s vs. the normal cache's full
     * CACHE_TTL_MS, typically 30s+) — bounding how long a since-created
     * account could stay masked by a negative entry to a small window,
     * on top of (not instead of) the invalidation guarantee below.
     *
     * Safety: this reuses the exact same cache and key `createUser` and
     * `updateUser` already call `.delete(subjectKey(...))` on — a negative
     * entry is just a value stored at that key, invalidated by the same
     * per-key generation bump as a positive one, through the same
     * generation-tagged-write mechanism that makes every other cache in
     * this class safe under a concurrent invalidation (see
     * redis-cache.ts/memory-cache.ts's doc comments). No new invalidation
     * path was added or is needed.
     */
    async findUserByExternalSubject(organizationId: string, externalSubject: string): Promise<User | null> {
        const key = subjectKey(organizationId, externalSubject);
        return this.userBySubject.getOrLoad(
            key,
            () => this.inner.findUserByExternalSubject(organizationId, externalSubject),
            () => true,
            (user) => (user === null ? this.negativeCacheTtlMs : undefined)
        );
    }

    async listUsersByExternalSubject(externalSubject: string): Promise<User[]> {
        return this.usersBySubject.getOrLoad(externalSubject, () => this.inner.listUsersByExternalSubject(externalSubject));
    }

    async listUsersByOrganization(organizationId: string): Promise<User[]> {
        return this.usersByOrg.getOrLoad(organizationId, () => this.inner.listUsersByOrganization(organizationId));
    }

    async updateUser(
        id: string,
        partial: Partial<Pick<User, "displayName" | "email" | "status" | "groupIds" | "policyIds" | "permissionBoundaryPolicyId">>,
        actor: AuditActor
    ): Promise<User | null> {
        const before = await this.inner.getUser(id);
        const updated = await this.inner.updateUser(id, partial, actor);
        await this.users.delete(id);
        await this.effectivePolicies.delete(id);
        for (const user of [before, updated]) {
            if (!user) continue;
            await Promise.all([
                this.usersByOrg.delete(user.organizationId),
                this.usersBySubject.delete(user.externalSubject),
                this.userBySubject.delete(subjectKey(user.organizationId, user.externalSubject)),
            ]);
        }
        return updated;
    }

    async createGroup(input: { organizationId: string; name: string; policyIds?: string[] }, actor: AuditActor): Promise<Group> {
        const group = await this.inner.createGroup(input, actor);
        await this.groupsByOrg.delete(group.organizationId);
        return group;
    }

    async getGroup(id: string): Promise<Group | null> {
        return this.groups.getOrLoad(id, () => this.inner.getGroup(id), notNull);
    }

    async listGroupsByOrganization(organizationId: string): Promise<Group[]> {
        return this.groupsByOrg.getOrLoad(organizationId, () => this.inner.listGroupsByOrganization(organizationId));
    }

    async updateGroup(id: string, partial: Partial<Pick<Group, "name" | "policyIds">>, actor: AuditActor): Promise<Group | null> {
        const before = await this.inner.getGroup(id);
        const updated = await this.inner.updateGroup(id, partial, actor);
        await this.groups.delete(id);
        for (const group of [before, updated]) {
            if (group) await this.groupsByOrg.delete(group.organizationId);
        }
        // Group membership/policy changes can shift effective policies for
        // every member, and there's no reverse index from group -> users —
        // see class doc comment.
        await this.effectivePolicies.clear();
        return updated;
    }

    async createPolicy(
        input: {
            organizationId: string;
            name: string;
            description?: string;
            document: PolicyDocument;
            builtin?: boolean;
        },
        actor: AuditActor
    ): Promise<Policy> {
        const policy = await this.inner.createPolicy(input, actor);
        await this.policiesByOrg.delete(policy.organizationId);
        return policy;
    }

    async getPolicy(id: string): Promise<Policy | null> {
        return this.policies.getOrLoad(id, () => this.inner.getPolicy(id), notNull);
    }

    async listPoliciesByOrganization(organizationId: string): Promise<Policy[]> {
        return this.policiesByOrg.getOrLoad(organizationId, () => this.inner.listPoliciesByOrganization(organizationId));
    }

    async updatePolicy(
        id: string,
        partial: Partial<Pick<Policy, "name" | "description" | "document">>,
        actor: AuditActor
    ): Promise<Policy | null> {
        const before = await this.inner.getPolicy(id);
        const updated = await this.inner.updatePolicy(id, partial, actor);
        await this.policies.delete(id);
        for (const policy of [before, updated]) {
            if (policy) await this.policiesByOrg.delete(policy.organizationId);
        }
        await this.effectivePolicies.clear();
        return updated;
    }

    async setBreakGlassPolicy(organizationId: string, policyId: string | null, actor: AuditActor): Promise<Policy | null> {
        // Two policy rows can change in one call (whichever previously held
        // the flag, and the new target) — fetched before mutating so both
        // get invalidated, not just the one id this method was passed. A
        // plain "invalidate what was passed in" would silently under-
        // invalidate the other row, exactly the class of bug this store's
        // other cache-invalidation code already goes out of its way to avoid.
        const previous = await this.inner.getBreakGlassPolicy(organizationId);
        const updated = await this.inner.setBreakGlassPolicy(organizationId, policyId, actor);
        await Promise.all([
            previous ? this.policies.delete(previous.id) : Promise.resolve(),
            policyId ? this.policies.delete(policyId) : Promise.resolve(),
            this.policiesByOrg.delete(organizationId),
        ]);
        return updated;
    }

    async getBreakGlassPolicy(organizationId: string): Promise<Policy | null> {
        return this.inner.getBreakGlassPolicy(organizationId);
    }

    async deletePolicy(id: string, actor: AuditActor): Promise<boolean> {
        const existing = await this.inner.getPolicy(id);
        const deleted = await this.inner.deletePolicy(id, actor);
        if (deleted) {
            await this.policies.delete(id);
            if (existing) await this.policiesByOrg.delete(existing.organizationId);
            await this.effectivePolicies.clear();
        }
        return deleted;
    }

    /**
     * The epoch comparison, not the cache key, is what closes the Redis-
     * rollback gap (see class doc comment) — the key stays plain `userId`,
     * so this must still coexist correctly with updateUser's per-key
     * `effectivePolicies.delete(id)` and updateGroup/updatePolicy/
     * deletePolicy's wholesale `.clear()`, both of which target that same
     * plain key and keep working unmodified.
     *
     * `getUser` (already cached, likely warm: routes/guards.ts always
     * resolves the caller's own User before this is ever called in the
     * same request) supplies the organizationId to scope the epoch to; a
     * userId this class can't resolve at all (shouldn't happen in practice
     * — callers only ever pass an id they just got from this same store)
     * falls through to `inner` uncached rather than guessing at one.
     */
    async resolveEffectivePolicies(userId: string): Promise<Policy[]> {
        const user = await this.getUser(userId);
        if (!user) return this.inner.resolveEffectivePolicies(userId);

        const currentEpoch = await this.currentEpoch(user.organizationId);
        const load = async (): Promise<{ epoch: number; policies: Policy[] }> => ({
            epoch: currentEpoch,
            policies: await this.inner.resolveEffectivePolicies(userId),
        });

        const cached = await this.effectivePolicies.getOrLoad(userId, load);
        if (cached.epoch >= currentEpoch) return cached.policies;

        // Tagged with an epoch older than the current (durable) one — the
        // entry predates a permission-revoking mutation that a Redis
        // rollback could otherwise have resurrected under this same key.
        // Force a fresh computation rather than trusting it.
        await this.effectivePolicies.delete(userId);
        const fresh = await this.effectivePolicies.getOrLoad(userId, load);
        return fresh.policies;
    }

    private async currentEpoch(organizationId: string): Promise<number> {
        return this.authorizationEpochs.getOrLoad(organizationId, () => this.inner.getAuthorizationEpoch(organizationId));
    }

    async getAuthorizationEpoch(organizationId: string): Promise<number> {
        return this.inner.getAuthorizationEpoch(organizationId);
    }

    /** Exposed for tests and operational visibility — not part of IamStore. */
    async stats(): Promise<Record<string, CacheStats>> {
        const [
            organizations,
            users,
            userBySubject,
            usersByOrg,
            usersBySubject,
            groups,
            groupsByOrg,
            policies,
            policiesByOrg,
            effectivePolicies,
            authorizationEpochs,
        ] = await Promise.all([
            this.organizations.stats(),
            this.users.stats(),
            this.userBySubject.stats(),
            this.usersByOrg.stats(),
            this.usersBySubject.stats(),
            this.groups.stats(),
            this.groupsByOrg.stats(),
            this.policies.stats(),
            this.policiesByOrg.stats(),
            this.effectivePolicies.stats(),
            this.authorizationEpochs.stats(),
        ]);
        return {
            organizations,
            users,
            userBySubject,
            usersByOrg,
            usersBySubject,
            groups,
            groupsByOrg,
            policies,
            policiesByOrg,
            effectivePolicies,
            authorizationEpochs,
        };
    }
}
