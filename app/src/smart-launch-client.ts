import { smartLaunchSessionSchema, smartLaunchTokenSchema, smartTrustedIssuerSchema, type SmartLaunchSession, type SmartLaunchToken, type SmartTrustedIssuer } from "@modelforge/contracts";
import { z } from "zod";
import { authorizedRequest, SharedBackendClientError } from "./shared-backend-client";
import { getSharedBackendConfig } from "./shared-backend-config-store";

// REST glue for server/src/routes/smart-launch.ts. The actual
// authorization-code + PKCE dance (opening a browser, catching the
// redirect) lives in smart-launch-flow.ts, which calls startLaunchSession/
// completeLaunchCallback below — kept separate the same way
// shared-backend-client.ts's own request helpers are separate from any one
// flow that uses them.

function organizationId(): string {
    const id = getSharedBackendConfig()?.organizationId;
    if (!id) throw new SharedBackendClientError("Select a shared-backend organization before using SMART launch.");
    return id;
}

async function expectJson<T>(response: Response, action: string): Promise<T> {
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const body = (await response.json()) as { message?: string; error?: string };
            detail = body.message ?? body.error ?? detail;
        } catch { /* response was not JSON */ }
        throw new SharedBackendClientError(`${action} failed: ${detail}`);
    }
    return response.json() as Promise<T>;
}

export async function listTrustedIssuers(): Promise<SmartTrustedIssuer[]> {
    const org = organizationId();
    const body = await expectJson<{ trustedIssuers: unknown[] }>(
        await authorizedRequest(`/organizations/${encodeURIComponent(org)}/smart/trusted-issuers`),
        "Listing trusted EHR issuers"
    );
    return z.array(smartTrustedIssuerSchema).parse(body.trustedIssuers);
}

export async function upsertTrustedIssuer(input: { issuer: string; clientId: string; redirectUris: string[] }): Promise<SmartTrustedIssuer> {
    const org = organizationId();
    return smartTrustedIssuerSchema.parse(
        await expectJson(
            await authorizedRequest(`/organizations/${encodeURIComponent(org)}/smart/trusted-issuers`, { method: "PUT", body: JSON.stringify(input) }),
            "Registering trusted EHR issuer"
        )
    );
}

export async function deleteTrustedIssuer(issuer: string): Promise<void> {
    const org = organizationId();
    const response = await authorizedRequest(`/organizations/${encodeURIComponent(org)}/smart/trusted-issuers/delete`, { method: "POST", body: JSON.stringify({ issuer }) });
    if (!response.ok && response.status !== 404) {
        throw new SharedBackendClientError(`Removing trusted EHR issuer failed: HTTP ${response.status}`);
    }
}

export async function listLaunchSessions(): Promise<SmartLaunchToken[]> {
    const org = organizationId();
    const body = await expectJson<{ sessions: unknown[] }>(
        await authorizedRequest(`/organizations/${encodeURIComponent(org)}/smart/sessions`),
        "Listing SMART launch sessions"
    );
    return z.array(smartLaunchTokenSchema).parse(body.sessions);
}

export async function revokeLaunchSession(sessionId: string): Promise<void> {
    const org = organizationId();
    const response = await authorizedRequest(`/organizations/${encodeURIComponent(org)}/smart/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST" });
    if (!response.ok && response.status !== 404) {
        throw new SharedBackendClientError(`Revoking SMART launch session failed: HTTP ${response.status}`);
    }
}

/** Starts a launch: the server validates `issuer` against this org's
 * trusted-issuer allowlist and `redirectUri` against that issuer's own
 * allowlist (exact match — see smart-launch/service.ts), discovers the
 * EHR's authorization endpoint, and returns a URL to send the user to.
 * Internal to smart-launch-flow.ts — not exposed over IPC directly, since
 * completing the flow also requires catching the redirect. */
export async function startLaunchSession(issuer: string, redirectUri: string): Promise<{ session: SmartLaunchSession; authorizationUrl: string }> {
    const org = organizationId();
    const schema = z.object({ session: smartLaunchSessionSchema, authorizationUrl: z.string().url() });
    return schema.parse(
        await expectJson(
            await authorizedRequest(`/organizations/${encodeURIComponent(org)}/smart/launch-sessions`, { method: "POST", body: JSON.stringify({ issuer, redirectUri }) }),
            "Starting SMART launch"
        )
    );
}

/** Completes a launch: exchanges the authorization code the EHR redirected
 * back with. Single-use — a second call with the same `state` fails. */
export async function completeLaunchCallback(state: string, code: string): Promise<SmartLaunchToken> {
    const org = organizationId();
    return smartLaunchTokenSchema.parse(
        await expectJson(
            await authorizedRequest(`/organizations/${encodeURIComponent(org)}/smart/launch-sessions/${encodeURIComponent(state)}/callback`, { method: "POST", body: JSON.stringify({ code }) }),
            "Completing SMART launch"
        )
    );
}
