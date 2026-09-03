import { z } from "zod";

/**
 * SMART App Launch — the client role: ModelForge acting as a SMART app
 * embedded in (or launched from) an external EHR, requesting access to
 * THAT EHR's own FHIR data. The mirror image of `fhir.ts`'s facade, which
 * is this server acting as the FHIR *resource server* for its own data.
 * See server/src/smart-launch/ and docs/SMART_LAUNCH.md for the full flow
 * and disclosed scope.
 *
 * Load-bearing design decision, per explicit product direction (not this
 * codebase's own default assumption): **a launch requires an already-
 * authenticated ModelForge session.** There is no unauthenticated redirect
 * entry point anywhere in this flow — every route below sits behind the
 * same `deps.authPreHandler` bearer-token check every other route in this
 * API does. This sidesteps the much larger, separate problem of trusting
 * an external EHR's identity claims to establish a *new* ModelForge
 * session (auto-provisioning/SSO) — deliberately out of scope here.
 *
 * Public-client (PKCE, no client_secret) only — see
 * server/src/smart-launch/token-crypto.ts's own doc comment on why a
 * confidential-client (client_secret) flow isn't implemented either.
 */
const identifierSchema = z.string().min(1).max(200);
const timestampSchema = z.string().datetime({ offset: true });

/** An organization's own allowlist of EHRs it trusts enough to launch a
 * SMART session against — configured by an admin ahead of time
 * (`smartLaunch:manage`), never inferred from an unauthenticated launch
 * request. `issuer` doubles as the FHIR base URL, per SMART App Launch's
 * own convention (the `iss` a launch names IS the FHIR server to talk to;
 * its `.well-known/smart-configuration` describes where to authorize). */
export const smartTrustedIssuerSchema = z
    .object({
        id: identifierSchema,
        issuer: z.string().url().max(2_000),
        clientId: z.string().min(1).max(500),
        /** Exact-match allowlist — a launch-session request's own
         * `redirectUri` must equal one of these verbatim. Never a prefix/
         * pattern match (an open-redirect-shaped mistake this schema
         * makes structurally harder to make). */
        redirectUris: z.array(z.string().url().max(2_000)).min(1).max(20),
        addedByUserId: identifierSchema,
        createdAt: timestampSchema,
    })
    .strict();
export type SmartTrustedIssuer = z.infer<typeof smartTrustedIssuerSchema>;

export const smartLaunchSessionStatusSchema = z.enum(["pending", "completed", "expired"]);

/** The pending, single-use authorization-request record between "redirect
 * the user to the EHR" and "the EHR redirected back with a code" — never
 * contains the PKCE code_verifier or anything else secret in any API
 * response shape (see server/src/smart-launch/store.ts for where that
 * actually lives, store-internal only). */
export const smartLaunchSessionSchema = z
    .object({
        id: identifierSchema,
        issuer: z.string().url().max(2_000),
        requestedByUserId: identifierSchema,
        scope: z.string().min(1).max(1_000),
        status: smartLaunchSessionStatusSchema,
        createdAt: timestampSchema,
        expiresAt: timestampSchema,
    })
    .strict();
export type SmartLaunchSession = z.infer<typeof smartLaunchSessionSchema>;

/** A completed launch — what the token exchange produced, minus the
 * secrets themselves (access_token/refresh_token live only in the store's
 * own internal, encrypted-at-rest representation; see
 * server/src/store/smart-launch-store.ts). */
export const smartLaunchTokenSchema = z
    .object({
        id: identifierSchema,
        issuer: z.string().url().max(2_000),
        requestedByUserId: identifierSchema,
        scope: z.string().min(1).max(1_000),
        /** SMART launch context — which patient this token is scoped to,
         * when the EHR's token response included one (SMART's own
         * `patient` response parameter). Absent for a launch that didn't
         * request/receive patient context. */
        patientId: z.string().max(200).optional(),
        hasRefreshToken: z.boolean(),
        expiresAt: timestampSchema,
        createdAt: timestampSchema,
    })
    .strict();
export type SmartLaunchToken = z.infer<typeof smartLaunchTokenSchema>;
