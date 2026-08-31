import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { InMemoryWebStorage } from "./in-memory-web-storage";

const issuer = import.meta.env.VITE_OIDC_ISSUER;
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
const audience = import.meta.env.VITE_OIDC_AUDIENCE;

// Bare app origin, deliberately with NO hash-route path segment. This app
// uses createHashRouter (see App.tsx) — a redirect_uri shaped like
// `.../#/auth/callback` would have the IdP append `?code=&state=` *after*
// the hash, landing at `.../#/auth/callback?code=...`, which puts
// code/state inside the URL fragment, invisible to URLSearchParams. The
// bare-origin redirect_uri plus auth-context.tsx's top-of-tree callback
// detection (reading location.search directly, before the router mounts)
// sidesteps this regardless of which router is used.
const redirectUri = `${window.location.origin}${import.meta.env.BASE_URL}`;

export const userManager = new UserManager({
    authority: issuer,
    client_id: clientId,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    // Auth0-style IdPs mint a token with the right `aud` claim only when an
    // explicit `audience` request parameter is present — mirrors the same
    // pattern app/src/shared-backend-auth.ts's connect() already uses. The
    // resulting token's `aud` must still equal the server's own
    // OIDC_AUDIENCE regardless of how it gets there.
    extraQueryParams: audience ? { audience } : undefined,
    // Tokens (access_token/refresh_token): memory-only, lost on reload —
    // see InMemoryWebStorage's doc comment. This is what "no persisted
    // session" actually means in this app.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    // PKCE state/code_verifier: must survive a full-page navigation to the
    // IdP and back, which destroys the JS heap — real sessionStorage is
    // unavoidable here, and is a much shorter-lived value than the tokens
    // above (cleared once the redirect round trip completes).
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    // Deferred for v1 — see admin-console/README.md's "Known gaps."
    // Without persisted tokens there's nothing to silently renew anyway;
    // re-login is the accepted v1 behavior once the access token expires.
    automaticSilentRenew: false,
    // Identity comes from this app's own GET /me, not the IdP's userinfo
    // endpoint — avoids a second, redundant network call on every login.
    loadUserInfo: false,
});
