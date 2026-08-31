import { describe, it, expect } from "vitest";
import { classifyAuditSeverity } from "./audit-severity.js";

describe("classifyAuditSeverity", () => {
    it("flags emergency-access and safety-mechanism actions as critical", () => {
        expect(classifyAuditSeverity("breakGlass.invoke")).toBe("critical");
        expect(classifyAuditSeverity("auditLegalHold.release")).toBe("critical");
        expect(classifyAuditSeverity("diagnosticReport.acknowledgeCritical")).toBe("critical");
        expect(classifyAuditSeverity("tenantBackup.approveRestore")).toBe("critical");
    });

    it("flags access-changing and policy-changing actions as warning", () => {
        expect(classifyAuditSeverity("policy.delete")).toBe("warning");
        expect(classifyAuditSeverity("policy.update")).toBe("warning");
        expect(classifyAuditSeverity("invitation.revoke")).toBe("warning");
        expect(classifyAuditSeverity("scimToken.revoke")).toBe("warning");
        expect(classifyAuditSeverity("servicePrincipal.create")).toBe("warning");
        expect(classifyAuditSeverity("aiSafetyEvent.record")).toBe("warning");
    });

    it("defaults an unclassified action to info rather than silently escalating it", () => {
        expect(classifyAuditSeverity("policy.create")).toBe("info");
        expect(classifyAuditSeverity("user.create")).toBe("info");
        expect(classifyAuditSeverity("membership.update")).toBe("info");
        expect(classifyAuditSeverity("some.totally-unknown-action")).toBe("info");
    });

    it("matches the exact action string only, not a prefix or substring", () => {
        // "policy.delete" is critical-adjacent territory (warning) but
        // "policyVersion.propose" must not accidentally match via a loose
        // prefix check on "policy".
        expect(classifyAuditSeverity("policyVersion.propose")).toBe("info");
    });
});
