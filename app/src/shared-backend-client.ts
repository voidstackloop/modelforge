import { getValidAccessToken, isAllowedRemoteUrl } from "./shared-backend-auth";
import { getSharedBackendConfig, setSharedBackendConfig } from "./shared-backend-config-store";
import { migrationPreviewSchema, migrationSessionSchema, type MigrationPreview, type MigrationSession } from "@modelforge/contracts";

// General-purpose client for the shared backend's non-case-data endpoints
// (GET /me, POST /organizations) — the pieces a Settings UI needs to let a
// clinician discover which organizations they can act as and pick one,
// before shared-patient-cases-backend.ts's PatientCasesBackend becomes
// usable at all (it requires organizationId to already be set — see that
// module's requireConfig()). Kept separate from shared-patient-cases-backend.ts
// since these calls aren't part of the PatientCasesBackend contract.

export class SharedBackendClientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SharedBackendClientError";
    }
}

export interface OrganizationMembership {
    organization: { id: string; name: string; createdAt: string } | null;
    user: { id: string; displayName: string; status: string };
    effectivePolicyNames: string[];
}

export async function authorizedRequest(path: string, init?: RequestInit): Promise<Response> {
    const config = getSharedBackendConfig();
    if (!config) throw new SharedBackendClientError("No shared backend is configured — set one up first.");
    // shared-backend-config-store.ts's schema only checks baseUrl is a
    // non-empty string — nothing stops a compromised renderer from setting
    // it to an attacker-controlled origin via sharedBackend:setConfig.
    // Checked here, at the point the bearer token is actually about to be
    // sent, rather than trusting it was validated when set.
    if (!isAllowedRemoteUrl(config.baseUrl)) {
        throw new SharedBackendClientError(
            "The configured shared backend URL is not a trusted HTTPS endpoint (or an explicit loopback development address) — refusing to send credentials to it."
        );
    }
    const token = await getValidAccessToken();
    if (!token) throw new SharedBackendClientError("Not connected to the shared backend — connect first.");

    try {
        const headers: Record<string, string> = init?.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : { ...((init?.headers ?? {}) as Record<string, string>) };
        headers.Authorization = `Bearer ${token}`;
        if (init?.body !== undefined && headers["Content-Type"] === undefined && typeof init.body === "string") {
            headers["Content-Type"] = "application/json";
        }
        return await fetch(`${config.baseUrl}${path}`, {
            ...init,
            headers,
        });
    } catch (err) {
        throw new SharedBackendClientError(`Could not reach the shared backend: ${(err as Error).message}`);
    }
}

/** Every organization this connected identity has an account in, per the
 * shared backend's GET /me — what a Settings UI lists for the user to pick
 * one from. */
export async function listOrganizationMemberships(): Promise<OrganizationMembership[]> {
    const response = await authorizedRequest("/me");
    if (!response.ok) throw new SharedBackendClientError(`Failed to list organizations: HTTP ${response.status}`);
    const body = (await response.json()) as { memberships: OrganizationMembership[] };
    return body.memberships;
}

/** Bootstraps a brand-new organization via POST /organizations — the
 * connected identity automatically becomes its admin (see
 * packages/server/src/routes/organizations.ts). Does not select it; the caller
 * should follow up with selectOrganization(). */
export async function createOrganization(name: string): Promise<{ organization: { id: string; name: string }; user: { id: string } }> {
    const response = await authorizedRequest("/organizations", { method: "POST", body: JSON.stringify({ name }) });
    if (!response.ok) throw new SharedBackendClientError(`Failed to create organization: HTTP ${response.status}`);
    return (await response.json()) as { organization: { id: string; name: string }; user: { id: string } };
}

/** Records which organization this install acts as — purely local
 * bookkeeping (writes into shared-backend-config-store.ts), not a network
 * call: the shared backend has no concept of a "currently selected"
 * organization for a given identity, only which organizations that
 * identity has accounts in (see listOrganizationMemberships above). */
export function selectOrganization(organizationId: string): void {
    const config = getSharedBackendConfig();
    if (!config) throw new SharedBackendClientError("No shared backend is configured.");
    setSharedBackendConfig({ ...config, organizationId });
}

/** Clears the selected organization only, keeping the rest of the
 * connection config (baseUrl/issuer/clientId/audience) and the current
 * token — lets a Settings UI offer "change organization" without also
 * forcing a full disconnect/reconfigure. */
export function clearSelectedOrganization(): void {
    const config = getSharedBackendConfig();
    if (!config) throw new SharedBackendClientError("No shared backend is configured.");
    const { organizationId: _organizationId, ...rest } = config;
    setSharedBackendConfig(rest);
}

function selectedOrganizationId(): string {
    const id = getSharedBackendConfig()?.organizationId;
    if (!id) throw new SharedBackendClientError("Select an organization before starting a migration.");
    return id;
}

async function migrationRequest(path: string, init?: RequestInit): Promise<unknown> {
    const response = await authorizedRequest(path, init);
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try { detail = ((await response.json()) as { message?: string }).message ?? detail; } catch { /* no JSON body */ }
        throw new SharedBackendClientError(`Case migration request failed: ${detail}`);
    }
    return response.json();
}

export async function startCaseMigration(sourceFingerprint: string, totalItems: number): Promise<MigrationSession> {
    const org = selectedOrganizationId();
    return migrationSessionSchema.parse(await migrationRequest(`/organizations/${org}/case-migrations`, { method: "POST", body: JSON.stringify({ sourceFingerprint, totalItems }) }));
}
export async function uploadCaseMigrationBatch(migrationId: string, items: { itemKey: string; patientCase: unknown }[]): Promise<MigrationSession> {
    const org = selectedOrganizationId();
    return migrationSessionSchema.parse(await migrationRequest(`/organizations/${org}/case-migrations/${migrationId}/batches`, { method: "PUT", body: JSON.stringify({ items }) }));
}
export async function validateCaseMigration(migrationId: string): Promise<MigrationPreview> {
    const org = selectedOrganizationId();
    return migrationPreviewSchema.parse(await migrationRequest(`/organizations/${org}/case-migrations/${migrationId}/validate`, { method: "POST" }));
}
export async function activateCaseMigration(migrationId: string): Promise<MigrationSession> {
    const org = selectedOrganizationId();
    return migrationSessionSchema.parse(await migrationRequest(`/organizations/${org}/case-migrations/${migrationId}/activate`, { method: "POST" }));
}
export async function rollbackCaseMigration(migrationId: string): Promise<MigrationSession> {
    const org = selectedOrganizationId();
    return migrationSessionSchema.parse(await migrationRequest(`/organizations/${org}/case-migrations/${migrationId}/rollback`, { method: "POST" }));
}
