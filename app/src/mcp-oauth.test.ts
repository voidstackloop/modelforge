import { describe, it, expect, beforeEach } from "vitest";
import { getOAuthProvider, hasStoredOAuthTokens, clearOAuthCredentials } from "./mcp-oauth";
import type { McpServerConfig } from "./mcp-client";

// Real network/browser OAuth flows (startOAuthFlow) aren't exercised here —
// there's no way to run a real authorization server in CI, and the SDK's
// auth()/startAuthorization()/exchangeAuthorization() functions (PKCE
// generation, RFC 8707 resource-indicator parameters, RFC 9728/8414
// discovery) are the SDK's own tested code, not this module's. What this
// module owns — and what's tested here — is the storage/provider glue: does
// a token actually round-trip through secrets-store, correctly namespaced
// per server, and does invalidation clear the right thing.

function oauthConfig(id: string): McpServerConfig {
    return { id, name: "Test OAuth server", transport: "http", enabled: true, url: "https://example.com/mcp", auth: { type: "oauth2" } };
}

describe("mcp-oauth", () => {
    beforeEach(() => {
        clearOAuthCredentials("oauth-1");
        clearOAuthCredentials("oauth-2");
    });

    it("returns undefined for a server with no oauth2 auth configured", () => {
        const plain: McpServerConfig = { id: "plain", name: "Plain", transport: "http", enabled: true, url: "https://example.com" };
        expect(getOAuthProvider(plain)).toBeUndefined();
    });

    it("declares a fixed loopback redirect URI and authorization_code + refresh_token grants", () => {
        const provider = getOAuthProvider(oauthConfig("oauth-1"))!;
        expect(String(provider.redirectUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
        expect(provider.clientMetadata.grant_types).toEqual(["authorization_code", "refresh_token"]);
        expect(provider.clientMetadata.redirect_uris).toEqual([provider.redirectUrl]);
    });

    it("round-trips tokens through secrets-store", async () => {
        const provider = getOAuthProvider(oauthConfig("oauth-1"))!;
        expect(await provider.tokens()).toBeUndefined();
        expect(hasStoredOAuthTokens("oauth-1")).toBe(false);

        await provider.saveTokens({ access_token: "abc123", token_type: "Bearer", refresh_token: "refresh123" });
        expect(hasStoredOAuthTokens("oauth-1")).toBe(true);
        const tokens = await provider.tokens();
        expect(tokens?.access_token).toBe("abc123");
        expect(tokens?.refresh_token).toBe("refresh123");
    });

    it("keeps two servers' tokens fully independent", async () => {
        const providerA = getOAuthProvider(oauthConfig("oauth-1"))!;
        const providerB = getOAuthProvider(oauthConfig("oauth-2"))!;
        await providerA.saveTokens({ access_token: "token-for-a", token_type: "Bearer" });
        await providerB.saveTokens({ access_token: "token-for-b", token_type: "Bearer" });

        expect((await providerA.tokens())?.access_token).toBe("token-for-a");
        expect((await providerB.tokens())?.access_token).toBe("token-for-b");

        clearOAuthCredentials("oauth-1");
        expect(await providerA.tokens()).toBeUndefined();
        expect((await providerB.tokens())?.access_token).toBe("token-for-b");
    });

    it("round-trips the PKCE code verifier", async () => {
        const provider = getOAuthProvider(oauthConfig("oauth-1"))!;
        await provider.saveCodeVerifier!("verifier-value-xyz");
        expect(await provider.codeVerifier!()).toBe("verifier-value-xyz");
    });

    it("throws a clear error when no code verifier has been saved yet", () => {
        const provider = getOAuthProvider(oauthConfig("oauth-1"))!;
        expect(() => provider.codeVerifier!()).toThrow(/No PKCE code verifier/);
    });

    it("round-trips dynamically-registered client information", async () => {
        const provider = getOAuthProvider(oauthConfig("oauth-1"))!;
        expect(await provider.clientInformation()).toBeUndefined();
        await provider.saveClientInformation!({ client_id: "client-abc", redirect_uris: [String(provider.redirectUrl)] });
        expect((await provider.clientInformation())?.client_id).toBe("client-abc");
    });

    it("uses the institutional static client id instead of dynamic registration state", async () => {
        const provider = getOAuthProvider({ ...oauthConfig("oauth-1"), oauthClientId: "institutional-desktop" })!;
        await provider.saveClientInformation!({ client_id: "stale-dynamic-client", redirect_uris: [String(provider.redirectUrl)] });
        expect((await provider.clientInformation())?.client_id).toBe("institutional-desktop");
    });

    it("invalidateCredentials('all') clears tokens, verifier, and client info together", async () => {
        const provider = getOAuthProvider(oauthConfig("oauth-1"))!;
        await provider.saveTokens({ access_token: "t", token_type: "Bearer" });
        await provider.saveCodeVerifier!("v");
        await provider.saveClientInformation!({ client_id: "c", redirect_uris: [String(provider.redirectUrl)] });

        await provider.invalidateCredentials!("all");

        expect(await provider.tokens()).toBeUndefined();
        expect(await provider.clientInformation()).toBeUndefined();
        expect(() => provider.codeVerifier!()).toThrow();
    });

    it("invalidateCredentials('tokens') clears only tokens, leaving client registration intact", async () => {
        const provider = getOAuthProvider(oauthConfig("oauth-1"))!;
        await provider.saveTokens({ access_token: "t", token_type: "Bearer" });
        await provider.saveClientInformation!({ client_id: "c", redirect_uris: [String(provider.redirectUrl)] });

        await provider.invalidateCredentials!("tokens");

        expect(await provider.tokens()).toBeUndefined();
        expect((await provider.clientInformation())?.client_id).toBe("c");
    });
});
