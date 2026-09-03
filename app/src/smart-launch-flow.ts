import * as http from "node:http";
import { shell } from "electron";
import type { SmartLaunchToken } from "@modelforge/contracts";
import { completeLaunchCallback, startLaunchSession } from "./smart-launch-client";

// Same fixed-loopback-redirect approach as mcp-oauth.ts (a CLI-OAuth-style
// redirect URI, no OS custom-protocol registration needed) — deliberately a
// different port so the two flows can never collide if somehow triggered
// at once. Only bound while a launch is actually in progress.
const REDIRECT_PORT = 51824;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/smart/callback`;

export class SmartLaunchFlowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SmartLaunchFlowError";
    }
}

// Briefly opens a loopback HTTP server just long enough to catch the single
// redirect the EHR's authorization server sends back with
// `?code=...&state=...`, then closes it. `expectedState` is checked here
// too (not only server-side by completeLaunchCallback) as defense in depth
// against a stray request reaching this transient listener while it's up.
function waitForSmartRedirect(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", REDIRECT_URI);
            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state");
            const error = url.searchParams.get("error");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
                error
                    ? "<html><body>EHR authorization failed. You can close this tab and return to ModelForge Medical.</body></html>"
                    : "<html><body>Authorization complete — you can close this tab and return to ModelForge Medical.</body></html>"
            );
            server.close();
            if (error) reject(new SmartLaunchFlowError(`EHR authorization was denied or failed: ${error}`));
            else if (!code) reject(new SmartLaunchFlowError("No authorization code was returned."));
            else if (state !== expectedState) reject(new SmartLaunchFlowError("The authorization response's state did not match this launch — rejecting to avoid a mixed-up session."));
            else resolve(code);
        });
        server.on("error", (err) => reject(new SmartLaunchFlowError(`Could not start the local SMART launch redirect listener: ${err.message}`)));
        server.listen(REDIRECT_PORT, "127.0.0.1");
        const timeout = setTimeout(
            () => {
                server.close();
                reject(new SmartLaunchFlowError("Timed out waiting for EHR authorization — no response after 5 minutes."));
            },
            5 * 60_000
        );
        timeout.unref();
    });
}

/**
 * Runs a full SMART App Launch (client role) end to end for one trusted
 * issuer: asks the server to start a launch session (server validates the
 * issuer/redirectUri allowlist and discovers the EHR's authorization
 * endpoint), opens that URL in the system browser, catches the redirect,
 * and exchanges the code — all via server/src/smart-launch/service.ts,
 * which does the actual PKCE + token exchange server-side. This process
 * never sees the EHR's access/refresh token: completeLaunchCallback
 * returns only the public SmartLaunchToken shape (metadata, no secrets).
 */
export async function runSmartLaunch(issuer: string): Promise<SmartLaunchToken> {
    const { session, authorizationUrl } = await startLaunchSession(issuer, REDIRECT_URI);
    await shell.openExternal(authorizationUrl);
    const code = await waitForSmartRedirect(session.id);
    return completeLaunchCallback(session.id, code);
}
