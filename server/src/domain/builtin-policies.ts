import { POLICY_DOCUMENT_VERSION } from "./policy-evaluator.js";
import type { PolicyDocument } from "./types.js";

// Auto-attached to whichever authenticated user creates a new organization
// (see routes/organizations.ts) — the bootstrap path out of the otherwise
// circular "you need iam:manageUsers to grant someone iam:manageUsers"
// problem. Grants everything within that one organization and nothing
// outside it: the resource pattern is scoped to `organization:{orgId}`
// itself and everything under it, never `*` — an org admin is not a
// service-wide superuser.
export function organizationAdminPolicyDocument(organizationId: string): PolicyDocument {
    return {
        version: POLICY_DOCUMENT_VERSION,
        statements: [
            {
                sid: "OrganizationAdminFullAccess",
                effect: "Allow",
                actions: ["*"],
                resources: [`organization:${organizationId}`, `organization:${organizationId}/*`],
            },
        ],
    };
}
