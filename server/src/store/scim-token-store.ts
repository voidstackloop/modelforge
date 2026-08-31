import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ScimToken } from "../domain/types.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore, insertAuditEntry } from "./audit-store.js";

/** See domain/types.ts's scimTokenSchema doc comment for the full design
 * rationale (why a static bearer token, why it maps onto Invitation). */
export interface ScimTokenStore {
    create(organizationId: string, name: string, tokenHash: string, createdByUserId: string, actor: AuditActor): Promise<ScimToken>;
    listByOrganization(organizationId: string): Promise<ScimToken[]>;
    /** Returns null if the token doesn't exist, belongs to a different
     * organization, or is already revoked — routes/scim-tokens.ts
     * pre-checks the same thing for a clean 404; this is defense in depth. */
    revoke(organizationId: string, tokenId: string, actor: AuditActor): Promise<ScimToken | null>;
    /** The SCIM auth boundary (routes/scim.ts, on every SCIM request):
     * finds a non-revoked token in `organizationId` whose hash matches, and
     * best-effort touches lastUsedAt. Returns null (never throws for "not
     * found") so the caller can respond 401 uniformly regardless of why. */
    findActiveByHash(organizationId: string, tokenHash: string): Promise<ScimToken | null>;
}

export class InMemoryScimTokenStore implements ScimTokenStore {
    private readonly tokens = new Map<string, ScimToken>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    async create(organizationId: string, name: string, tokenHash: string, createdByUserId: string, actor: AuditActor): Promise<ScimToken> {
        const token: ScimToken = { id: randomUUID(), organizationId, name, tokenHash, createdByUserId, createdAt: new Date().toISOString() };
        this.tokens.set(token.id, token);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "scimToken.create", targetType: "scimToken", targetId: token.id, details: { name },
        });
        return token;
    }

    async listByOrganization(organizationId: string): Promise<ScimToken[]> {
        return [...this.tokens.values()].filter((t) => t.organizationId === organizationId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }

    async revoke(organizationId: string, tokenId: string, actor: AuditActor): Promise<ScimToken | null> {
        const existing = this.tokens.get(tokenId);
        if (!existing || existing.organizationId !== organizationId || existing.revokedAt) return null;
        const revoked: ScimToken = { ...existing, revokedAt: new Date().toISOString() };
        this.tokens.set(tokenId, revoked);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "scimToken.revoke", targetType: "scimToken", targetId: tokenId, details: {},
        });
        return revoked;
    }

    async findActiveByHash(organizationId: string, tokenHash: string): Promise<ScimToken | null> {
        const found = [...this.tokens.values()].find((t) => t.organizationId === organizationId && t.tokenHash === tokenHash && !t.revokedAt);
        if (!found) return null;
        const touched: ScimToken = { ...found, lastUsedAt: new Date().toISOString() };
        this.tokens.set(found.id, touched);
        return touched;
    }
}

interface ScimTokenRow {
    id: string;
    organization_id: string;
    name: string;
    token_hash: string;
    created_by_user_id: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
}

function mapRow(row: ScimTokenRow): ScimToken {
    return {
        id: row.id,
        organizationId: row.organization_id,
        name: row.name,
        tokenHash: row.token_hash,
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at.toISOString(),
        lastUsedAt: row.last_used_at?.toISOString(),
        revokedAt: row.revoked_at?.toISOString(),
    };
}

export class PostgresScimTokenStore implements ScimTokenStore {
    constructor(private readonly pool: Pool) {}

    private async tenantRead<T>(organizationId: string, query: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const result = await query(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async create(organizationId: string, name: string, tokenHash: string, createdByUserId: string, actor: AuditActor): Promise<ScimToken> {
        return this.tenantRead(organizationId, async (client) => {
            const id = randomUUID();
            const result = await client.query<ScimTokenRow>(
                `INSERT INTO scim_tokens (id, organization_id, name, token_hash, created_by_user_id, created_at)
                 VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
                [id, organizationId, name, tokenHash, createdByUserId]
            );
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "scimToken.create", targetType: "scimToken", targetId: id, details: { name },
            });
            return mapRow(result.rows[0]);
        });
    }

    async listByOrganization(organizationId: string): Promise<ScimToken[]> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<ScimTokenRow>(
                "SELECT * FROM scim_tokens WHERE organization_id = $1 ORDER BY created_at DESC",
                [organizationId]
            );
            return result.rows.map(mapRow);
        });
    }

    async revoke(organizationId: string, tokenId: string, actor: AuditActor): Promise<ScimToken | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<ScimTokenRow>(
                `UPDATE scim_tokens SET revoked_at = now() WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING *`,
                [organizationId, tokenId]
            );
            if (!result.rows[0]) return null;
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "scimToken.revoke", targetType: "scimToken", targetId: tokenId, details: {},
            });
            return mapRow(result.rows[0]);
        });
    }

    async findActiveByHash(organizationId: string, tokenHash: string): Promise<ScimToken | null> {
        // Not wrapped in tenantRead's audit-adjacent transaction pattern:
        // this runs on every SCIM request (a hot path, unlike the admin-
        // facing create/list/revoke above) and lastUsedAt is a best-effort
        // diagnostic, not something that needs the same durability
        // guarantees as an audited mutation — a lost update here just means
        // a slightly stale "last used" timestamp, never a security issue.
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const result = await client.query<ScimTokenRow>(
                "SELECT * FROM scim_tokens WHERE organization_id = $1 AND token_hash = $2 AND revoked_at IS NULL",
                [organizationId, tokenHash]
            );
            if (!result.rows[0]) {
                await client.query("COMMIT");
                return null;
            }
            const updated = await client.query<ScimTokenRow>(
                "UPDATE scim_tokens SET last_used_at = now() WHERE id = $1 RETURNING *",
                [result.rows[0].id]
            );
            await client.query("COMMIT");
            return mapRow(updated.rows[0]);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
