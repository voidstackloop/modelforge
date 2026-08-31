import type { SessionChange, SessionResourceAttributes, SharedChatSession } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";
import { parseVersionCursor, type SessionStore, type StoredSessionChange, type TenantSessionRepository } from "./session-store.js";

interface StoredSession { session: SharedChatSession; resource: SessionResourceAttributes }

export class InMemorySessionStore implements SessionStore {
    private readonly sessionsByOrg = new Map<string, Map<string, StoredSession>>();
    private readonly changesByOrg = new Map<string, StoredSessionChange[]>();
    private readonly sequenceByOrg = new Map<string, number>();
    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    private sessions(org: string): Map<string, StoredSession> {
        let values = this.sessionsByOrg.get(org);
        if (!values) {
            values = new Map();
            this.sessionsByOrg.set(org, values);
        }
        return values;
    }
    private changes(org: string): StoredSessionChange[] {
        let values = this.changesByOrg.get(org);
        if (!values) {
            values = [];
            this.changesByOrg.set(org, values);
        }
        return values;
    }
    private next(org: string): string {
        const value = (this.sequenceByOrg.get(org) ?? 0) + 1;
        this.sequenceByOrg.set(org, value);
        return String(value);
    }

    forTenant(context: TenantContext): TenantSessionRepository {
        const org = context.organizationId;
        const repository: TenantSessionRepository = {
            context,
            getOne: async (id) => this.sessions(org).get(id) ?? null,
            readChanges: async (cursor) => {
                const since = parseVersionCursor(cursor);
                const highWater = String(this.sequenceByOrg.get(org) ?? 0);
                if (since === null) {
                    return {
                        changes: [...this.sessions(org).values()].map((entry) => ({
                            resource: entry.resource,
                            change: {
                                sequence: entry.session.version ?? "0",
                                kind: "upsert" as const,
                                sessionId: entry.session.id,
                                version: entry.session.version ?? "0",
                                changedAt: entry.session.updatedAt,
                                session: entry.session,
                            },
                        })),
                        cursor: highWater,
                    };
                }
                return { changes: this.changes(org).filter((entry) => BigInt(entry.change.sequence) > since), cursor: highWater };
            },
            writeOne: (session, expectedVersion, actor, resource) => this.writeBound(org, session, expectedVersion, actor, resource),
            deleteOne: (id, expectedVersion, actor) => this.deleteBound(org, id, expectedVersion, actor),
        };
        return Object.freeze(repository);
    }

    private async writeBound(org: string, session: SharedChatSession, expectedVersion: string | null, actor: AuditActor, resource: SessionResourceAttributes) {
        const existing = this.sessions(org).get(session.id);
        if ((existing?.session.version ?? null) !== expectedVersion) return { conflict: true as const, current: existing!.session };
        const version = this.next(org);
        const saved: SharedChatSession = { ...session, version };
        const stored = { session: saved, resource: { ...resource, organizationId: org, sessionId: saved.id } };
        this.sessions(org).set(saved.id, stored);
        const change: SessionChange = { sequence: version, kind: "upsert", sessionId: saved.id, version, changedAt: new Date().toISOString(), session: saved };
        this.changes(org).push({ change, resource: stored.resource });
        await this.auditStore.record({
            organizationId: org,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: expectedVersion === null ? "chatSession.create" : "chatSession.update",
            targetType: "chatSession",
            targetId: saved.id,
        });
        return { session: saved, version };
    }

    private async deleteBound(org: string, id: string, expectedVersion: string | null, actor: AuditActor) {
        const existing = this.sessions(org).get(id);
        if (!existing) return { notFound: true as const };
        if (existing.session.version !== expectedVersion) return { conflict: true as const, current: existing.session };
        const version = this.next(org);
        const tombstone: SessionChange = { sequence: version, kind: "delete", sessionId: id, version, changedAt: new Date().toISOString() };
        this.sessions(org).delete(id);
        this.changes(org).push({ change: tombstone, resource: existing.resource });
        await this.auditStore.record({
            organizationId: org,
            actorUserId: actor.userId,
            actorExternalSubject: actor.externalSubject,
            action: "chatSession.delete",
            targetType: "chatSession",
            targetId: id,
        });
        return { deleted: true as const, tombstone };
    }
}
