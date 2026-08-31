# Central policy (signed, admin-managed settings)

**Scope:** How an institution locks down a specific, curated subset of
ModelForge Medical's settings fleet-wide, without a login system or a
network policy service. See `docs/ENTERPRISE_READINESS_ASSESSMENT.md` §2.2
for the gap this closes and why the broader identity/RBAC/central-admin
target architecture (§5 there) is a separate, larger piece of work this
does not attempt to substitute for.

## What this is, and isn't

This is a **signed, versioned JSON file** an admin generates and drops at a
fixed, OS-conventional, machine-wide directory — not a network service, not
an identity system, not RBAC. The app reads that file, cryptographically
verifies it against a trusted public key deployed alongside it, and — only
if verification succeeds — overrides a fixed set of local settings and
locks them from being changed on the device.

It answers one question: **"can an institution guarantee a specific device
is running with certain settings, regardless of what the local user does?"**
It does not answer "who is this user" or "what patients can they see" —
those require a real identity provider and server-side enforcement (see the
assessment's §5 target architecture), which this repository does not
implement and does not pretend to.

## Trust model, stated plainly

The app trusts whatever public key it finds at its policy directory. There
is no hardware root of trust, no PKI chain, no per-institution app build.
**Securing that directory so only your organization's device-management
tooling (not the logged-in user) can write to it is your responsibility —
the same boundary this app already draws for OS-level disk encryption and
code-signing certificates.** A user with local admin/root on their own
machine can defeat this control, exactly as they can defeat any other
local-only control described throughout the enterprise-readiness
assessment. This is a real, useful control against a **non-admin user
loosening their own settings**, not a defense against a fully compromised
or admin-controlled endpoint.

## Where the app looks

| Platform | Directory |
|---|---|
| Windows | `C:\ProgramData\ModelForge Medical\policy` |
| macOS | `/Library/Application Support/ModelForge Medical/policy` |
| Linux | `/etc/modelforge-medical/policy` |

Override with the `MODELFORGE_POLICY_DIR` environment variable (useful for
testing, or if your deployment tooling prefers a different convention).

Two files live there:

- `trusted-public-key.pem` — the Ed25519 public key (SPKI PEM) the app
  verifies every policy against.
- `policy.json` — the signed policy document.

If neither file exists, the app is **unmanaged** — fully local control,
today's default behavior, unchanged. This is not a degraded state; it's the
correct mode for an individual clinician or a small practice that never
opts into central management.

## Generating a keypair and signing a policy

```bash
# Once per institution. Keep policy-signing-key.pem secret — store it the
# way you'd store any signing key (a password manager, an HSM, an offline
# vault). trusted-public-key.pem is what you deploy to every device.
node app/scripts/generate-policy-keypair.js ./keys

# Author a draft (see app/scripts/sign-policy.js's header comment for the
# full list of settings a policy may govern).
cat > draft.json <<'EOF'
{
  "issuer": "Example Health System IT",
  "expiresInDays": 90,
  "settings": {
    "networkToolsEnabled": false,
    "auditLogRetentionDays": 2555,
    "medicationSafetyProviderId": "modelforge-demo-list"
  }
}
EOF

node app/scripts/sign-policy.js draft.json ./keys/policy-signing-key.pem policy.json
```

Deploy `policy.json` and `trusted-public-key.pem` together to the directory
above, via whatever configuration-management/MDM tooling your institution
already uses to manage that OS-level location. Re-run `sign-policy.js`
before `expiresAt` to issue a refreshed policy — the app enforces a 7-day
grace period past expiry before falling back to fail-closed behavior (see
below), so plan a refresh cadence with margin.

## What a policy can govern

A fixed, deliberately small set of `AppSettings` fields — see
`MANAGED_SETTING_KEYS` in `app/src/policy-store.ts` for the authoritative
list (network tools, the agent verification loop and step limit, case
auto-lock timeout, redact-before-remote-send, audit log retention and
backend, and which registered medication-safety provider / patient-cases
backend is active). A policy document naming any other field is rejected
outright — `schemas.ts`'s `managedSettingsSchema` is `.strict()`, so a typo
in your policy tooling surfaces as a rejected policy, not a silently
ignored field.

## Fail-closed behavior

| Situation | Behavior |
|---|---|
| No policy files present | Unmanaged — local control, as today |
| Valid signature, not expired | **Active** — settings enforced |
| Valid signature, expired but within 7 days | **Active with a warning** ("expired — grace period") |
| Signature invalid, payload malformed, non-canonical, or expired past the grace period | **Invalid.** If this device previously verified a policy successfully, it stays governed by that last-known-good policy rather than reverting to local control — tampering with or deleting the policy file is not a way to escape governance. If no policy was ever successfully verified, the device falls back to local control, with the invalid state surfaced loudly in Settings → Audit & Privacy. |

The Settings → Audit & Privacy page always shows the current state
("Active" / "Expired (grace period)" / "Invalid" / "Not configured"),
which settings are currently managed, and locks their corresponding
controls — never a silent override with no visible explanation.

## What this deliberately does not do

- No live push/revocation — the app re-checks the local policy file
  periodically (at most every 5 seconds while running) but does not phone
  home; deploying a new `policy.json` takes effect the next time the file
  is read, not instantly across a fleet.
- No per-user or per-role policy — one policy per device, full stop. Real
  role-based policy requires the identity foundation described in the
  assessment's §5, which this does not build.
- No enforcement of settings outside `MANAGED_SETTING_KEYS` — this is
  intentionally a small, curated surface, not a general remote-config
  system.
