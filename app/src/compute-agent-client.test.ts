import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("undici", () => ({
    Agent: vi.fn().mockImplementation((opts: unknown) => ({ opts })),
    fetch: fetchMock,
}));

vi.mock("./shared-backend-config-store", () => ({
    getSharedBackendConfig: vi.fn(),
}));

vi.mock("./shared-backend-auth", () => ({
    getValidAccessToken: vi.fn(),
    isAllowedRemoteUrl: vi.fn(),
}));

vi.mock("./compute-node-identity", () => ({
    getOrCreateNodeIdentity: vi.fn(async () => ({ certificatePem: "CERT", fingerprint256: "AA:BB" })),
    getNodePrivateKeyPem: vi.fn(() => "KEY"),
}));

import { getSharedBackendConfig } from "./shared-backend-config-store";
import { getValidAccessToken, isAllowedRemoteUrl } from "./shared-backend-auth";
import { sendHeartbeat, getAssignments, acknowledgeLease, renewLease, releaseLease, ComputeAgentClientError } from "./compute-agent-client";

function jsonResponse(body: unknown, ok = true, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
    return { ok, status, json: async () => body };
}

describe("compute-agent-client", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSharedBackendConfig).mockReturnValue({
            baseUrl: "https://server.example.org",
            issuer: "https://issuer.example.org",
            clientId: "client-1",
            organizationId: "org-1",
        });
        vi.mocked(isAllowedRemoteUrl).mockReturnValue(true);
        vi.mocked(getValidAccessToken).mockResolvedValue("token-1");
    });

    it("throws when no shared backend is configured", async () => {
        vi.mocked(getSharedBackendConfig).mockReturnValue(null);
        await expect(sendHeartbeat("node-1", {} as never)).rejects.toThrow(ComputeAgentClientError);
    });

    it("throws when no organization is selected", async () => {
        vi.mocked(getSharedBackendConfig).mockReturnValue({
            baseUrl: "https://server.example.org", issuer: "https://issuer.example.org", clientId: "client-1",
        });
        await expect(sendHeartbeat("node-1", {} as never)).rejects.toThrow(/organization/i);
    });

    it("throws when the configured base URL is not trusted", async () => {
        vi.mocked(isAllowedRemoteUrl).mockReturnValue(false);
        await expect(sendHeartbeat("node-1", {} as never)).rejects.toThrow(/trusted/i);
    });

    it("throws when not connected (no valid access token)", async () => {
        vi.mocked(getValidAccessToken).mockResolvedValue(null);
        await expect(sendHeartbeat("node-1", {} as never)).rejects.toThrow(/connect/i);
    });

    it("sends a heartbeat with a bearer token and mTLS dispatcher, to the right URL", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ accepted: true, nodeState: "online", policyRefreshRequired: false }));
        const result = await sendHeartbeat("node-1", { nodeId: "node-1" } as never);
        expect(result.accepted).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith(
            "https://server.example.org/organizations/org-1/compute/nodes/node-1/heartbeat",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
                dispatcher: expect.objectContaining({ opts: { connect: { cert: "CERT", key: "KEY" } } }),
            })
        );
    });

    it("gets assignments via GET with no body", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ assignments: [], policies: [] }));
        await getAssignments("node-1");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://server.example.org/organizations/org-1/compute/nodes/node-1/assignments",
            expect.objectContaining({ method: "GET" })
        );
    });

    it("acknowledges a lease with its fencing token", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "lease-1", state: "acknowledged" }));
        await acknowledgeLease("lease-1", "42");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://server.example.org/organizations/org-1/compute/leases/lease-1/acknowledge",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ fencingToken: "42" }) })
        );
    });

    it("renews a lease", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "lease-1", fencingToken: "43" }));
        const result = await renewLease("lease-1", "42");
        expect(result.fencingToken).toBe("43");
    });

    it("releases a lease with an outcome", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "lease-1", state: "released" }));
        await releaseLease("lease-1", "42", "completed");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://server.example.org/organizations/org-1/compute/leases/lease-1/release",
            expect.objectContaining({ body: JSON.stringify({ fencingToken: "42", outcome: "completed" }) })
        );
    });

    it("throws a ComputeAgentClientError with the server's message on a non-ok response", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: "not_found", message: "Compute node not found." }, false, 404));
        await expect(sendHeartbeat("node-1", {} as never)).rejects.toThrow(/Compute node not found/);
    });

    it("wraps a network failure in a ComputeAgentClientError", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
        await expect(sendHeartbeat("node-1", {} as never)).rejects.toThrow(/Could not reach/);
    });
});
