import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";

// The non-secret connection details for an enterprise-mode shared backend
// (packages/server/, docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md) — where it is and
// which OIDC issuer/client this install authenticates as. Kept separate
// from AppSettings (settings-store.ts) on purpose, matching the existing
// pattern already established for `patientCasesBackendId`/
// `medicationSafetyProviderId`: a settings field is only ever a *name*
// selecting an already-registered thing, never connection details or
// credentials — those belong to their own store. Kept separate from
// secrets-store.ts too, since none of this is actually sensitive (an
// issuer URL and a public OAuth client id are not secrets — see
// shared-backend-auth.ts for what *is* secret: the tokens and PKCE
// verifier, which do go through secrets-store.ts).
export interface SharedBackendConfig {
    /** The shared backend's HTTP base URL, e.g. "https://iam.example-hospital.org" or "http://localhost:4000" for local development. */
    baseUrl: string;
    /** The OIDC issuer this backend's tokens are verified against — used here to run OIDC discovery for the authorization/token endpoints (see shared-backend-auth.ts). */
    issuer: string;
    /** This app's registered OAuth client id with the institution's identity provider. A *public* client (PKCE, no client_secret) per RFC 8252 — Electron apps can't keep a client_secret confidential, so none is ever requested or stored. */
    clientId: string;
    /** Optional — some providers (e.g. Auth0-style custom-domain setups) expect an `audience` parameter in the authorization request to scope the issued token to a specific API/resource. */
    audience?: string;
    /** The organization id (from POST /organizations or GET /me on the shared backend) this install currently acts as. Unset until the user both completes the OAuth flow and picks an organization — see shared-backend-auth.ts. */
    organizationId?: string;
}

function filePath(): string {
    return path.join(app.getPath("userData"), "shared-backend-config.json");
}

export function getSharedBackendConfig(): SharedBackendConfig | null {
    return readJson<SharedBackendConfig | null>(filePath(), null);
}

/** Pass `null` to remove the configuration entirely (e.g. when disconnecting
 * for good, not just clearing tokens) — mirrors case-encryption.ts's
 * writeConfig(null) shape: a missing file is the desired end state, not an
 * error. */
export function setSharedBackendConfig(config: SharedBackendConfig | null): void {
    if (config === null) {
        try {
            fs.rmSync(filePath(), { force: true });
        } catch {
            // Best effort — a missing file is already the desired end state.
        }
        return;
    }
    writeJson(filePath(), config);
}
