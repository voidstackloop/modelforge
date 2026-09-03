import type { FhirSmartConfiguration } from "@modelforge/contracts";
import { fhirSmartConfigurationSchema } from "@modelforge/contracts";
import type { AuthorizationServerMetadata } from "../auth/oidc-verifier.js";

/**
 * Builds this server's `.well-known/smart-configuration` document from the
 * external IdP's own discovered endpoints (auth/oidc-verifier.ts's
 * resolveAuthorizationServerMetadata). `capabilities` only lists what this
 * resource server actually enforces — see routes/fhir.ts's
 * enforceSmartLaunchContext for what `context-ehr-patient` and
 * `permission-patient` mean here concretely (a token carrying a `patient`
 * launch-context claim is confined to that patient's data).
 */
export function buildSmartConfiguration(metadata: AuthorizationServerMetadata): FhirSmartConfiguration {
    return fhirSmartConfigurationSchema.parse({
        issuer: metadata.issuer,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        capabilities: ["launch-ehr", "launch-standalone", "client-public", "client-confidential-symmetric", "sso-openid-connect", "context-ehr-patient", "permission-patient", "permission-v2"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code"],
        scopes_supported: ["openid", "fhirUser", "launch", "launch/patient", "patient/*.read", "offline_access"],
    } satisfies FhirSmartConfiguration);
}
