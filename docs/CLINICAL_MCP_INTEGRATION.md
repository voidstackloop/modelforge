# Managed clinical MCP integration

This slice connects the ModelForge desktop application and shared backend to
`modelforge-clinical-mcp`. It provides short-lived context grants, exact-operation
approval tickets, institutional onboarding, review persistence, and structured
operation provenance. It is not a clinical validation or production-readiness
certification.

## Implemented behavior

- Settings can import HTTP servers whose institutional registry entry has
  `integrationProfile: "modelforge-clinical"`. Generic MCP integrations retain
  their existing behavior.
- The desktop uses the registry's static public OAuth client ID. It must match
  the shared-backend desktop client; a dynamically registered, different client
  cannot use grants or approvals bound to the institutional client.
- Clinical tool schemas hide `contextGrantId`, `approvalTicket`, and
  `idempotencyKey` from the model. The medication-check schema also hides
  medications and allergies: the main-process broker loads them from the
  attached case, only when both fields have `includeInContext` enabled.
- Grant issuance checks current case access, MCP permissions, active registry
  status, tool allowlist, egress policy, case consent, and purpose-specific AI
  consent. Grants contain field names and identity/case bindings, not clinical
  field values, and live for at most 300 seconds.
- Review writes require explicit approval for that call. Auto-approval does
  not satisfy the broker's human-approval check. The backend requests a digest
  challenge from the gateway, persists the pending approval without arguments,
  then confirms it and signs an RS256 ticket. The gateway verifies that ticket
  against the actual operation digest before execution.
- Tool messages preserve operation ID, digest, policy versions, registry/server/
  tool identity, and optional review ID/decision in `mcpOperation`. Ordinary tool
  results can contain clinical data; the provenance object and audit details do
  not copy arguments, response text, tickets, or rationale.
- PostgreSQL stores grants, pending/confirmed approvals, and review records with
  tenant row-level policies. Mutations and their audit entries share a database
  transaction. Review recording deduplicates by organization and reviewed
  operation ID.

## Backend endpoints

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `POST /organizations/:org/mcp-context-grants` | Organization member with case access and `mcpClinical:use` | Issue a field/tool/purpose-bound grant |
| `POST /organizations/:org/mcp-approvals/prepare` | Organization principal with `mcpClinical:approve` | Request the gateway's exact-operation challenge |
| `POST /organizations/:org/mcp-approvals/:id/confirm` | Original subject and OAuth client with `mcpClinical:approve` | Confirm once and issue an approval ticket |
| `POST /internal/mcp/context-grants/introspect` | Registered tenant service principal with `mcpClinical:introspect` | Resolve an unexpired grant |
| `POST /internal/mcp/reviews` | Registered tenant service principal with `mcpClinical:recordReview` | Persist a review decision |

Grant creation requires active case scopes `ai-assistance` and
`remote-model-use`, plus an active AI consent for the mapped purpose. Medication
review maps to treatment consent and requires the `medications` and `allergies`
data categories. Response-contract and review operations also require active AI
consent; their derived fields are not separate consent data categories.

## Deployment prerequisites

1. Use the PostgreSQL backend for durable operation. Apply
   `server/migrations/025_mcp_clinical_control_plane.sql` through the backend's
   migration runner. Migrations are tracked by full filename, not numeric prefix.
   Validate migrations/RLS using disposable infrastructure before production.
2. Register a public PKCE desktop OAuth client at the institution's issuer. Its
   registered redirect URIs must support both the shared-backend desktop flow
   and MCP's `http://127.0.0.1:51823/oauth/callback`. Set the same client ID in the
   desktop shared-backend configuration, clinical registry entry, and gateway
   `MODELFORGE_MCP_ALLOWED_CLIENT_IDS`.
3. Configure tokens deliberately: the current prepare route forwards the
   shared-backend bearer token to the registry's trusted challenge endpoint.
   That token must also be intended for the MCP audience and contain its required
   scopes/organization claims. The separately obtained MCP token must resolve to
   the same issuer/subject/client/organization. Same client ID alone is not
   sufficient. Audience-specific token exchange is not implemented; a deployment
   whose identity provider cannot issue an appropriately scoped token needs that
   integration before enabling review approval. Do not disable audience checks
   to make this work.
4. Register the gateway workload identity as an active service principal in
   each authorized organization. Give it only the internal MCP permissions and
   resource scopes it needs. Its token must be accepted by the shared backend;
   its lifetime/rotation remain deployment responsibilities.
5. Configure the backend signer with `MCP_APPROVAL_PRIVATE_KEY_PEM` (PEM contents,
   not a filename), `MCP_APPROVAL_ISSUER`, and `MCP_APPROVAL_AUDIENCE`. Keep the
   private key in the deployment secret manager. Configure the gateway with the
   matching public-key **file path** in `MODELFORGE_MCP_APPROVAL_PUBLIC_KEY_PEM`
   and matching issuer/audience values. If signing is unconfigured, confirmation
   returns 503 and does not issue a ticket; a new approval is needed after setup.
6. Configure authenticated HTTPS service base URLs on the gateway:

   ```text
   MODELFORGE_MCP_GRANT_SERVICE_URL=https://backend.example.test/internal/mcp/context-grants
   MODELFORGE_MCP_REVIEW_SERVICE_URL=https://backend.example.test/internal/mcp
   ```

   The grant adapter appends `/introspect`; the review adapter appends `/reviews`.
   Configure `MODELFORGE_MCP_WORKLOAD_TOKEN_FILE` and the gateway's separate shared
   state database, tenant policy, OIDC verification, and deployment profile as
   described in its enterprise deployment guide.
7. Create an active organization registry entry, for example:

   ```json
   {
     "name": "Institutional clinical gateway",
     "transport": "http",
     "endpoint": "https://mcp.example.test/mcp",
     "integrationProfile": "modelforge-clinical",
     "oauthClientId": "institutional-desktop",
     "approvalChallengeEndpoint": "https://mcp.example.test/approval-challenges",
     "allowedTools": [
       "modelforge.capabilities",
       "clinical.response_contract_check",
       "clinical.response_contract_check_batch",
       "clinical.record_review_decision"
     ],
     "dataEgressPolicy": "unrestricted"
   }
   ```

   `unrestricted` is the existing coarse registry egress category needed for
   nonempty tool payloads; it does not bypass gateway grants or tenant policy.
   Only institution-approved, trusted destinations belong in this registry.
8. In the built desktop application, connect to the shared backend, select the
   organization, choose **Add institutional clinical MCP**, sign in to the
   imported server, and connect. Attach a consented synthetic case for the pilot.
   A source build does not update an already-installed desktop binary.

## Verification and remaining gates

Run from the ModelForge repository:

```bash
npm --prefix packages/contracts run build
npm --prefix server run typecheck
npm --prefix app run build
npm --prefix frontend run build
npm --prefix server test
npm --prefix app test
npm --prefix frontend test
```

`server/src/routes/mcp-clinical.integration.test.ts` exercises actual backend
routes, OIDC verification, tenant permissions, consent checks, review replay,
and RS256 ticket verification using synthetic data. It mocks the remote MCP
challenge response. The gateway's Rust HTTP tests separately verify challenge
authentication and digest generation. These are not a live, cross-process
desktop/identity-provider/backend/gateway acceptance test.

Before a production pilot, complete that cross-process acceptance test and the
disposable PostgreSQL/Redis integration tests (some tests skip without their
explicit infrastructure configuration). Verify wrong-audience/client denial,
revoked consent, disabled registry entries, expired/replayed tickets, restart
durability, and cross-replica replay using synthetic data.

Current limits:

- `catalogVersionConstraint` is registry metadata, not a negotiated compatibility
  gate. Version compatibility still needs deployment acceptance testing.
- Existing grants are expiry-bound snapshots. There is no grant-revocation API
  or revalidation of current consent at introspection; allow for the maximum
  five-minute outstanding-grant window when designing revocation procedures.
- A stored review references an operation UUID; the backend does not yet own an
  operation ledger that independently verifies that operation's case provenance.
- This slice does not enable governed compute in the desktop broker. The
  gateway's built-in medication seed checker remains development-only, not a
  clinically validated enterprise medication service.
- A per-call desktop approval is not independent human-attestation or a second
  reviewer workflow. Production approval/consent policy remains an institution
  decision.

No live infrastructure, identity-provider settings, database migrations, or
installed application binaries are changed by the source/test work described
here.
