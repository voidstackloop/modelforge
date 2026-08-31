import type { SessionChange, SessionChangeFeed, SessionResourceAttributes, SharedChatSession } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import type { AuditActor } from "./audit-store.js";

/**
 * Shared chat sessions (P1 item 7: remaining shared clinical domains) — the
 * exact same interface shape as case-store.ts's CaseStore/TenantCaseRepository,
 * one level simpler (no soft-delete/staged-migration concept: chat sessions
 * have no analogue to a case migration, so a delete here is a real DELETE).
 * See routes/sessions.ts's header comment for the authorization model this
 * store's resource attributes feed into.
 */
export function parseVersionCursor(cursor: string | null): bigint | null {
    if (cursor === null || !/^\d+$/.test(cursor)) return null;
    return BigInt(cursor);
}

export interface StoredSessionChange { change: SessionChange; resource: SessionResourceAttributes }

export interface TenantSessionRepository {
    readonly context: TenantContext;
    getOne(id: string): Promise<{ session: SharedChatSession; resource: SessionResourceAttributes } | null>;
    readChanges(cursor: string | null): Promise<{ changes: StoredSessionChange[]; cursor: string }>;
    writeOne(
        session: SharedChatSession,
        expectedVersion: string | null,
        actor: AuditActor,
        resource: SessionResourceAttributes
    ): Promise<{ session: SharedChatSession; version: string } | { conflict: true; current: SharedChatSession }>;
    deleteOne(
        id: string,
        expectedVersion: string | null,
        actor: AuditActor
    ): Promise<{ deleted: true; tombstone: SessionChange } | { conflict: true; current: SharedChatSession } | { notFound: true }>;
}

export interface SessionStore {
    forTenant(context: TenantContext): TenantSessionRepository;
}

export function publicFeed(changes: StoredSessionChange[], cursor: string): SessionChangeFeed {
    return { changes: changes.map((entry) => entry.change), cursor };
}
