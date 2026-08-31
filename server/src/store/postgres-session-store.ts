import type { SessionChange, SessionResourceAttributes, SharedChatSession } from "@modelforge/contracts";
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "../tenant-context.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import { parseVersionCursor, type SessionStore, type StoredSessionChange, type TenantSessionRepository } from "./session-store.js";

interface SessionRow {
    id: string;
    version: string;
    data: SharedChatSession;
    owner_user_id: string;
    assigned_user_ids: string[];
    updated_at: Date;
}
interface ChangeRow {
    sequence: string;
    kind: "upsert" | "delete";
    session_id: string;
    version: string;
    session_data: SharedChatSession | null;
    resource: SessionResourceAttributes;
    changed_at: Date;
}

function assertSchemaName(schemaName: string): string {
    if (!/^tenant_[a-f0-9]{32}$/.test(schemaName)) throw new Error("Unsafe tenant schema identifier.");
    return `"${schemaName}"`;
}
function mapResource(row: SessionRow, organizationId: string): SessionResourceAttributes {
    return { organizationId, sessionId: row.id, ownerUserId: row.owner_user_id, assignedUserIds: row.assigned_user_ids };
}
function mapSession(row: SessionRow): SharedChatSession {
    return { ...row.data, id: row.id, version: row.version, updatedAt: row.updated_at.toISOString() };
}
function mapChange(row: ChangeRow): StoredSessionChange {
    const change: SessionChange =
        row.kind === "upsert"
            ? { sequence: row.sequence, kind: "upsert", sessionId: row.session_id, version: row.version, changedAt: row.changed_at.toISOString(), session: row.session_data! }
            : { sequence: row.sequence, kind: "delete", sessionId: row.session_id, version: row.version, changedAt: row.changed_at.toISOString() };
    return { change, resource: row.resource };
}

/** Postgres-backed. Not run against a real Postgres instance in the
 * environment this was built in — see server/README.md and this package's
 * other postgres-*.test.ts files, all gated on DATABASE_URL. */
export class PostgresSessionStore implements SessionStore {
    constructor(private readonly pool: Pool) {}

    forTenant(context: TenantContext): TenantSessionRepository {
        const schema = assertSchemaName(context.schemaName);
        const repository: TenantSessionRepository = {
            context,
            getOne: (id) => this.getOneBound(context, schema, id),
            readChanges: (cursor) => this.readChangesBound(context, schema, cursor),
            writeOne: (session, expectedVersion, actor, resource) => this.writeBound(context, schema, session, expectedVersion, actor, resource),
            deleteOne: (id, expectedVersion, actor) => this.deleteBound(context, schema, id, expectedVersion, actor),
        };
        return Object.freeze(repository);
    }

    private async beginTenant(client: PoolClient, context: TenantContext, isolation = false): Promise<void> {
        await client.query(isolation ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [context.organizationId]);
    }

    private async getOneBound(context: TenantContext, schema: string, id: string): Promise<{ session: SharedChatSession; resource: SessionResourceAttributes } | null> {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context);
            const result = await client.query<SessionRow>(`SELECT * FROM ${schema}.chat_sessions WHERE id=$1`, [id]);
            await client.query("COMMIT");
            const row = result.rows[0];
            return row ? { session: mapSession(row), resource: mapResource(row, context.organizationId) } : null;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    private async highWater(client: PoolClient, schema: string): Promise<string> {
        const result = await client.query<{ value: string }>(`SELECT next_sequence - 1 AS value FROM ${schema}.chat_session_change_counter WHERE singleton=TRUE`);
        return result.rows[0]?.value ?? "0";
    }

    private async readChangesBound(context: TenantContext, schema: string, cursor: string | null): Promise<{ changes: StoredSessionChange[]; cursor: string }> {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context, true);
            const highWater = await this.highWater(client, schema);
            const since = parseVersionCursor(cursor);
            let changes: StoredSessionChange[];
            if (since === null) {
                const rows = await client.query<SessionRow>(`SELECT * FROM ${schema}.chat_sessions ORDER BY version`);
                changes = rows.rows.map((row) => {
                    const session = mapSession(row);
                    return {
                        resource: mapResource(row, context.organizationId),
                        change: { sequence: row.version, kind: "upsert", sessionId: row.id, version: row.version, changedAt: row.updated_at.toISOString(), session },
                    };
                });
            } else {
                const rows = await client.query<ChangeRow>(`SELECT * FROM ${schema}.chat_session_changes WHERE sequence>$1 AND sequence<=$2 ORDER BY sequence`, [
                    since.toString(),
                    highWater,
                ]);
                changes = rows.rows.map(mapChange);
            }
            await client.query("COMMIT");
            return { changes, cursor: highWater };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    private async nextSequence(client: PoolClient, schema: string): Promise<string> {
        const result = await client.query<{ assigned: string }>(
            `UPDATE ${schema}.chat_session_change_counter SET next_sequence=next_sequence+1 WHERE singleton=TRUE RETURNING next_sequence-1 AS assigned`
        );
        return result.rows[0].assigned;
    }

    private async writeBound(
        context: TenantContext,
        schema: string,
        session: SharedChatSession,
        expectedVersion: string | null,
        actor: AuditActor,
        resource: SessionResourceAttributes
    ) {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context);
            const existingResult = await client.query<SessionRow>(`SELECT * FROM ${schema}.chat_sessions WHERE id=$1 FOR UPDATE`, [session.id]);
            const existing = existingResult.rows[0] ? mapSession(existingResult.rows[0]) : null;
            if ((existing?.version ?? null) !== expectedVersion) {
                await client.query("ROLLBACK");
                return { conflict: true as const, current: existing! };
            }
            const version = await this.nextSequence(client, schema);
            const now = new Date();
            const saved: SharedChatSession = { ...session, version, updatedAt: now.toISOString() };
            const safeResource: SessionResourceAttributes = { ...resource, organizationId: context.organizationId, sessionId: session.id };
            await client.query(
                `INSERT INTO ${schema}.chat_sessions (id,version,data,owner_user_id,assigned_user_ids,updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (id) DO UPDATE SET version=EXCLUDED.version,data=EXCLUDED.data,owner_user_id=EXCLUDED.owner_user_id,assigned_user_ids=EXCLUDED.assigned_user_ids,updated_at=EXCLUDED.updated_at`,
                [saved.id, version, JSON.stringify(saved), safeResource.ownerUserId, safeResource.assignedUserIds, now]
            );
            await client.query(
                `INSERT INTO ${schema}.chat_session_changes (sequence,kind,session_id,version,session_data,resource,changed_at) VALUES ($1,'upsert',$2,$1,$3,$4,$5)`,
                [version, saved.id, JSON.stringify(saved), JSON.stringify(safeResource), now]
            );
            await insertAuditEntry(client, {
                organizationId: context.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: expectedVersion === null ? "chatSession.create" : "chatSession.update",
                targetType: "chatSession",
                targetId: saved.id,
            });
            await client.query("COMMIT");
            return { session: saved, version };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    private async deleteBound(context: TenantContext, schema: string, id: string, expectedVersion: string | null, actor: AuditActor) {
        const client = await this.pool.connect();
        try {
            await this.beginTenant(client, context);
            const result = await client.query<SessionRow>(`SELECT * FROM ${schema}.chat_sessions WHERE id=$1 FOR UPDATE`, [id]);
            const row = result.rows[0];
            if (!row) {
                await client.query("ROLLBACK");
                return { notFound: true as const };
            }
            const current = mapSession(row);
            if (current.version !== expectedVersion) {
                await client.query("ROLLBACK");
                return { conflict: true as const, current };
            }
            const version = await this.nextSequence(client, schema);
            const now = new Date();
            const resource = mapResource(row, context.organizationId);
            await client.query(`DELETE FROM ${schema}.chat_sessions WHERE id=$1`, [id]);
            await client.query(`INSERT INTO ${schema}.chat_session_changes (sequence,kind,session_id,version,session_data,resource,changed_at) VALUES ($1,'delete',$2,$1,NULL,$3,$4)`, [
                version,
                id,
                JSON.stringify(resource),
                now,
            ]);
            await insertAuditEntry(client, {
                organizationId: context.organizationId,
                actorUserId: actor.userId,
                actorExternalSubject: actor.externalSubject,
                action: "chatSession.delete",
                targetType: "chatSession",
                targetId: id,
            });
            await client.query("COMMIT");
            const tombstone: SessionChange = { sequence: version, kind: "delete", sessionId: id, version, changedAt: now.toISOString() };
            return { deleted: true as const, tombstone };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
