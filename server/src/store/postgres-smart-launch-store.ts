import { randomUUID } from "node:crypto";
import type { SmartTrustedIssuer } from "@modelforge/contracts";
import type { Pool } from "pg";
import type { TenantContext } from "../tenant-context.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import type { CreateLaunchSessionInput, CreateTokenInput, InternalSmartLaunchSession, InternalSmartLaunchToken, SmartLaunchStore, TenantSmartLaunchRepository } from "./smart-launch-store.js";

type Row = Record<string, unknown>;
function schemaName(value: string): string {
    if (!/^tenant_[a-f0-9]{32}$/.test(value)) throw new Error("Unsafe tenant schema identifier.");
    return `"${value}"`;
}

function mapIssuerRow(r: Row): SmartTrustedIssuer {
    return { id: r.id as string, issuer: r.issuer as string, clientId: r.client_id as string, redirectUris: r.redirect_uris as string[], addedByUserId: r.added_by_user_id as string, createdAt: (r.created_at as Date).toISOString() };
}

function mapSessionRow(r: Row): InternalSmartLaunchSession {
    return {
        id: r.state as string, issuer: r.issuer as string, requestedByUserId: r.requested_by_user_id as string, scope: r.scope as string,
        status: r.status as InternalSmartLaunchSession["status"], createdAt: (r.created_at as Date).toISOString(), expiresAt: (r.expires_at as Date).toISOString(),
        codeVerifier: r.code_verifier as string, redirectUri: r.redirect_uri as string, launch: (r.launch as string | null) ?? undefined,
    };
}

function mapTokenRow(r: Row): InternalSmartLaunchToken {
    return {
        id: r.id as string, issuer: r.issuer as string, requestedByUserId: r.requested_by_user_id as string, scope: r.scope as string,
        patientId: (r.patient_id as string | null) ?? undefined, hasRefreshToken: r.encrypted_refresh_token !== null,
        expiresAt: (r.expires_at as Date).toISOString(), createdAt: (r.created_at as Date).toISOString(),
        encryptedAccessToken: r.encrypted_access_token as string, encryptedRefreshToken: (r.encrypted_refresh_token as string | null) ?? undefined,
    };
}

/** Postgres-backed SMART App Launch store — schema-per-tenant, migration
 * `026_smart_launch.sql`. Not run against a real Postgres instance in the
 * environment this was built in — same disclosed limitation as every other
 * postgres-*.ts store in this package. */
export class PostgresSmartLaunchStore implements SmartLaunchStore {
    constructor(private readonly pool: Pool) {}

    forTenant(context: TenantContext): TenantSmartLaunchRepository {
        const pool = this.pool;
        const organizationId = context.organizationId;
        const schema = schemaName(context.schemaName);

        return {
            context,

            async upsertTrustedIssuer(input, actor: AuditActor) {
                const result = await pool.query(
                    `INSERT INTO ${schema}.smart_trusted_issuers (id, issuer, client_id, redirect_uris, added_by_user_id, created_at)
                     VALUES ($1,$2,$3,$4,$5, now())
                     ON CONFLICT (issuer) DO UPDATE SET client_id = EXCLUDED.client_id, redirect_uris = EXCLUDED.redirect_uris, added_by_user_id = EXCLUDED.added_by_user_id
                     RETURNING *`,
                    [randomUUID(), input.issuer, input.clientId, input.redirectUris, input.addedByUserId]
                );
                const value = mapIssuerRow(result.rows[0]);
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartTrustedIssuer.upsert", targetType: "smartTrustedIssuer", targetId: value.id, details: { issuer: input.issuer } });
                return value;
            },

            async getTrustedIssuer(issuer) {
                const r = await pool.query(`SELECT * FROM ${schema}.smart_trusted_issuers WHERE issuer = $1`, [issuer]);
                return r.rows[0] ? mapIssuerRow(r.rows[0]) : null;
            },

            async listTrustedIssuers() {
                const r = await pool.query(`SELECT * FROM ${schema}.smart_trusted_issuers ORDER BY created_at DESC`);
                return r.rows.map(mapIssuerRow);
            },

            async deleteTrustedIssuer(issuer, actor: AuditActor) {
                const r = await pool.query(`DELETE FROM ${schema}.smart_trusted_issuers WHERE issuer = $1 RETURNING id`, [issuer]);
                if (!r.rows[0]) return false;
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartTrustedIssuer.delete", targetType: "smartTrustedIssuer", targetId: r.rows[0].id as string, details: { issuer } });
                return true;
            },

            async createLaunchSession(stateKey: string, input: CreateLaunchSessionInput, actor: AuditActor) {
                const result = await pool.query(
                    `INSERT INTO ${schema}.smart_launch_sessions (state, issuer, requested_by_user_id, scope, status, code_verifier, redirect_uri, launch, created_at, expires_at)
                     VALUES ($1,$2,$3,$4,'pending',$5,$6,$7, now(), $8) RETURNING *`,
                    [stateKey, input.issuer, input.requestedByUserId, input.scope, input.codeVerifier, input.redirectUri, input.launch ?? null, new Date(input.expiresAt)]
                );
                const value = mapSessionRow(result.rows[0]);
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartLaunchSession.create", targetType: "smartLaunchSession", targetId: stateKey, details: { issuer: input.issuer } });
                return value;
            },

            async getLaunchSession(stateKey) {
                const r = await pool.query(`SELECT * FROM ${schema}.smart_launch_sessions WHERE state = $1`, [stateKey]);
                return r.rows[0] ? mapSessionRow(r.rows[0]) : null;
            },

            async completeLaunchSession(stateKey: string, actor: AuditActor) {
                const r = await pool.query(`UPDATE ${schema}.smart_launch_sessions SET status = 'completed' WHERE state = $1 AND status = 'pending' RETURNING *`, [stateKey]);
                if (!r.rows[0]) return null;
                const value = mapSessionRow(r.rows[0]);
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartLaunchSession.complete", targetType: "smartLaunchSession", targetId: stateKey, details: {} });
                return value;
            },

            async createToken(input: CreateTokenInput, actor: AuditActor) {
                const id = randomUUID();
                const result = await pool.query(
                    `INSERT INTO ${schema}.smart_launch_tokens (id, issuer, requested_by_user_id, scope, patient_id, encrypted_access_token, encrypted_refresh_token, created_at, expires_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8) RETURNING *`,
                    [id, input.issuer, input.requestedByUserId, input.scope, input.patientId ?? null, input.encryptedAccessToken, input.encryptedRefreshToken ?? null, new Date(input.expiresAt)]
                );
                const value = mapTokenRow(result.rows[0]);
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartLaunchToken.create", targetType: "smartLaunchToken", targetId: id, details: { issuer: input.issuer, hasPatientContext: input.patientId !== undefined } });
                return value;
            },

            async getToken(id) {
                const r = await pool.query(`SELECT * FROM ${schema}.smart_launch_tokens WHERE id = $1`, [id]);
                return r.rows[0] ? mapTokenRow(r.rows[0]) : null;
            },

            async listTokensForUser(userId) {
                const r = await pool.query(`SELECT * FROM ${schema}.smart_launch_tokens WHERE requested_by_user_id = $1 ORDER BY created_at DESC`, [userId]);
                return r.rows.map((row) => {
                    const { encryptedAccessToken: _a, encryptedRefreshToken: _r, ...rest } = mapTokenRow(row);
                    return rest;
                });
            },

            async deleteToken(id, actor: AuditActor) {
                const r = await pool.query(`DELETE FROM ${schema}.smart_launch_tokens WHERE id = $1 RETURNING id`, [id]);
                if (!r.rows[0]) return false;
                await insertAuditEntry(pool, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "smartLaunchToken.delete", targetType: "smartLaunchToken", targetId: id, details: {} });
                return true;
            },
        };
    }
}
