import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresSmartLaunchStore } from "./postgres-smart-launch-store.js";

vi.mock("./audit-store.js", async () => {
    const actual = await vi.importActual<typeof import("./audit-store.js")>("./audit-store.js");
    return { ...actual, insertAuditEntry: vi.fn(async () => {}) };
});

const tenant = { organizationId: "11111111-1111-4111-8111-111111111111", schemaName: "tenant_11111111111141118111111111111111", issuer: "test", subject: "test" };

describe("PostgresSmartLaunchStore", () => {
    it("binds every query to the validated tenant schema", async () => {
        const queries: Array<{ text: string; values?: unknown[] }> = [];
        const now = new Date("2026-03-15T12:00:00Z");
        const pool = {
            query: vi.fn(async (text: string, values?: unknown[]) => {
                queries.push({ text, values });
                if (text.includes("INSERT INTO")) {
                    return {
                        rows: [{
                            id: "22222222-2222-4222-8222-222222222222", issuer: "https://ehr.example.test/fhir", client_id: "modelforge-client",
                            redirect_uris: ["https://modelforge.example.test/callback"], added_by_user_id: "33333333-3333-4333-8333-333333333333", created_at: now,
                        }],
                    };
                }
                return { rows: [] };
            }),
        } as unknown as Pool;

        const issuer = await new PostgresSmartLaunchStore(pool).forTenant(tenant).upsertTrustedIssuer(
            { issuer: "https://ehr.example.test/fhir", clientId: "modelforge-client", redirectUris: ["https://modelforge.example.test/callback"], addedByUserId: "33333333-3333-4333-8333-333333333333" },
            { externalSubject: "idp|admin", userId: "user-1", organizationId: tenant.organizationId }
        );

        expect(issuer).toMatchObject({ issuer: "https://ehr.example.test/fhir", clientId: "modelforge-client" });
        expect(queries.some((q) => q.text.includes(tenant.schemaName) && q.text.includes(".smart_trusted_issuers"))).toBe(true);
    });

    it("rejects an untrusted dynamic schema identifier before querying", () => {
        const pool = { query: vi.fn() } as unknown as Pool;
        expect(() => new PostgresSmartLaunchStore(pool).forTenant({ ...tenant, schemaName: 'tenant_safe";DROP SCHEMA public;--' })).toThrow("Unsafe tenant schema identifier");
        expect(pool.query).not.toHaveBeenCalled();
    });
});
