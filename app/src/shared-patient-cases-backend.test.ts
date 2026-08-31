import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as secretsStore from "./secrets-store";
import { setSharedBackendConfig } from "./shared-backend-config-store";
import { SharedBackendUnavailableError, type PatientCase } from "./patient-cases-store";
import { createSharedPatientCasesBackend } from "./shared-patient-cases-backend";

// Seeds a valid, non-expiring access token directly via the same
// secrets-store key shared-backend-auth.ts uses internally (see that
// module's own test file for the same technique) — avoids mocking the auth
// module's OIDC discovery/refresh logic, which is already covered by
// shared-backend-auth.test.ts.
const TOKENS_KEY = "shared_backend_tokens";
function seedValidToken(): void {
    secretsStore.setSecret(TOKENS_KEY, JSON.stringify({ accessToken: "test-token", expiresAt: Date.now() + 60 * 60_000 }));
}

const CONFIG = { baseUrl: "https://iam.example-hospital.test", issuer: "https://idp.example-hospital.test", clientId: "x", organizationId: "org-1" };

function mockFetchOnce(response: { status: number; json?: unknown }) {
    const fn = vi.fn().mockResolvedValue({
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: () => Promise.resolve(response.json),
    });
    vi.stubGlobal("fetch", fn);
    return fn;
}

function syntheticCase(id: string, overrides?: Partial<PatientCase>): PatientCase {
    return {
        id,
        title: "Synthetic case",
        demographics: { value: {}, includeInContext: false },
        presentingComplaint: { value: "", includeInContext: false },
        symptomsTimeline: { value: "", includeInContext: false },
        vitalSigns: { value: "", includeInContext: false },
        conditions: { value: [], includeInContext: false },
        allergies: { value: [], includeInContext: false },
        medications: { value: [], includeInContext: false },
        labResults: { value: [], includeInContext: false },
        imagingAndReports: { value: "", includeInContext: false },
        clinicalNotes: [],
        attachments: [],
        consentRecords: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("shared-patient-cases-backend", () => {
    beforeEach(() => {
        secretsStore.setSecret(TOKENS_KEY, "");
        setSharedBackendConfig(null);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("declares itself unavailable with no config, and with a config but no organization selected", () => {
        const backend = createSharedPatientCasesBackend();
        expect(backend.isAvailable!()).toBe(false);

        setSharedBackendConfig({ baseUrl: "https://x", issuer: "https://y", clientId: "z" });
        expect(backend.isAvailable!()).toBe(false);
    });

    it("declares itself available only when configured, scoped to an organization, and authenticated", () => {
        setSharedBackendConfig(CONFIG);
        expect(createSharedPatientCasesBackend().isAvailable!()).toBe(false);
        seedValidToken();
        expect(createSharedPatientCasesBackend().isAvailable!()).toBe(true);
    });

    it("readSince throws SharedBackendUnavailableError with no config, before any fetch", async () => {
        const backend = createSharedPatientCasesBackend();
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(backend.readSince!(null)).rejects.toBeInstanceOf(SharedBackendUnavailableError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("readSince throws SharedBackendUnavailableError when configured but not connected (no token)", async () => {
        setSharedBackendConfig(CONFIG);
        const backend = createSharedPatientCasesBackend();
        await expect(backend.readSince!(null)).rejects.toBeInstanceOf(SharedBackendUnavailableError);
    });

    it("readSince calls GET /organizations/:id/cases with the bearer token and returns cases+cursor", async () => {
        setSharedBackendConfig(CONFIG);
        seedValidToken();
        const fetchMock = mockFetchOnce({ status: 200, json: { cases: [syntheticCase("case-1")], cursor: "5" } });

        const result = await createSharedPatientCasesBackend().readSince!(null);
        expect(result.cases.map((c) => c.id)).toEqual(["case-1"]);
        expect(result.cursor).toBe("5");
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://iam.example-hospital.test/organizations/org-1/cases");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    });

    it("readSince appends ?since= when a cursor is given", async () => {
        setSharedBackendConfig(CONFIG);
        seedValidToken();
        const fetchMock = mockFetchOnce({ status: 200, json: { cases: [], cursor: "6" } });
        await createSharedPatientCasesBackend().readSince!("5");
        expect(fetchMock.mock.calls[0][0]).toBe("https://iam.example-hospital.test/organizations/org-1/cases?since=5");
    });

    it("readAll delegates to readSince(null)", async () => {
        setSharedBackendConfig(CONFIG);
        seedValidToken();
        mockFetchOnce({ status: 200, json: { cases: [syntheticCase("case-x")], cursor: "1" } });
        const result = await createSharedPatientCasesBackend().readAll();
        expect(result.map((c) => c.id)).toEqual(["case-x"]);
    });

    it("readSince throws SharedBackendUnavailableError on a non-ok response, never an empty array", async () => {
        setSharedBackendConfig(CONFIG);
        seedValidToken();
        mockFetchOnce({ status: 500, json: { error: "internal_error" } });
        await expect(createSharedPatientCasesBackend().readSince!(null)).rejects.toBeInstanceOf(SharedBackendUnavailableError);
    });

    it("readSince throws SharedBackendUnavailableError when fetch itself rejects (network failure)", async () => {
        setSharedBackendConfig(CONFIG);
        seedValidToken();
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
        await expect(createSharedPatientCasesBackend().readSince!(null)).rejects.toBeInstanceOf(SharedBackendUnavailableError);
    });

    it("refuses to send the bearer token — and real clinical case data — to a non-HTTPS, non-loopback baseUrl", async () => {
        // shared-backend-config-store.ts's schema only checks baseUrl is a
        // non-empty string — a compromised renderer could otherwise point
        // this at an attacker-controlled origin via sharedBackend:setConfig
        // and have every case read/write/delete's bearer token (and, for a
        // write, the clinical payload itself) sent straight to it.
        setSharedBackendConfig({ ...CONFIG, baseUrl: "http://attacker.example.com" });
        seedValidToken();
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const backend = createSharedPatientCasesBackend();
        await expect(backend.readSince!(null)).rejects.toBeInstanceOf(SharedBackendUnavailableError);
        await expect(backend.writeOne!(syntheticCase("case-x"), null)).rejects.toBeInstanceOf(SharedBackendUnavailableError);
        await expect(backend.deleteOne!("case-x", null)).rejects.toBeInstanceOf(SharedBackendUnavailableError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    describe("writeOne", () => {
        it("POSTs when expectedVersion is null (create) and returns the accepted case + version", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            const created = syntheticCase("case-new", { version: "1" });
            const fetchMock = mockFetchOnce({ status: 201, json: created });

            const result = await createSharedPatientCasesBackend().writeOne!(syntheticCase("case-new"), null);
            expect("conflict" in result).toBe(false);
            if (!("conflict" in result)) {
                expect(result.version).toBe("1");
            }
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://iam.example-hospital.test/organizations/org-1/cases");
            expect(init.method).toBe("POST");
        });

        it("PUTs with If-Match when expectedVersion is set", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            const fetchMock = mockFetchOnce({ status: 200, json: syntheticCase("case-1", { version: "2" }) });

            await createSharedPatientCasesBackend().writeOne!(syntheticCase("case-1"), "1");
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://iam.example-hospital.test/organizations/org-1/cases/case-1");
            expect(init.method).toBe("PUT");
            expect((init.headers as Record<string, string>)["If-Match"]).toBe("1");
        });

        it("returns { conflict: true, current } on 409 (create-collision) without throwing", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            const current = syntheticCase("case-1", { version: "3" });
            mockFetchOnce({ status: 409, json: { current } });

            const result = await createSharedPatientCasesBackend().writeOne!(syntheticCase("case-1"), null);
            expect("conflict" in result && result.conflict).toBe(true);
            if ("conflict" in result) expect(result.current.version).toBe("3");
        });

        it("returns { conflict: true, current } on 412 (stale If-Match) without throwing", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            const current = syntheticCase("case-1", { version: "9" });
            mockFetchOnce({ status: 412, json: { current } });

            const result = await createSharedPatientCasesBackend().writeOne!(syntheticCase("case-1"), "1");
            expect("conflict" in result && result.conflict).toBe(true);
        });

        it("throws SharedBackendUnavailableError on any other non-ok response", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            mockFetchOnce({ status: 403, json: { message: "Not authorized to perform this action." } });
            await expect(createSharedPatientCasesBackend().writeOne!(syntheticCase("case-1"), "1")).rejects.toBeInstanceOf(
                SharedBackendUnavailableError
            );
        });
    });

    describe("deleteOne", () => {
        it("DELETEs with If-Match and returns { deleted: true } on success", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            const fetchMock = mockFetchOnce({ status: 204 });

            const result = await createSharedPatientCasesBackend().deleteOne!("case-1", "2");
            expect(result).toEqual({ deleted: true });
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://iam.example-hospital.test/organizations/org-1/cases/case-1");
            expect(init.method).toBe("DELETE");
            expect((init.headers as Record<string, string>)["If-Match"]).toBe("2");
        });

        it("returns { conflict: true, current } on 412", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            const current = syntheticCase("case-1", { version: "9" });
            mockFetchOnce({ status: 412, json: { current } });

            const result = await createSharedPatientCasesBackend().deleteOne!("case-1", "1");
            expect("conflict" in result && result.conflict).toBe(true);
        });

        it("treats a 404 as idempotent success rather than an error", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            mockFetchOnce({ status: 404, json: { error: "not_found" } });
            const result = await createSharedPatientCasesBackend().deleteOne!("case-1", "1");
            expect(result).toEqual({ deleted: true });
        });
    });
});
