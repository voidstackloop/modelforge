import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Group, Organization, Policy, PolicyDocument, User } from "../domain/types.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import { InvalidReferenceError, type IamStore } from "./iam-store.js";
import type { TenantContext, TenantIamRepository } from "../tenant-context.js";

interface UserRow {
    id: string;
    organization_id: string;
    external_subject: string;
    display_name: string;
    email: string | null;
    status: string;
    permission_boundary_policy_id: string | null;
    created_at: Date;
    updated_at: Date;
    group_ids: string[];
    policy_ids: string[];
}

interface GroupRow {
    id: string;
    organization_id: string;
    name: string;
    created_at: Date;
    updated_at: Date;
    policy_ids: string[];
}

interface PolicyRow {
    id: string;
    organization_id: string;
    name: string;
    description: string | null;
    document: PolicyDocument;
    builtin: boolean;
    is_break_glass_policy: boolean;
    created_at: Date;
    updated_at: Date;
}

interface OrganizationRow {
    id: string;
    name: string;
    tenant_schema: string | null;
    created_at: Date;
}

function mapOrganization(row: OrganizationRow): Organization {
    return { id: row.id, name: row.name, tenantSchema: row.tenant_schema ?? undefined, createdAt: row.created_at.toISOString() };
}

function mapUser(row: UserRow): User {
    return {
        id: row.id,
        organizationId: row.organization_id,
        externalSubject: row.external_subject,
        displayName: row.display_name,
        email: row.email ?? undefined,
        status: row.status as User["status"],
        groupIds: row.group_ids,
        policyIds: row.policy_ids,
        permissionBoundaryPolicyId: row.permission_boundary_policy_id ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

function mapGroup(row: GroupRow): Group {
    return {
        id: row.id,
        organizationId: row.organization_id,
        name: row.name,
        policyIds: row.policy_ids,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

function mapPolicy(row: PolicyRow): Policy {
    return {
        id: row.id,
        organizationId: row.organization_id,
        name: row.name,
        description: row.description ?? undefined,
        document: row.document,
        builtin: row.builtin,
        isBreakGlassPolicy: row.is_break_glass_policy,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

const USER_SELECT = `
    SELECT u.*,
        COALESCE(array_agg(DISTINCT ug.group_id) FILTER (WHERE ug.group_id IS NOT NULL), '{}') AS group_ids,
        COALESCE(array_agg(DISTINCT up.policy_id) FILTER (WHERE up.policy_id IS NOT NULL), '{}') AS policy_ids
    FROM users u
    LEFT JOIN user_groups ug ON ug.user_id = u.id
    LEFT JOIN user_policies up ON up.user_id = u.id
`;

const GROUP_SELECT = `
    SELECT g.*,
        COALESCE(array_agg(gp.policy_id) FILTER (WHERE gp.policy_id IS NOT NULL), '{}') AS policy_ids
    FROM groups g
    LEFT JOIN group_policies gp ON gp.group_id = g.id
`;

/**
 * A real, Postgres-backed IamStore — see server/README.md's "Known gaps"
 * for why this uses shared tables (an organization_id column on every row)
 * rather than schema-per-tenant: a deliberate, disclosed simplification for
 * this control-plane metadata (org/user/group/policy *documents*, no PHI),
 * distinct from docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §2's
 * schema-per-tenant default for patient-case data specifically. Every
 * method here takes `organizationId` as an explicit parameter (matching
 * the IamStore interface) and every query is parameterized — there is no
 * dynamic SQL string-building for a tenant filter to be accidentally
 * omitted from.
 *
 * Not covered by any test run in this environment (no Postgres available
 * here — see migrate.test.ts and this file's own postgres-iam-store.test.ts,
 * both skipped unless a real `DATABASE_URL` is set). Run them against a
 * real Postgres instance before relying on this in production; the SQL
 * itself has not been executed anywhere in this session.
 */
export class PostgresIamStore implements IamStore {
    constructor(private readonly pool: Pool) {}

    bindTenant(context: TenantContext): TenantIamRepository {
        const run = <T>(operation: (store: PostgresIamStore) => Promise<T>): Promise<T> => this.withTenantConnection(context, operation);
        const inTenant = <T extends { organizationId: string }>(value: T | null): T | null => value?.organizationId === context.organizationId ? value : null;
        const repository: TenantIamRepository = {
            context,
            getOrganization: () => run((store) => store.getOrganization(context.organizationId)),
            createUser: (input, actor) => run((store) => store.createUser({ ...input, organizationId: context.organizationId }, actor)),
            getUser: (id) => run(async (store) => inTenant(await store.getUser(id))),
            findUserByExternalSubject: (subject) => run((store) => store.findUserByExternalSubject(context.organizationId, subject)),
            listUsers: () => run((store) => store.listUsersByOrganization(context.organizationId)),
            updateUser: (id, partial, actor) => run(async (store) => inTenant(await store.updateUser(id, partial, actor))),
            createGroup: (input, actor) => run((store) => store.createGroup({ ...input, organizationId: context.organizationId }, actor)),
            getGroup: (id) => run(async (store) => inTenant(await store.getGroup(id))),
            listGroups: () => run((store) => store.listGroupsByOrganization(context.organizationId)),
            updateGroup: (id, partial, actor) => run(async (store) => inTenant(await store.updateGroup(id, partial, actor))),
            createPolicy: (input, actor) => run((store) => store.createPolicy({ ...input, organizationId: context.organizationId }, actor)),
            getPolicy: (id) => run(async (store) => inTenant(await store.getPolicy(id))),
            listPolicies: () => run((store) => store.listPoliciesByOrganization(context.organizationId)),
            updatePolicy: (id, partial, actor) => run(async (store) => inTenant(await store.updatePolicy(id, partial, actor))),
            deletePolicy: (id, actor) => run((store) => store.deletePolicy(id, actor)),
            setBreakGlassPolicy: (policyId, actor) => run((store) => store.setBreakGlassPolicy(context.organizationId, policyId, actor)),
            getBreakGlassPolicy: () => run((store) => store.getBreakGlassPolicy(context.organizationId)),
            resolveEffectivePolicies: (userId) => run(async (store) => (await store.resolveEffectivePolicies(userId)).filter((policy) => policy.organizationId === context.organizationId)),
        };
        return Object.freeze(repository);
    }

    private async withTenantConnection<T>(context: TenantContext, operation: (store: PostgresIamStore) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        const clientProxy = new Proxy(client, {
            get(target, property) {
                if (property === "release") return () => {};
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const boundPool = {
            query: client.query.bind(client),
            connect: async () => clientProxy,
        } as unknown as Pool;
        try {
            await client.query("SELECT set_config('app.tenant_id', $1, false)", [context.organizationId]);
            return await operation(new PostgresIamStore(boundPool));
        } finally {
            await client.query("RESET app.tenant_id").catch(() => {});
            client.release();
        }
    }

    /**
     * Verifies every id in `ids` names a row in `table` scoped to
     * `organizationId`, inside the caller's own transaction — throws
     * InvalidReferenceError (id(s) missing or belonging to a different
     * organization) rather than letting the subsequent INSERT fail on a
     * bare foreign-key violation. `table` is always one of the two literal
     * strings below, never caller/request-supplied, so this isn't a SQL
     * injection surface despite the string interpolation.
     */
    private async assertIdsBelongToOrganization(
        client: PoolClient,
        table: "policies" | "groups",
        ids: string[],
        organizationId: string
    ): Promise<void> {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length === 0) return;
        const result = await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1) AND organization_id = $2`, [
            uniqueIds,
            organizationId,
        ]);
        if (result.rows.length !== uniqueIds.length) {
            const found = new Set(result.rows.map((row) => row.id));
            const missing = uniqueIds.filter((id) => !found.has(id));
            const label = table === "policies" ? "Policy" : "Group";
            throw new InvalidReferenceError(`${label} id(s) not found in this organization: ${missing.join(", ")}`);
        }
    }

    /** See IamStore.getAuthorizationEpoch's doc comment. Always called
     * inside the same transaction as the mutation that requires it, so the
     * epoch bump and the actual data change commit or roll back together —
     * a mutation that fails must never advance the epoch (that would cost
     * every other cache entry in the organization a needless recompute for
     * no reason), and a successful mutation must never fail to advance it
     * (that would reopen exactly the staleness gap this exists to close). */
    private async bumpAuthorizationEpoch(client: PoolClient, organizationId: string): Promise<void> {
        await client.query(
            `INSERT INTO authorization_epochs (organization_id, epoch) VALUES ($1, 2)
             ON CONFLICT (organization_id) DO UPDATE SET epoch = authorization_epochs.epoch + 1`,
            [organizationId]
        );
    }

    async getAuthorizationEpoch(organizationId: string): Promise<number> {
        const result = await this.pool.query<{ epoch: string }>("SELECT epoch FROM authorization_epochs WHERE organization_id = $1", [
            organizationId,
        ]);
        return result.rows[0] ? Number(result.rows[0].epoch) : 1;
    }

    async createOrganization(name: string, actor: AuditActor): Promise<Organization> {
        const id = randomUUID();
        const createdAt = new Date();
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)", [id, name, createdAt]);
            await insertAuditEntry(client, {
                organizationId: id,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "organization.create",
                targetType: "organization",
                targetId: id,
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return { id, name, createdAt: createdAt.toISOString() };
    }

    async getOrganization(id: string): Promise<Organization | null> {
        const result = await this.pool.query<OrganizationRow>("SELECT * FROM organizations WHERE id = $1", [id]);
        return result.rows[0] ? mapOrganization(result.rows[0]) : null;
    }

    /** See IamStore.deleteOrganization's doc comment. `ON DELETE CASCADE`
     * (migrations 001, 007) does the actual cleanup of users/groups/
     * policies/authorization_epochs/memberships/invitations/
     * service_principals/idempotency_keys — this is deliberately a plain
     * DELETE, not wrapped in bindTenant/RLS, since the caller (a failed
     * bootstrap) has no membership in this organization to authorize a
     * tenant-scoped connection with; the organization is being undone
     * precisely because it never finished being created. */
    async deleteOrganization(id: string): Promise<void> {
        await this.pool.query("DELETE FROM organizations WHERE id = $1", [id]);
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
        const id = randomUUID();
        const now = new Date();
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await this.assertIdsBelongToOrganization(client, "groups", input.groupIds ?? [], input.organizationId);
            await this.assertIdsBelongToOrganization(client, "policies", input.policyIds ?? [], input.organizationId);
            if (input.permissionBoundaryPolicyId !== undefined) {
                await this.assertIdsBelongToOrganization(client, "policies", [input.permissionBoundaryPolicyId], input.organizationId);
            }
            await client.query(
                `INSERT INTO users (id, organization_id, external_subject, display_name, email, status, permission_boundary_policy_id, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)`,
                [id, input.organizationId, input.externalSubject, input.displayName, input.email ?? null, input.permissionBoundaryPolicyId ?? null, now]
            );
            await insertUserGroups(client, id, input.groupIds ?? []);
            await insertUserPolicies(client, id, input.policyIds ?? []);
            await insertAuditEntry(client, {
                organizationId: input.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "user.create",
                targetType: "user",
                targetId: id,
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return (await this.getUser(id))!;
    }

    async getUser(id: string): Promise<User | null> {
        const result = await this.pool.query<UserRow>(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async findUserByExternalSubject(organizationId: string, externalSubject: string): Promise<User | null> {
        const result = await this.pool.query<UserRow>(`${USER_SELECT} WHERE u.organization_id = $1 AND u.external_subject = $2 GROUP BY u.id`, [
            organizationId,
            externalSubject,
        ]);
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async listUsersByExternalSubject(externalSubject: string): Promise<User[]> {
        const result = await this.pool.query<UserRow>(`${USER_SELECT} WHERE u.external_subject = $1 GROUP BY u.id`, [externalSubject]);
        return result.rows.map(mapUser);
    }

    async listUsersByOrganization(organizationId: string): Promise<User[]> {
        const result = await this.pool.query<UserRow>(`${USER_SELECT} WHERE u.organization_id = $1 GROUP BY u.id`, [organizationId]);
        return result.rows.map(mapUser);
    }

    async updateUser(
        id: string,
        partial: Partial<Pick<User, "displayName" | "email" | "status" | "groupIds" | "policyIds" | "permissionBoundaryPolicyId">>,
        actor: AuditActor
    ): Promise<User | null> {
        const existing = await this.getUser(id);
        if (!existing) return null;

        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            if (partial.permissionBoundaryPolicyId !== undefined) {
                await this.assertIdsBelongToOrganization(client, "policies", [partial.permissionBoundaryPolicyId], existing.organizationId);
            }
            await client.query(
                `UPDATE users SET display_name = $2, email = $3, status = $4, permission_boundary_policy_id = $5, updated_at = $6 WHERE id = $1`,
                [
                    id,
                    partial.displayName ?? existing.displayName,
                    (partial.email ?? existing.email) ?? null,
                    partial.status ?? existing.status,
                    (partial.permissionBoundaryPolicyId ?? existing.permissionBoundaryPolicyId) ?? null,
                    new Date(),
                ]
            );
            if (partial.groupIds !== undefined) {
                await this.assertIdsBelongToOrganization(client, "groups", partial.groupIds, existing.organizationId);
                await client.query("DELETE FROM user_groups WHERE user_id = $1", [id]);
                await insertUserGroups(client, id, partial.groupIds);
            }
            if (partial.policyIds !== undefined) {
                await this.assertIdsBelongToOrganization(client, "policies", partial.policyIds, existing.organizationId);
                await client.query("DELETE FROM user_policies WHERE user_id = $1", [id]);
                await insertUserPolicies(client, id, partial.policyIds);
            }
            await insertAuditEntry(client, {
                organizationId: existing.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "user.update",
                targetType: "user",
                targetId: id,
                details: { fields: Object.keys(partial) },
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return this.getUser(id);
    }

    async createGroup(input: { organizationId: string; name: string; policyIds?: string[] }, actor: AuditActor): Promise<Group> {
        const id = randomUUID();
        const now = new Date();
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await this.assertIdsBelongToOrganization(client, "policies", input.policyIds ?? [], input.organizationId);
            await client.query(`INSERT INTO groups (id, organization_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`, [
                id,
                input.organizationId,
                input.name,
                now,
            ]);
            await insertGroupPolicies(client, id, input.policyIds ?? []);
            await insertAuditEntry(client, {
                organizationId: input.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "group.create",
                targetType: "group",
                targetId: id,
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return (await this.getGroup(id))!;
    }

    async getGroup(id: string): Promise<Group | null> {
        const result = await this.pool.query<GroupRow>(`${GROUP_SELECT} WHERE g.id = $1 GROUP BY g.id`, [id]);
        return result.rows[0] ? mapGroup(result.rows[0]) : null;
    }

    async listGroupsByOrganization(organizationId: string): Promise<Group[]> {
        const result = await this.pool.query<GroupRow>(`${GROUP_SELECT} WHERE g.organization_id = $1 GROUP BY g.id`, [organizationId]);
        return result.rows.map(mapGroup);
    }

    async updateGroup(id: string, partial: Partial<Pick<Group, "name" | "policyIds">>, actor: AuditActor): Promise<Group | null> {
        const existing = await this.getGroup(id);
        if (!existing) return null;

        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`UPDATE groups SET name = $2, updated_at = $3 WHERE id = $1`, [id, partial.name ?? existing.name, new Date()]);
            if (partial.policyIds !== undefined) {
                await this.assertIdsBelongToOrganization(client, "policies", partial.policyIds, existing.organizationId);
                await client.query("DELETE FROM group_policies WHERE group_id = $1", [id]);
                await insertGroupPolicies(client, id, partial.policyIds);
            }
            await this.bumpAuthorizationEpoch(client, existing.organizationId);
            await insertAuditEntry(client, {
                organizationId: existing.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "group.update",
                targetType: "group",
                targetId: id,
                details: { fields: Object.keys(partial) },
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return this.getGroup(id);
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
        const id = randomUUID();
        const now = new Date();
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                `INSERT INTO policies (id, organization_id, name, description, document, builtin, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
                [id, input.organizationId, input.name, input.description ?? null, JSON.stringify(input.document), input.builtin ?? false, now]
            );
            await insertAuditEntry(client, {
                organizationId: input.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "policy.create",
                targetType: "policy",
                targetId: id,
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return (await this.getPolicy(id))!;
    }

    async getPolicy(id: string): Promise<Policy | null> {
        const result = await this.pool.query<PolicyRow>("SELECT * FROM policies WHERE id = $1", [id]);
        return result.rows[0] ? mapPolicy(result.rows[0]) : null;
    }

    async listPoliciesByOrganization(organizationId: string): Promise<Policy[]> {
        const result = await this.pool.query<PolicyRow>("SELECT * FROM policies WHERE organization_id = $1", [organizationId]);
        return result.rows.map(mapPolicy);
    }

    async updatePolicy(
        id: string,
        partial: Partial<Pick<Policy, "name" | "description" | "document">>,
        actor: AuditActor
    ): Promise<Policy | null> {
        const existing = await this.getPolicy(id);
        if (!existing) return null;
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`UPDATE policies SET name = $2, description = $3, document = $4, updated_at = $5 WHERE id = $1`, [
                id,
                partial.name ?? existing.name,
                (partial.description ?? existing.description) ?? null,
                JSON.stringify(partial.document ?? existing.document),
                new Date(),
            ]);
            await this.bumpAuthorizationEpoch(client, existing.organizationId);
            await insertAuditEntry(client, {
                organizationId: existing.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "policy.update",
                targetType: "policy",
                targetId: id,
                details: { fields: Object.keys(partial) },
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return this.getPolicy(id);
    }

    async deletePolicy(id: string, actor: AuditActor): Promise<boolean> {
        const existing = await this.getPolicy(id);
        if (!existing || existing.builtin || existing.isBreakGlassPolicy) return false;
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("DELETE FROM policies WHERE id = $1", [id]);
            await this.bumpAuthorizationEpoch(client, existing.organizationId);
            await insertAuditEntry(client, {
                organizationId: existing.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "policy.delete",
                targetType: "policy",
                targetId: id,
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return true;
    }

    async setBreakGlassPolicy(organizationId: string, policyId: string | null, actor: AuditActor): Promise<Policy | null> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            if (policyId !== null) {
                await this.assertIdsBelongToOrganization(client, "policies", [policyId], organizationId);
            }
            const previous = await client.query<{ id: string }>(
                "SELECT id FROM policies WHERE organization_id = $1 AND is_break_glass_policy",
                [organizationId]
            );
            // Clear before set: Postgres checks a non-deferred unique index
            // per-statement, not per-transaction — setting the new row's
            // flag before clearing the old one would transiently violate
            // idx_policies_org_break_glass (migrations/011) within the SET
            // statement's own end-of-statement check.
            await client.query("UPDATE policies SET is_break_glass_policy = false WHERE organization_id = $1 AND is_break_glass_policy", [
                organizationId,
            ]);
            if (policyId !== null) {
                await client.query("UPDATE policies SET is_break_glass_policy = true, updated_at = $2 WHERE id = $1", [policyId, new Date()]);
            }
            await insertAuditEntry(client, {
                organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "breakGlassPolicy.set",
                targetType: "policy",
                targetId: policyId ?? previous.rows[0]?.id ?? organizationId,
                details: { policyId, previousPolicyId: previous.rows[0]?.id },
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
        return policyId !== null ? this.getPolicy(policyId) : null;
    }

    async getBreakGlassPolicy(organizationId: string): Promise<Policy | null> {
        const result = await this.pool.query<PolicyRow>("SELECT * FROM policies WHERE organization_id = $1 AND is_break_glass_policy", [
            organizationId,
        ]);
        return result.rows[0] ? mapPolicy(result.rows[0]) : null;
    }

    async resolveEffectivePolicies(userId: string): Promise<Policy[]> {
        const result = await this.pool.query<PolicyRow>(
            `SELECT p.* FROM policies p WHERE p.id IN (
                SELECT policy_id FROM user_policies WHERE user_id = $1
                UNION
                SELECT gp.policy_id FROM group_policies gp
                JOIN user_groups ug ON ug.group_id = gp.group_id
                WHERE ug.user_id = $1
            )`,
            [userId]
        );
        return result.rows.map(mapPolicy);
    }
}

async function insertUserGroups(client: PoolClient, userId: string, groupIds: string[]): Promise<void> {
    for (const groupId of groupIds) {
        await client.query("INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, groupId]);
    }
}

async function insertUserPolicies(client: PoolClient, userId: string, policyIds: string[]): Promise<void> {
    for (const policyId of policyIds) {
        await client.query("INSERT INTO user_policies (user_id, policy_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, policyId]);
    }
}

async function insertGroupPolicies(client: PoolClient, groupId: string, policyIds: string[]): Promise<void> {
    for (const policyId of policyIds) {
        await client.query("INSERT INTO group_policies (group_id, policy_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [groupId, policyId]);
    }
}
