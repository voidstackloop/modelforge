import { beforeEach, describe, expect, it, vi } from "vitest";

// client.ts (pulled in below via importOriginal) imports the real
// oidc-config.ts, which constructs a real oidc-client-ts UserManager at
// module-load time — that throws given this test environment's unset
// VITE_OIDC_* env vars. Stubbed out here (unused by these tests directly)
// purely so importOriginal can load the rest of client.ts safely.
vi.mock("../auth/oidc-config", () => ({ userManager: { getUser: vi.fn(), removeUser: vi.fn() } }));

const mockCheckAuthz = vi.fn();

vi.mock("../api/client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../api/client")>();
    return { ...actual, checkAuthz: (...args: unknown[]) => mockCheckAuthz(...args) };
});

const { FIXED_ACTIONS, loadPermissions, clearPermissionsCache, describeApiError } = await import("./permissions");
const { ApiError } = await import("../api/client");

describe("authz/permissions", () => {
    beforeEach(() => {
        mockCheckAuthz.mockReset();
        clearPermissionsCache();
    });

    it("includes the break-glass and access-review actions (P1: approvals/access-reviews/break-glass)", () => {
        expect(FIXED_ACTIONS).toEqual(
            expect.arrayContaining(["breakGlass:invoke", "breakGlass:list", "breakGlass:review", "accessReview:manage", "accessReview:list", "accessReview:decide"])
        );
    });

    it("includes the policy-versioning dual-control actions (P1: signed central policy/configuration)", () => {
        expect(FIXED_ACTIONS).toEqual(expect.arrayContaining(["policy:propose", "policy:approve"]));
    });

    it("includes audit:manageLegalHold, kept separate from audit:read (P1: immutable audit ingestion and legal hold)", () => {
        expect(FIXED_ACTIONS).toEqual(expect.arrayContaining(["audit:read", "audit:manageLegalHold"]));
    });

    it("includes the tenant-backup dual-control actions (P1: enterprise backup, PITR, and tenant-scoped restore)", () => {
        expect(FIXED_ACTIONS).toEqual(expect.arrayContaining(["tenantBackup:export", "tenantBackup:proposeRestore", "tenantBackup:approveRestore"]));
    });

    it("includes separate MCP registry read and management actions", () => {
        expect(FIXED_ACTIONS).toEqual(expect.arrayContaining(["mcpRegistry:list", "mcpRegistry:manage"]));
    });

    it("checks every fixed action against organization:{id} exactly once", async () => {
        mockCheckAuthz.mockResolvedValue({ effect: "Allow" });
        await loadPermissions("org-1");

        expect(mockCheckAuthz).toHaveBeenCalledTimes(FIXED_ACTIONS.length);
        for (const action of FIXED_ACTIONS) {
            expect(mockCheckAuthz).toHaveBeenCalledWith("org-1", action, "organization:org-1");
        }
    });

    it("maps each action to true/false based on the check's effect", async () => {
        mockCheckAuthz.mockImplementation((_org: string, action: string) =>
            Promise.resolve({ effect: action === "iam:manageUsers" ? "Allow" : "Deny" })
        );
        const permissions = await loadPermissions("org-1");
        expect(permissions["iam:manageUsers"]).toBe(true);
        expect(permissions["iam:managePolicies"]).toBe(false);
    });

    it("fails closed (Deny) when a check rejects, rather than throwing or assuming access", async () => {
        mockCheckAuthz.mockRejectedValue(new Error("network blip"));
        const permissions = await loadPermissions("org-2");
        for (const action of FIXED_ACTIONS) expect(permissions[action]).toBe(false);
    });

    it("caches per organization — a second call does not re-issue the checks", async () => {
        mockCheckAuthz.mockResolvedValue({ effect: "Allow" });
        await loadPermissions("org-1");
        mockCheckAuthz.mockClear();

        await loadPermissions("org-1");
        expect(mockCheckAuthz).not.toHaveBeenCalled();
    });

    it("force=true bypasses the cache and re-issues every check", async () => {
        mockCheckAuthz.mockResolvedValue({ effect: "Allow" });
        await loadPermissions("org-1");
        mockCheckAuthz.mockClear();

        await loadPermissions("org-1", true);
        expect(mockCheckAuthz).toHaveBeenCalledTimes(FIXED_ACTIONS.length);
    });

    it("caches independently per organization", async () => {
        mockCheckAuthz.mockResolvedValue({ effect: "Allow" });
        await loadPermissions("org-1");
        mockCheckAuthz.mockClear();

        await loadPermissions("org-2");
        expect(mockCheckAuthz).toHaveBeenCalledTimes(FIXED_ACTIONS.length);
    });

    describe("describeApiError", () => {
        it("clears that organization's permission cache on a 403, so nav re-syncs on next load", async () => {
            mockCheckAuthz.mockResolvedValue({ effect: "Allow" });
            await loadPermissions("org-1");
            mockCheckAuthz.mockClear();

            describeApiError(new ApiError(403, { error: "authorization_error", message: "Nope." }, "Nope."), "org-1");

            await loadPermissions("org-1");
            expect(mockCheckAuthz).toHaveBeenCalledTimes(FIXED_ACTIONS.length);
        });

        it("returns the server's own message for an ApiError", () => {
            expect(describeApiError(new ApiError(403, { error: "authorization_error", message: "Not allowed." }, "Not allowed."), "org-1")).toBe(
                "Not allowed."
            );
        });

        it("falls back to a generic message for a non-Error value", () => {
            expect(describeApiError("boom", "org-1")).toBe("Something went wrong.");
        });
    });
});
