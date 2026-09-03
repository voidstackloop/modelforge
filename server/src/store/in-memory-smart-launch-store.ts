import { randomUUID } from "node:crypto";
import type { SmartTrustedIssuer } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";
import type { CreateLaunchSessionInput, CreateTokenInput, InternalSmartLaunchSession, InternalSmartLaunchToken, SmartLaunchStore, TenantSmartLaunchRepository } from "./smart-launch-store.js";

interface OrgState {
    trustedIssuers: Map<string, SmartTrustedIssuer>; // keyed by issuer URL
    launchSessions: Map<string, InternalSmartLaunchSession>; // keyed by state
    tokens: Map<string, InternalSmartLaunchToken>;
}

function emptyOrgState(): OrgState {
    return { trustedIssuers: new Map(), launchSessions: new Map(), tokens: new Map() };
}

export class InMemorySmartLaunchStore implements SmartLaunchStore {
    private readonly orgs = new Map<string, OrgState>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    private stateFor(organizationId: string): OrgState {
        let state = this.orgs.get(organizationId);
        if (!state) {
            state = emptyOrgState();
            this.orgs.set(organizationId, state);
        }
        return state;
    }

    forTenant(context: TenantContext): TenantSmartLaunchRepository {
        const state = this.stateFor(context.organizationId);
        const auditStore = this.auditStore;
        const organizationId = context.organizationId;

        const repository: TenantSmartLaunchRepository = {
            context,

            async upsertTrustedIssuer(input: Omit<SmartTrustedIssuer, "id" | "createdAt">, actor: AuditActor) {
                const existing = state.trustedIssuers.get(input.issuer);
                const value: SmartTrustedIssuer = { id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? new Date().toISOString(), ...input };
                state.trustedIssuers.set(input.issuer, value);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartTrustedIssuer.upsert", targetType: "smartTrustedIssuer", targetId: value.id, details: { issuer: input.issuer } });
                return value;
            },

            async getTrustedIssuer(issuer) {
                return state.trustedIssuers.get(issuer) ?? null;
            },

            async listTrustedIssuers() {
                return [...state.trustedIssuers.values()];
            },

            async deleteTrustedIssuer(issuer, actor: AuditActor) {
                const existing = state.trustedIssuers.get(issuer);
                if (!existing) return false;
                state.trustedIssuers.delete(issuer);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartTrustedIssuer.delete", targetType: "smartTrustedIssuer", targetId: existing.id, details: { issuer } });
                return true;
            },

            async createLaunchSession(stateKey: string, input: CreateLaunchSessionInput, actor: AuditActor) {
                const now = new Date().toISOString();
                const session: InternalSmartLaunchSession = {
                    id: stateKey, issuer: input.issuer, requestedByUserId: input.requestedByUserId, scope: input.scope,
                    status: "pending", createdAt: now, expiresAt: input.expiresAt,
                    codeVerifier: input.codeVerifier, redirectUri: input.redirectUri, launch: input.launch,
                };
                state.launchSessions.set(stateKey, session);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartLaunchSession.create", targetType: "smartLaunchSession", targetId: stateKey, details: { issuer: input.issuer } });
                return session;
            },

            async getLaunchSession(stateKey) {
                return state.launchSessions.get(stateKey) ?? null;
            },

            async completeLaunchSession(stateKey: string, actor: AuditActor) {
                const existing = state.launchSessions.get(stateKey);
                if (!existing || existing.status !== "pending") return null;
                const updated: InternalSmartLaunchSession = { ...existing, status: "completed" };
                state.launchSessions.set(stateKey, updated);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartLaunchSession.complete", targetType: "smartLaunchSession", targetId: stateKey, details: {} });
                return updated;
            },

            async createToken(input: CreateTokenInput, actor: AuditActor) {
                const id = randomUUID();
                const now = new Date().toISOString();
                const token: InternalSmartLaunchToken = {
                    id, issuer: input.issuer, requestedByUserId: input.requestedByUserId, scope: input.scope,
                    patientId: input.patientId, hasRefreshToken: input.encryptedRefreshToken !== undefined,
                    expiresAt: input.expiresAt, createdAt: now,
                    encryptedAccessToken: input.encryptedAccessToken, encryptedRefreshToken: input.encryptedRefreshToken,
                };
                state.tokens.set(id, token);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartLaunchToken.create", targetType: "smartLaunchToken", targetId: id, details: { issuer: input.issuer, hasPatientContext: input.patientId !== undefined } });
                return token;
            },

            async getToken(id) {
                return state.tokens.get(id) ?? null;
            },

            async listTokensForUser(userId) {
                return [...state.tokens.values()]
                    .filter((t) => t.requestedByUserId === userId)
                    .map(({ encryptedAccessToken: _a, encryptedRefreshToken: _r, ...rest }) => rest);
            },

            async deleteToken(id, actor: AuditActor) {
                const existing = state.tokens.get(id);
                if (!existing) return false;
                state.tokens.delete(id);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartLaunchToken.delete", targetType: "smartLaunchToken", targetId: id, details: {} });
                return true;
            },
        };
        return repository;
    }
}
