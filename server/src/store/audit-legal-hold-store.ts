import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuditLegalHold } from "../domain/types.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore, insertAuditEntry } from "./audit-store.js";

/**
 * Legal holds over an organization's audit trail (P1: immutable audit
 * ingestion, search, export, and legal hold — see domain/types.ts's
 * AuditLegalHold doc comment). A separate store from AccessGovernanceStore
 * deliberately: this is an audit/compliance concern, not an access-
 * governance one, even though the shape (place → an attributable,
 * append-only record; release → a second attributable record) rhymes with
 * break-glass review.
 */
export interface AuditLegalHoldStore {
    place(organizationId: string, reason: string, placedByUserId: string, actor: AuditActor): Promise<AuditLegalHold>;
    listByOrganization(organizationId: string): Promise<AuditLegalHold[]>;
    getById(organizationId: string, holdId: string): Promise<AuditLegalHold | null>;
    /** Returns null if the hold doesn't exist or is already released —
     * routes/audit.ts pre-checks the same thing for a clean 400; this is
     * defense in depth. */
    release(
        organizationId: string,
        holdId: string,
        releaseReason: string | undefined,
        releasedByUserId: string,
        actor: AuditActor
    ): Promise<AuditLegalHold | null>;
}

export class InMemoryAuditLegalHoldStore implements AuditLegalHoldStore {
    private readonly holds = new Map<string, AuditLegalHold>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    async place(organizationId: string, reason: string, placedByUserId: string, actor: AuditActor): Promise<AuditLegalHold> {
        const hold: AuditLegalHold = {
            id: randomUUID(),
            organizationId,
            reason,
            status: "active",
            placedByUserId,
            placedAt: new Date().toISOString(),
        };
        this.holds.set(hold.id, hold);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "auditLegalHold.place", targetType: "auditLegalHold", targetId: hold.id, details: { reason },
        });
        return hold;
    }

    async listByOrganization(organizationId: string): Promise<AuditLegalHold[]> {
        return [...this.holds.values()].filter((h) => h.organizationId === organizationId).sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1));
    }

    async getById(organizationId: string, holdId: string): Promise<AuditLegalHold | null> {
        const hold = this.holds.get(holdId);
        return hold && hold.organizationId === organizationId ? hold : null;
    }

    async release(
        organizationId: string,
        holdId: string,
        releaseReason: string | undefined,
        releasedByUserId: string,
        actor: AuditActor
    ): Promise<AuditLegalHold | null> {
        const hold = await this.getById(organizationId, holdId);
        if (!hold || hold.status !== "active") return null;
        const released: AuditLegalHold = {
            ...hold,
            status: "released",
            releasedByUserId,
            releasedAt: new Date().toISOString(),
            releaseReason,
        };
        this.holds.set(holdId, released);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "auditLegalHold.release", targetType: "auditLegalHold", targetId: holdId, details: { releaseReason },
        });
        return released;
    }
}

interface HoldRow {
    id: string;
    organization_id: string;
    reason: string;
    status: "active" | "released";
    placed_by_user_id: string;
    placed_at: Date;
    released_by_user_id: string | null;
    released_at: Date | null;
    release_reason: string | null;
}

function mapHold(row: HoldRow): AuditLegalHold {
    return {
        id: row.id,
        organizationId: row.organization_id,
        reason: row.reason,
        status: row.status,
        placedByUserId: row.placed_by_user_id,
        placedAt: row.placed_at.toISOString(),
        releasedByUserId: row.released_by_user_id ?? undefined,
        releasedAt: row.released_at?.toISOString(),
        releaseReason: row.release_reason ?? undefined,
    };
}

export class PostgresAuditLegalHoldStore implements AuditLegalHoldStore {
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

    async place(organizationId: string, reason: string, placedByUserId: string, actor: AuditActor): Promise<AuditLegalHold> {
        return this.tenantRead(organizationId, async (client) => {
            const id = randomUUID();
            const placedAt = new Date();
            const result = await client.query<HoldRow>(
                `INSERT INTO audit_legal_holds (id, organization_id, reason, status, placed_by_user_id, placed_at)
                 VALUES ($1, $2, $3, 'active', $4, $5) RETURNING *`,
                [id, organizationId, reason, placedByUserId, placedAt]
            );
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "auditLegalHold.place", targetType: "auditLegalHold", targetId: id, details: { reason },
            });
            return mapHold(result.rows[0]);
        });
    }

    async listByOrganization(organizationId: string): Promise<AuditLegalHold[]> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<HoldRow>(
                "SELECT * FROM audit_legal_holds WHERE organization_id = $1 ORDER BY placed_at DESC",
                [organizationId]
            );
            return result.rows.map(mapHold);
        });
    }

    async getById(organizationId: string, holdId: string): Promise<AuditLegalHold | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<HoldRow>("SELECT * FROM audit_legal_holds WHERE organization_id = $1 AND id = $2", [
                organizationId,
                holdId,
            ]);
            return result.rows[0] ? mapHold(result.rows[0]) : null;
        });
    }

    async release(
        organizationId: string,
        holdId: string,
        releaseReason: string | undefined,
        releasedByUserId: string,
        actor: AuditActor
    ): Promise<AuditLegalHold | null> {
        return this.tenantRead(organizationId, async (client) => {
            const releasedAt = new Date();
            const result = await client.query<HoldRow>(
                `UPDATE audit_legal_holds SET status='released', released_by_user_id=$3, released_at=$4, release_reason=$5
                 WHERE organization_id=$1 AND id=$2 AND status='active' RETURNING *`,
                [organizationId, holdId, releasedByUserId, releasedAt, releaseReason ?? null]
            );
            if (!result.rows[0]) return null;
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "auditLegalHold.release", targetType: "auditLegalHold", targetId: holdId, details: { releaseReason },
            });
            return mapHold(result.rows[0]);
        });
    }
}
