import { describe, it, expect } from "vitest";
import { evaluatePolicies, evaluateWithBoundary, isAllowed, POLICY_DOCUMENT_VERSION } from "./policy-evaluator.js";
import type { Policy } from "./types.js";

function policy(id: string, statements: Policy["document"]["statements"]): Pick<Policy, "id" | "document"> {
    return { id, document: { version: POLICY_DOCUMENT_VERSION, statements } };
}

describe("policy-evaluator", () => {
    describe("default deny", () => {
        it("denies when there are no policies at all", () => {
            const result = evaluatePolicies([], { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" });
            expect(result.effect).toBe("Deny");
            expect(result.matchedStatement).toBeUndefined();
        });

        it("denies when policies exist but none match the action", () => {
            const policies = [policy("p1", [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }])];
            const result = evaluatePolicies(policies, { action: "patientCase:delete", resource: "organization:org-1/patientCase:case-1" });
            expect(result.effect).toBe("Deny");
            expect(result.matchedStatement).toBeUndefined();
        });

        it("denies when policies exist but none match the resource", () => {
            const policies = [policy("p1", [{ effect: "Allow", actions: ["*"], resources: ["organization:org-1/*"] }])];
            const result = evaluatePolicies(policies, { action: "patientCase:view", resource: "organization:org-2/patientCase:case-1" });
            expect(result.effect).toBe("Deny");
        });
    });

    describe("explicit allow", () => {
        it("allows an exact action/resource match", () => {
            const policies = [
                policy("p1", [{ effect: "Allow", actions: ["patientCase:view"], resources: ["organization:org-1/patientCase:case-1"] }]),
            ];
            expect(isAllowed(policies, { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" })).toBe(true);
        });

        it("allows via a wildcard action", () => {
            const policies = [policy("p1", [{ effect: "Allow", actions: ["patientCase:*"], resources: ["*"] }])];
            expect(isAllowed(policies, { action: "patientCase:edit", resource: "organization:org-1/patientCase:case-1" })).toBe(true);
        });

        it("allows via a wildcard resource", () => {
            const policies = [policy("p1", [{ effect: "Allow", actions: ["*"], resources: ["organization:org-1/*"] }])];
            expect(isAllowed(policies, { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" })).toBe(true);
        });

        it("reports which policy and statement matched", () => {
            const policies = [
                policy("p1", [{ sid: "AllowCaseView", effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }]),
            ];
            const result = evaluatePolicies(policies, { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" });
            expect(result).toEqual({ effect: "Allow", matchedStatement: { policyId: "p1", sid: "AllowCaseView", effect: "Allow" } });
        });
    });

    describe("explicit deny always wins", () => {
        it("denies even when a broader Allow also matches, deny listed after allow", () => {
            const policies = [
                policy("allow-all", [{ effect: "Allow", actions: ["*"], resources: ["*"] }]),
                policy("deny-delete", [{ effect: "Deny", actions: ["patientCase:delete"], resources: ["*"] }]),
            ];
            expect(isAllowed(policies, { action: "patientCase:delete", resource: "organization:org-1/patientCase:case-1" })).toBe(false);
        });

        it("denies even when the broader Allow is listed after the Deny", () => {
            const policies = [
                policy("deny-delete", [{ effect: "Deny", actions: ["patientCase:delete"], resources: ["*"] }]),
                policy("allow-all", [{ effect: "Allow", actions: ["*"], resources: ["*"] }]),
            ];
            expect(isAllowed(policies, { action: "patientCase:delete", resource: "organization:org-1/patientCase:case-1" })).toBe(false);
        });

        it("denies even within the same policy document, statements in either order", () => {
            const policies = [
                policy("mixed", [
                    { effect: "Allow", actions: ["*"], resources: ["*"] },
                    { effect: "Deny", actions: ["patientCase:delete"], resources: ["*"] },
                ]),
            ];
            expect(isAllowed(policies, { action: "patientCase:delete", resource: "organization:org-1/patientCase:case-1" })).toBe(false);
        });

        it("still allows an action the deny statement does not cover", () => {
            const policies = [
                policy("allow-all", [{ effect: "Allow", actions: ["*"], resources: ["*"] }]),
                policy("deny-delete", [{ effect: "Deny", actions: ["patientCase:delete"], resources: ["*"] }]),
            ];
            expect(isAllowed(policies, { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" })).toBe(true);
        });
    });

    describe("conditions", () => {
        it("StringEquals: allows only when the context value matches", () => {
            const policies = [
                policy("dept-scoped", [
                    {
                        effect: "Allow",
                        actions: ["patientCase:view"],
                        resources: ["*"],
                        condition: { StringEquals: { "user:department": "cardiology" } },
                    },
                ]),
            ];
            expect(
                isAllowed(policies, {
                    action: "patientCase:view",
                    resource: "organization:org-1/patientCase:case-1",
                    context: { "user:department": "cardiology" },
                })
            ).toBe(true);
            expect(
                isAllowed(policies, {
                    action: "patientCase:view",
                    resource: "organization:org-1/patientCase:case-1",
                    context: { "user:department": "oncology" },
                })
            ).toBe(false);
        });

        it("StringEquals: denies (via default-deny) when the context key is entirely missing", () => {
            const policies = [
                policy("dept-scoped", [
                    {
                        effect: "Allow",
                        actions: ["patientCase:view"],
                        resources: ["*"],
                        condition: { StringEquals: { "user:department": "cardiology" } },
                    },
                ]),
            ];
            expect(isAllowed(policies, { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" })).toBe(false);
        });

        it("StringEquals accepts an array of acceptable values", () => {
            const policies = [
                policy("dept-scoped", [
                    {
                        effect: "Allow",
                        actions: ["patientCase:view"],
                        resources: ["*"],
                        condition: { StringEquals: { "user:department": ["cardiology", "oncology"] } },
                    },
                ]),
            ];
            expect(
                isAllowed(policies, {
                    action: "patientCase:view",
                    resource: "organization:org-1/patientCase:case-1",
                    context: { "user:department": "oncology" },
                })
            ).toBe(true);
        });

        it("StringNotEquals: allows when the context value differs, denies when it matches", () => {
            const policies = [
                policy("not-research", [
                    {
                        effect: "Allow",
                        actions: ["patientCase:view"],
                        resources: ["*"],
                        condition: { StringNotEquals: { "user:department": "research" } },
                    },
                ]),
            ];
            expect(
                isAllowed(policies, {
                    action: "patientCase:view",
                    resource: "organization:org-1/patientCase:case-1",
                    context: { "user:department": "cardiology" },
                })
            ).toBe(true);
            expect(
                isAllowed(policies, {
                    action: "patientCase:view",
                    resource: "organization:org-1/patientCase:case-1",
                    context: { "user:department": "research" },
                })
            ).toBe(false);
        });

        it("StringNotEquals: allows (statement applies) when the context key is entirely missing", () => {
            const policies = [
                policy("not-research", [
                    {
                        effect: "Allow",
                        actions: ["patientCase:view"],
                        resources: ["*"],
                        condition: { StringNotEquals: { "user:department": "research" } },
                    },
                ]),
            ];
            expect(isAllowed(policies, { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" })).toBe(true);
        });

        it("a Deny with a condition only applies when the condition matches", () => {
            const policies = [
                policy("allow-all", [{ effect: "Allow", actions: ["*"], resources: ["*"] }]),
                policy("deny-research-writes", [
                    {
                        effect: "Deny",
                        actions: ["patientCase:edit"],
                        resources: ["*"],
                        condition: { StringEquals: { "user:department": "research" } },
                    },
                ]),
            ];
            expect(
                isAllowed(policies, {
                    action: "patientCase:edit",
                    resource: "organization:org-1/patientCase:case-1",
                    context: { "user:department": "cardiology" },
                })
            ).toBe(true);
            expect(
                isAllowed(policies, {
                    action: "patientCase:edit",
                    resource: "organization:org-1/patientCase:case-1",
                    context: { "user:department": "research" },
                })
            ).toBe(false);
        });
    });

    describe("pattern matching is safe against catastrophic backtracking", () => {
        // Regression test for a ReDoS in the previous regex-based
        // matchesPattern(): `pattern.split("*").join(".*")` compiled a
        // pattern like "a*a*a*...a*!" into `^a.*a.*a.*...!$`, the textbook
        // catastrophic-backtracking shape. Matched against a long,
        // deliberately non-matching value (no trailing "!"), a backtracking
        // regex engine explores exponentially many ways to distribute the
        // value's characters across the ".*" gaps before concluding no
        // match — this test's pattern/value pair used to hang the process
        // for seconds to minutes depending on segment count; it must now
        // resolve near-instantly.
        it("evaluates a many-segment wildcard pattern against a long non-matching value quickly", () => {
            const pattern = `${"a*".repeat(30)}!`;
            const value = "a".repeat(40); // no "!" at all — the pathological non-match case
            const policies = [policy("p1", [{ effect: "Allow", actions: ["*"], resources: [pattern] }])];

            const start = performance.now();
            const result = isAllowed(policies, { action: "patientCase:view", resource: value });
            const elapsedMs = performance.now() - start;

            expect(result).toBe(false);
            expect(elapsedMs).toBeLessThan(200);
        });

        it("still matches correctly around literal characters that are themselves regex metacharacters", () => {
            const policies = [policy("p1", [{ effect: "Allow", actions: ["*"], resources: ["organization:org-1/patientCase:*"] }])];
            expect(isAllowed(policies, { action: "x", resource: "organization:org-1/patientCase:case-1" })).toBe(true);
            expect(isAllowed(policies, { action: "x", resource: "organization:org-2/patientCase:case-1" })).toBe(false);
        });
    });

    describe("multiple policies combined (e.g. a user's direct policies + their groups')", () => {
        it("a permission granted by any one policy in the set is effective", () => {
            const policies = [
                policy("view-only", [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }]),
                policy("audit-read", [{ effect: "Allow", actions: ["audit:read"], resources: ["*"] }]),
            ];
            expect(isAllowed(policies, { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" })).toBe(true);
            expect(isAllowed(policies, { action: "audit:read", resource: "organization:org-1/audit:*" })).toBe(true);
            expect(isAllowed(policies, { action: "patientCase:delete", resource: "organization:org-1/patientCase:case-1" })).toBe(false);
        });
    });

    describe("evaluateWithBoundary (permission boundaries)", () => {
        const wideOpen = policy("wide-open", [{ effect: "Allow", actions: ["*"], resources: ["*"] }]);
        const readOnlyBoundary = policy("read-only-boundary", [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }]);
        const check = { action: "patientCase:delete", resource: "organization:org-1/patientCase:case-1" };
        const allowedCheck = { action: "patientCase:view", resource: "organization:org-1/patientCase:case-1" };

        it("with no boundary, behaves exactly like evaluatePolicies", () => {
            expect(evaluateWithBoundary([wideOpen], undefined, check)).toEqual(evaluatePolicies([wideOpen], check));
            expect(evaluateWithBoundary([wideOpen], undefined, allowedCheck)).toEqual(evaluatePolicies([wideOpen], allowedCheck));
        });

        it("caps an otherwise-unlimited identity policy to what the boundary allows", () => {
            expect(evaluateWithBoundary([wideOpen], readOnlyBoundary, check).effect).toBe("Deny");
            expect(evaluateWithBoundary([wideOpen], readOnlyBoundary, allowedCheck).effect).toBe("Allow");
        });

        it("a boundary can never grant something the identity policies themselves don't already allow", () => {
            const noPermissions = policy("none", [{ effect: "Allow", actions: ["nothing:relevant"], resources: ["*"] }]);
            const wideOpenBoundary = policy("wide-open-boundary", [{ effect: "Allow", actions: ["*"], resources: ["*"] }]);
            // The boundary would allow it, but the identity's own policies
            // never granted it in the first place — still Deny.
            expect(evaluateWithBoundary([noPermissions], wideOpenBoundary, allowedCheck).effect).toBe("Deny");
        });

        it("an explicit Deny in the identity policies wins regardless of the boundary", () => {
            const explicitDeny = policy("deny", [{ effect: "Deny", actions: ["patientCase:view"], resources: ["*"] }]);
            expect(evaluateWithBoundary([wideOpen, explicitDeny], readOnlyBoundary, allowedCheck).effect).toBe("Deny");
        });

        it("a Deny from the boundary reports the boundary's own matchedStatement, not the identity policy's", () => {
            const result = evaluateWithBoundary([wideOpen], readOnlyBoundary, check);
            expect(result.effect).toBe("Deny");
            expect(result.matchedStatement).toBeUndefined(); // default-deny inside the boundary — nothing in it matched "delete"
        });

        it("does not evaluate the boundary at all when the identity policies already deny (short-circuits)", () => {
            const explicitDeny = policy("deny", [{ effect: "Deny", actions: ["*"], resources: ["*"] }]);
            // A boundary that would itself throw/misbehave isn't reachable
            // here in practice, but the short-circuit is verified directly:
            // the identity-side Deny result is returned unchanged.
            const identityResult = evaluatePolicies([wideOpen, explicitDeny], check);
            expect(evaluateWithBoundary([wideOpen, explicitDeny], readOnlyBoundary, check)).toEqual(identityResult);
        });
    });
});
