import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as secretsStore from "./secrets-store";
import { getSharedBackendConfig, setSharedBackendConfig } from "./shared-backend-config-store";
import {
    SharedBackendClientError,
    clearSelectedOrganization,
    createOrganization,
    listOrganizationMemberships,
    selectOrganization,
} from "./shared-backend-client";

const TOKENS_KEY = "shared_backend_tokens";
function seedValidToken(): void {
    secretsStore.setSecret(TOKENS_KEY, JSON.stringify({ accessToken: "test-token", expiresAt: Date.now() + 60 * 60_000 }));
}

const CONFIG = { baseUrl: "https://iam.example-hospital.test", issuer: "https://idp.example-hospital.test", clientId: "x" };

function mockFetchOnce(response: { status: number; json?: unknown }) {
    const fn = vi.fn().mockResolvedValue({
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: () => Promise.resolve(response.json),
    });
    vi.stubGlobal("fetch", fn);
    return fn;
}

describe("shared-backend-client", () => {
    beforeEach(() => {
        secretsStore.setSecret(TOKENS_KEY, "");
        setSharedBackendConfig(null);
    });
    afterEach(() => vi.unstubAllGlobals());

    describe("listOrganizationMemberships", () => {
        it("throws without any fetch when no shared backend is configured", async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal("fetch", fetchMock);
            await expect(listOrganizationMemberships()).rejects.toBeInstanceOf(SharedBackendClientError);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("throws when configured but not connected", async () => {
            setSharedBackendConfig(CONFIG);
            await expect(listOrganizationMemberships()).rejects.toBeInstanceOf(SharedBackendClientError);
        });

        it("calls GET /me with the bearer token and returns the memberships array", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            const memberships = [{ organization: { id: "org-1", name: "Org", createdAt: "x" }, user: { id: "u1", displayName: "Me", status: "active" }, effectivePolicyNames: ["OrganizationAdmin"] }];
            const fetchMock = mockFetchOnce({ status: 200, json: { subject: "idp|x", memberships } });

            const result = await listOrganizationMemberships();
            expect(result).toEqual(memberships);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://iam.example-hospital.test/me");
            expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
        });

        it("throws SharedBackendClientError on a non-ok response", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            mockFetchOnce({ status: 500 });
            await expect(listOrganizationMemberships()).rejects.toBeInstanceOf(SharedBackendClientError);
        });

        it("refuses to send the bearer token to a non-HTTPS, non-loopback baseUrl, and never calls fetch", async () => {
            // shared-backend-config-store.ts's schema only checks baseUrl is
            // a non-empty string — a compromised renderer could otherwise
            // point this at an attacker-controlled origin via
            // sharedBackend:setConfig and have the live access token sent
            // straight to it.
            setSharedBackendConfig({ ...CONFIG, baseUrl: "http://attacker.example.com" });
            seedValidToken();
            const fetchMock = vi.fn();
            vi.stubGlobal("fetch", fetchMock);

            await expect(listOrganizationMemberships()).rejects.toBeInstanceOf(SharedBackendClientError);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("still allows an explicit HTTP loopback baseUrl (local development)", async () => {
            setSharedBackendConfig({ ...CONFIG, baseUrl: "http://localhost:4000" });
            seedValidToken();
            const memberships: never[] = [];
            const fetchMock = mockFetchOnce({ status: 200, json: { subject: "idp|x", memberships } });

            await expect(listOrganizationMemberships()).resolves.toEqual(memberships);
            expect(fetchMock).toHaveBeenCalledOnce();
        });
    });

    describe("createOrganization", () => {
        it("POSTs /organizations with the given name and returns the response body", async () => {
            setSharedBackendConfig(CONFIG);
            seedValidToken();
            const body = { organization: { id: "org-2", name: "New Org" }, user: { id: "u2" } };
            const fetchMock = mockFetchOnce({ status: 201, json: body });

            const result = await createOrganization("New Org");
            expect(result).toEqual(body);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://iam.example-hospital.test/organizations");
            expect(init.method).toBe("POST");
            expect(JSON.parse(init.body as string)).toEqual({ name: "New Org" });
        });
    });

    describe("selectOrganization", () => {
        it("throws when no shared backend is configured", () => {
            expect(() => selectOrganization("org-1")).toThrow(SharedBackendClientError);
        });

        it("writes organizationId into the existing config without touching other fields", () => {
            setSharedBackendConfig(CONFIG);
            selectOrganization("org-1");
            expect(getSharedBackendConfig()).toEqual({ ...CONFIG, organizationId: "org-1" });
        });
    });

    describe("clearSelectedOrganization", () => {
        it("throws when no shared backend is configured", () => {
            expect(() => clearSelectedOrganization()).toThrow(SharedBackendClientError);
        });

        it("removes organizationId while keeping the rest of the config", () => {
            setSharedBackendConfig({ ...CONFIG, organizationId: "org-1" });
            clearSelectedOrganization();
            expect(getSharedBackendConfig()).toEqual(CONFIG);
        });
    });
});
