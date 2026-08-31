import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const mockRemoveUser = vi.fn();

vi.mock("../auth/oidc-config", () => ({
    userManager: {
        getUser: (...args: unknown[]) => mockGetUser(...args),
        removeUser: (...args: unknown[]) => mockRemoveUser(...args),
    },
}));

// Imported after the mock above so client.ts's top-level `import { userManager }`
// resolves to the mock, not a real UserManager (which would otherwise try to
// construct itself from empty VITE_OIDC_* env vars in this test environment).
const {
    ApiError,
    getMe,
    createUser,
    deletePolicy,
    listUsers,
    invokeBreakGlass,
    createAccessReviewCampaign,
    decideAccessReviewItem,
    setBreakGlassPolicy,
    proposePolicyVersion,
    approvePolicyVersion,
    rejectPolicyVersion,
    rollbackPolicy,
    listAudit,
    exportAudit,
    placeAuditLegalHold,
    releaseAuditLegalHold,
    exportTenantBackup,
    proposeTenantRestore,
    approveTenantRestore,
    rejectTenantRestore,
    listMcpRegistryEntries,
    createMcpRegistryEntry,
    updateMcpRegistryEntry,
    setMcpRegistryEntryStatus,
    getComputeQuota,
    setComputeQuota,
    listComputePoliciesForPool,
    createComputePolicy,
    activateComputePolicy,
} = await import("./client");

function jsonResponse(status: number, body: unknown): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("api/client", () => {
    const VALID_USER = { access_token: "token-123", expired: false };

    beforeEach(() => {
        mockGetUser.mockReset();
        mockRemoveUser.mockReset();
        mockGetUser.mockResolvedValue(VALID_USER);
        vi.stubGlobal("fetch", vi.fn());
        // This project's tests run in vitest's default node environment
        // (no jsdom — see the rest of this codebase's test files, all pure
        // logic), so `window` isn't a real global here. client.ts's
        // onUnauthorized() only ever touches `window.location.hash`, so a
        // minimal stub of exactly that is enough, without pulling in a
        // full DOM emulation library for one field.
        vi.stubGlobal("window", { location: { hash: "" } });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("attaches the bearer token and issues a GET for /me", async () => {
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { subject: "sub-1", memberships: [] }));
        const result = await getMe();
        expect(result).toEqual({ subject: "sub-1", memberships: [] });

        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(String(url)).toContain("/me");
        expect(init?.method).toBeUndefined(); // default GET
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token-123");
    });

    it("never sends Content-Type: application/json on a bodyless POST — a real Fastify server 400s an empty body declared as JSON", async () => {
        // Regression test: caught by an actual browser session against a
        // real server, not by any test that existed before this one — every
        // mock in this file resolves regardless of what headers were sent,
        // so this specific bug (activateComputePolicy, and every other
        // bodyless POST helper in this file, all silently 400ing in
        // production) had no test coverage at all until now.
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "campaign-1" }));
        await createAccessReviewCampaign("org-1");
        const [, init] = vi.mocked(fetch).mock.calls[0];
        expect(init?.body).toBeUndefined();
        expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    });

    it("sends the correct method, path, and JSON body for a POST endpoint", async () => {
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { id: "u1", organizationId: "org-1" }));
        await createUser("org-1", { externalSubject: "idp|new", displayName: "New User" });

        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(String(url)).toContain("/organizations/org-1/users");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toEqual({ externalSubject: "idp|new", displayName: "New User" });
    });

    it("returns undefined for a 204 response without ever calling response.json()", async () => {
        const response = jsonResponse(204, undefined);
        const jsonSpy = vi.spyOn(response, "json");
        vi.mocked(fetch).mockResolvedValueOnce(response);

        const result = await deletePolicy("org-1", "policy-1");
        expect(result).toBeUndefined();
        expect(jsonSpy).not.toHaveBeenCalled();
    });

    it("maps a non-2xx response to a typed ApiError carrying the parsed body", async () => {
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(403, { error: "authorization_error", message: "Not allowed." }));
        await expect(listUsers("org-1")).rejects.toMatchObject({
            status: 403,
            body: { error: "authorization_error", message: "Not allowed." },
            message: "Not allowed.",
        });
    });

    it("a 401 clears the session and redirects to login without ever issuing the request's own error body as the reason", async () => {
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, { error: "invalid_bearer_token" }));
        await expect(listUsers("org-1")).rejects.toThrow(/session has expired/i);
        expect(mockRemoveUser).toHaveBeenCalledOnce();
        expect(window.location.hash).toBe("#/login");
    });

    it("treats an already-expired cached user the same as a 401 — never sends the stale token", async () => {
        mockGetUser.mockResolvedValueOnce({ access_token: "stale", expired: true });
        await expect(listUsers("org-1")).rejects.toBeInstanceOf(ApiError);
        expect(fetch).not.toHaveBeenCalled();
        expect(mockRemoveUser).toHaveBeenCalledOnce();
    });

    it("a network failure (fetch itself rejects) becomes a descriptive ApiError, not an unhandled rejection", async () => {
        vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
        await expect(getMe()).rejects.toMatchObject({ status: 0, message: expect.stringContaining("Could not reach the admin API") });
    });

    describe("break-glass and access reviews", () => {
        it("invokeBreakGlass posts the justification to the invoke endpoint", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { id: "grant-1", status: "active" }));
            await invokeBreakGlass("org-1", { justification: "Emergency, need chart access." });

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/break-glass/invoke");
            expect(init?.method).toBe("POST");
            expect(JSON.parse(init?.body as string)).toEqual({ justification: "Emergency, need chart access." });
        });

        it("decideAccessReviewItem builds the correct nested path and body", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "item-1", decision: "revoke" }));
            await decideAccessReviewItem("org-1", "campaign-1", "item-1", { decision: "revoke" });

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/access-reviews/campaign-1/items/item-1/decide");
            expect(JSON.parse(init?.body as string)).toEqual({ decision: "revoke" });
        });

        it("setBreakGlassPolicy sends null to unset the emergency policy", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, null));
            const result = await setBreakGlassPolicy("org-1", { policyId: null });

            expect(result).toBeNull();
            const [, init] = vi.mocked(fetch).mock.calls[0];
            expect(init?.method).toBe("PUT");
            expect(JSON.parse(init?.body as string)).toEqual({ policyId: null });
        });
    });

    describe("policy versioning, dual-control approval, and rollback", () => {
        it("proposePolicyVersion posts the document to the versions endpoint", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { id: "v1", status: "pending" }));
            const document = { version: "2026-01-01" as const, statements: [] };
            await proposePolicyVersion("org-1", "policy-1", { document });

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/policies/policy-1/versions");
            expect(init?.method).toBe("POST");
            expect(JSON.parse(init?.body as string)).toEqual({ document });
        });

        it("approvePolicyVersion posts to the nested approve endpoint with no body", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "v1", status: "approved" }));
            await approvePolicyVersion("org-1", "policy-1", "v1");

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/policies/policy-1/versions/v1/approve");
            expect(init?.method).toBe("POST");
            expect(init?.body).toBeUndefined();
        });

        it("rejectPolicyVersion posts the optional reason to the nested reject endpoint", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "v1", status: "rejected" }));
            await rejectPolicyVersion("org-1", "policy-1", "v1", { reason: "Too broad." });

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/policies/policy-1/versions/v1/reject");
            expect(JSON.parse(init?.body as string)).toEqual({ reason: "Too broad." });
        });

        it("rollbackPolicy posts the target versionId to the rollback endpoint", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "v1", status: "approved" }));
            await rollbackPolicy("org-1", "policy-1", { versionId: "v1" });

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/policies/policy-1/rollback");
            expect(JSON.parse(init?.body as string)).toEqual({ versionId: "v1" });
        });
    });

    describe("audit search, export, and legal hold", () => {
        it("listAudit with no filters sends no query string at all — preserving the full-history contract", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, []));
            await listAudit("org-1");

            const [url] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/audit");
            expect(String(url)).not.toContain("?");
        });

        it("listAudit serializes only the filters that have values, skipping empty ones", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, []));
            await listAudit("org-1", { action: "policy.create", targetId: "", cursor: "42", limit: 200 });

            const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]), "https://example.test");
            expect(url.searchParams.get("action")).toBe("policy.create");
            expect(url.searchParams.get("cursor")).toBe("42");
            expect(url.searchParams.get("limit")).toBe("200");
            expect(url.searchParams.has("targetId")).toBe(false);
        });

        it("exportAudit returns the raw Blob rather than parsing it as JSON", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(new Response("sequence,createdAt\r\n1,now\r\n", { status: 200, headers: { "Content-Type": "text/csv" } }));
            const blob = await exportAudit("org-1", { action: "policy.create" });

            expect(await blob.text()).toContain("sequence,createdAt");
            expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/organizations/org-1/audit/export");
        });

        it("exportAudit surfaces a non-2xx as a typed ApiError instead of returning a Blob of the error body", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(403, { error: "authorization_error", message: "Not allowed." }));
            await expect(exportAudit("org-1")).rejects.toBeInstanceOf(ApiError);
        });

        it("placeAuditLegalHold and releaseAuditLegalHold post to the right nested paths", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { id: "hold-1", status: "active" }));
            await placeAuditLegalHold("org-1", { reason: "Litigation." });
            expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/organizations/org-1/audit/legal-holds");

            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "hold-1", status: "released" }));
            await releaseAuditLegalHold("org-1", "hold-1", { releaseReason: "Resolved." });
            const [url, init] = vi.mocked(fetch).mock.calls[1];
            expect(String(url)).toContain("/organizations/org-1/audit/legal-holds/hold-1/release");
            expect(JSON.parse(init?.body as string)).toEqual({ releaseReason: "Resolved." });
        });
    });

    describe("tenant backup export and dual-control restore", () => {
        it("exportTenantBackup returns the raw Blob rather than parsing it as JSON", async () => {
            const artifact = { organizationId: "org-1", exportedAt: "2026-01-01T00:00:00.000Z", tables: {} };
            vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(artifact), { status: 200, headers: { "Content-Type": "application/json" } }));
            const blob = await exportTenantBackup("org-1");

            expect(JSON.parse(await blob.text())).toEqual(artifact);
            expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/organizations/org-1/backup/export");
        });

        it("exportTenantBackup surfaces a non-2xx as a typed ApiError instead of returning a Blob of the error body", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(403, { error: "authorization_error", message: "Not allowed." }));
            await expect(exportTenantBackup("org-1")).rejects.toBeInstanceOf(ApiError);
        });

        it("proposeTenantRestore posts the artifact to the restore-requests endpoint", async () => {
            const artifact = { organizationId: "org-1", exportedAt: "2026-01-01T00:00:00.000Z", tables: {} };
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { id: "req-1", status: "pending" }));
            await proposeTenantRestore("org-1", { artifact });

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/backup/restore-requests");
            expect(JSON.parse(init?.body as string)).toEqual({ artifact });
        });

        it("approveTenantRestore and rejectTenantRestore post to the right nested paths", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "req-1", status: "completed" }));
            await approveTenantRestore("org-1", "req-1");
            const [approveUrl, approveInit] = vi.mocked(fetch).mock.calls[0];
            expect(String(approveUrl)).toContain("/organizations/org-1/backup/restore-requests/req-1/approve");
            expect(approveInit?.body).toBeUndefined();

            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "req-2", status: "rejected" }));
            await rejectTenantRestore("org-1", "req-2", { reason: "Not needed." });
            const [rejectUrl, rejectInit] = vi.mocked(fetch).mock.calls[1];
            expect(String(rejectUrl)).toContain("/organizations/org-1/backup/restore-requests/req-2/reject");
            expect(JSON.parse(rejectInit?.body as string)).toEqual({ reason: "Not needed." });
        });
    });

    describe("institutional MCP registry", () => {
        const body = {
            name: "Clinical tools",
            transport: "http" as const,
            endpoint: "https://mcp.example.test/api",
            allowedTools: ["lookup"],
            dataEgressPolicy: "metadata-only" as const,
        };

        it("lists and creates organization-scoped entries", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, []));
            await listMcpRegistryEntries("org-1");
            expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/organizations/org-1/mcp-registry");

            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { id: "entry-1", ...body }));
            await createMcpRegistryEntry("org-1", body);
            const [url, init] = vi.mocked(fetch).mock.calls[1];
            expect(String(url)).toContain("/organizations/org-1/mcp-registry");
            expect(init?.method).toBe("POST");
            expect(JSON.parse(init?.body as string)).toEqual(body);
        });

        it("updates an entry and changes status through the exact nested routes", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "entry-1", ...body, name: "Updated" }));
            await updateMcpRegistryEntry("org-1", "entry-1", { name: "Updated" });
            const [updateUrl, updateInit] = vi.mocked(fetch).mock.calls[0];
            expect(String(updateUrl)).toContain("/organizations/org-1/mcp-registry/entry-1");
            expect(updateInit?.method).toBe("PATCH");

            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "entry-1", ...body, status: "disabled" }));
            await setMcpRegistryEntryStatus("org-1", "entry-1", "disabled");
            const [statusUrl, statusInit] = vi.mocked(fetch).mock.calls[1];
            expect(String(statusUrl)).toContain("/organizations/org-1/mcp-registry/entry-1/status");
            expect(statusInit?.method).toBe("POST");
            expect(JSON.parse(statusInit?.body as string)).toEqual({ status: "disabled" });
        });
    });

    describe("compute fleet quota", () => {
        const quotaBody = { poolId: "pool-1", reservedCpuThreads: 4, reservedRamMB: 8_192, reservedAccelerators: 1, burstCpuThreads: 16, burstRamMB: 32_768, burstAccelerators: 2, weight: 2, borrowingEnabled: true };

        it("returns null, not an error, when a pool has no quota configured yet", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(404, { error: "not_found" }));
            await expect(getComputeQuota("org-1", "pool-1")).resolves.toBeNull();
        });

        it("returns the parsed quota when one exists", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, quotaBody));
            await expect(getComputeQuota("org-1", "pool-1")).resolves.toEqual(quotaBody);
            expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/organizations/org-1/compute/pools/pool-1/quota");
        });

        it("PUTs a quota update to the pool-scoped endpoint", async () => {
            const { poolId: _poolId, ...request } = quotaBody;
            void _poolId; // destructured only to exclude it from `request` below
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, quotaBody));
            await setComputeQuota("org-1", "pool-1", request);
            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/compute/pools/pool-1/quota");
            expect(init?.method).toBe("PUT");
            expect(JSON.parse(init?.body as string)).toEqual(request);
        });
    });

    describe("compute resource policies", () => {
        const signed = { name: "guardrails", poolId: "pool-1", hardLimits: { maxCpuThreads: 32 }, workloadClassLimits: {}, signature: "c2ln", issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z" };

        it("lists policies filtered to a pool", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, [{ id: "policy-1", ...signed, version: 1, status: "active" }]));
            await listComputePoliciesForPool("org-1", "pool-1");
            expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/organizations/org-1/compute/policies?poolId=pool-1");
        });

        it("submits an already-signed policy without modifying it", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { id: "policy-1", ...signed, version: 1, status: "draft" }));
            await createComputePolicy("org-1", signed);
            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/compute/policies");
            expect(init?.method).toBe("POST");
            expect(JSON.parse(init?.body as string)).toEqual(signed);
        });

        it("activates a policy version (also the rollback path for a retired version)", async () => {
            vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "policy-1", ...signed, version: 1, status: "active" }));
            await activateComputePolicy("org-1", "policy-1");
            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(String(url)).toContain("/organizations/org-1/compute/policies/policy-1/activate");
            expect(init?.method).toBe("POST");
        });
    });
});
