import * as http from "node:http";
import { shell } from "electron";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import * as secretsStore from "./secrets-store";
import type { McpServerConfig } from "./mcp-client";

export { UnauthorizedError };

// A fixed loopback redirect URI, the same approach CLI OAuth flows use (gh,
// gcloud, etc.) — no OS-level custom-protocol registration needed, and it
// works identically on every platform Electron ships on. Only bound while a
// flow is actually in progress (startOAuthFlow), never left listening.
const REDIRECT_PORT = 51823;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth/callback`;

function tokensKey(serverId: string): string {
    return `mcp_oauth_${serverId}_tokens`;
}
function verifierKey(serverId: string): string {
    return `mcp_oauth_${serverId}_verifier`;
}
function clientInfoKey(serverId: string): string {
    return `mcp_oauth_${serverId}_client_info`;
}

// Implements the SDK's OAuthClientProvider entirely on top of the existing
// safeStorage-backed secrets-store — no second secrets mechanism. Every
// stored key is namespaced by serverId, so tokens/verifiers/client
// registrations for one MCP server can never leak into or be confused with
// another's (relevant here since RFC 8707 resource indicators are what bind
// a token to one specific server in the first place — a mixed-up token
// would defeat that even if the resource indicator itself were correct).
class ModelForgeOAuthProvider implements OAuthClientProvider {
    constructor(private serverId: string, private preferredClientId?: string) {}

    get redirectUrl(): string {
        return REDIRECT_URI;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: "ModelForge Medical",
            redirect_uris: [REDIRECT_URI],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        };
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        if (this.preferredClientId) return { client_id: this.preferredClientId } as OAuthClientInformationMixed;
        const raw = secretsStore.getSecret(clientInfoKey(this.serverId));
        return raw ? (JSON.parse(raw) as OAuthClientInformationMixed) : undefined;
    }

    saveClientInformation(info: OAuthClientInformationMixed): void {
        secretsStore.setSecret(clientInfoKey(this.serverId), JSON.stringify(info));
    }

    tokens(): OAuthTokens | undefined {
        const raw = secretsStore.getSecret(tokensKey(this.serverId));
        return raw ? (JSON.parse(raw) as OAuthTokens) : undefined;
    }

    saveTokens(tokens: OAuthTokens): void {
        secretsStore.setSecret(tokensKey(this.serverId), JSON.stringify(tokens));
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        await shell.openExternal(authorizationUrl.toString());
    }

    saveCodeVerifier(verifier: string): void {
        secretsStore.setSecret(verifierKey(this.serverId), verifier);
    }

    codeVerifier(): string {
        const verifier = secretsStore.getSecret(verifierKey(this.serverId));
        if (!verifier) throw new Error("No PKCE code verifier saved for this server — start the authorization flow again.");
        return verifier;
    }

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
        if (scope === "tokens" || scope === "all") secretsStore.setSecret(tokensKey(this.serverId), "");
        if (scope === "verifier" || scope === "all") secretsStore.setSecret(verifierKey(this.serverId), "");
        if (scope === "client" || scope === "all") secretsStore.setSecret(clientInfoKey(this.serverId), "");
    }
}

export function getOAuthProvider(config: McpServerConfig): OAuthClientProvider | undefined {
    if (config.auth?.type !== "oauth2") return undefined;
    return new ModelForgeOAuthProvider(config.id, config.oauthClientId);
}

export function hasStoredOAuthTokens(serverId: string): boolean {
    return secretsStore.hasSecret(tokensKey(serverId));
}

export function clearOAuthCredentials(serverId: string): void {
    new ModelForgeOAuthProvider(serverId).invalidateCredentials("all");
}

// Briefly opens a loopback HTTP server just long enough to catch the single
// redirect the authorization server sends back with `?code=...`, then closes
// it — nothing stays listening once the flow is done (or times out).
function waitForRedirectCode(): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", REDIRECT_URI);
            const code = url.searchParams.get("code");
            const error = url.searchParams.get("error");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
                error
                    ? "<html><body>Authorization failed. You can close this tab and return to ModelForge Medical.</body></html>"
                    : "<html><body>Authorization complete — you can close this tab and return to ModelForge Medical.</body></html>"
            );
            server.close();
            if (error) reject(new Error(`Authorization was denied or failed: ${error}`));
            else if (code) resolve(code);
            else reject(new Error("No authorization code was returned."));
        });
        server.on("error", (err) => reject(new Error(`Could not start the local OAuth redirect listener: ${err.message}`)));
        server.listen(REDIRECT_PORT, "127.0.0.1");
        const timeout = setTimeout(
            () => {
                server.close();
                reject(new Error("Timed out waiting for authorization — no response after 5 minutes."));
            },
            5 * 60_000
        );
        timeout.unref();
    });
}

/**
 * Runs the full authorization-code + PKCE flow for one MCP server: discovers
 * the authorization server (RFC 9728/8414), opens the system browser,
 * catches the redirect, and exchanges the code for tokens scoped to this
 * server's resource URI (RFC 8707) — the SDK's `auth()` orchestrator does
 * the actual protocol work; this just supplies the storage/browser/redirect
 * plumbing around it. Resolves once tokens are saved; does nothing (and
 * resolves immediately) if a still-valid token already exists.
 */
export async function startOAuthFlow(config: McpServerConfig): Promise<void> {
    if (!config.url) throw new Error("This server has no URL configured.");
    const provider = getOAuthProvider(config);
    if (!provider) throw new Error("This server is not configured for OAuth.");
    const first = await auth(provider, { serverUrl: config.url });
    if (first === "AUTHORIZED") return;
    const code = await waitForRedirectCode();
    const second = await auth(provider, { serverUrl: config.url, authorizationCode: code });
    if (second !== "AUTHORIZED") throw new Error("Authorization did not complete successfully.");
}
