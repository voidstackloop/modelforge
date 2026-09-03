import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresHl7IngestionStore } from "./postgres-hl7-ingestion-store.js";

vi.mock("./audit-store.js", async () => {
    const actual = await vi.importActual<typeof import("./audit-store.js")>("./audit-store.js");
    return { ...actual, insertAuditEntry: vi.fn(async () => {}) };
});

const tenant = { organizationId: "11111111-1111-4111-8111-111111111111", schemaName: "tenant_11111111111141118111111111111111", issuer: "test", subject: "test" };

describe("PostgresHl7IngestionStore", () => {
    it("binds every query to the validated tenant schema", async () => {
        const queries: Array<{ text: string; values?: unknown[] }> = [];
        const now = new Date("2026-03-15T12:00:00Z");
        const pool = {
            query: vi.fn(async (text: string, values?: unknown[]) => {
                queries.push({ text, values });
                if (text.includes("INSERT INTO")) {
                    return {
                        rows: [{
                            id: "22222222-2222-4222-8222-222222222222", message_type: "ORU^R01", message_control_id: "MSG001",
                            raw_message: "MSH|...", received_at: now, patient_identifier_value: "MRN-001", patient_identifier_issuer: "TEST",
                            match_status: "matched", matched_case_id: "case-1", candidate_case_ids: null, status: "applied",
                            observations_added: 1, reviewed_by_user_id: null, reviewed_at: null, rejection_reason: null,
                            created_at: now, updated_at: now,
                        }],
                    };
                }
                return { rows: [] };
            }),
        } as unknown as Pool;

        const job = await new PostgresHl7IngestionStore(pool).forTenant(tenant).createJob(
            { messageType: "ORU^R01", messageControlId: "MSG001", rawMessage: "MSH|...", receivedAt: now.toISOString(), patientIdentifierValue: "MRN-001", patientIdentifierIssuer: "TEST", matchStatus: "matched", matchedCaseId: "case-1", status: "applied", observationsAdded: 1 },
            { externalSubject: "idp|system", userId: "user-1", organizationId: tenant.organizationId }
        );

        expect(job).toMatchObject({ messageType: "ORU^R01", matchedCaseId: "case-1", observationsAdded: 1 });
        expect(queries.some((q) => q.text.includes(tenant.schemaName) && q.text.includes(".hl7_ingestion_jobs"))).toBe(true);
    });

    it("rejects an untrusted dynamic schema identifier before querying", () => {
        const pool = { query: vi.fn() } as unknown as Pool;
        expect(() => new PostgresHl7IngestionStore(pool).forTenant({ ...tenant, schemaName: 'tenant_safe";DROP SCHEMA public;--' })).toThrow("Unsafe tenant schema identifier");
        expect(pool.query).not.toHaveBeenCalled();
    });
});
