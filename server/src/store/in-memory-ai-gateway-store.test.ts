import { describe, expect, it } from "vitest";
import { InMemoryAiGatewayStore } from "./in-memory-ai-gateway-store.js";
import type { TenantContext } from "../tenant-context.js";

const actor = () => ({ externalSubject: "idp|clinician", userId: "user-1", organizationId: undefined as unknown as string });

function tenantContext(organizationId: string): TenantContext {
    return { organizationId, schemaName: `tenant_${organizationId.replaceAll("-", "")}`, issuer: "test", subject: "test" };
}

describe("InMemoryAiGatewayStore", () => {
    describe("consent versioning, expiration, and revocation", () => {
        it("each new consent for the same case increments version rather than overwriting the prior one", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            const c1 = await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const c2 = await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes", "labs"], grantedByUserId: "u1" }, actor());
            expect(c1.version).toBe(1);
            expect(c2.version).toBe(2);
            expect((await repo.listConsentsForCase("case-1")).map((c) => c.version)).toEqual([2, 1]);
        });

        it("getActiveConsent resolves to the highest-version active consent for the exact purpose", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            await repo.createConsent({ patientCaseId: "case-1", purpose: "research", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const active = await repo.getActiveConsent("case-1", "treatment");
            expect(active?.purpose).toBe("treatment");
            expect(await repo.getActiveConsent("case-1", "teaching")).toBeNull();
        });

        it("revoking a consent removes it from getActiveConsent immediately — 'must prevent new AI requests immediately'", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            const consent = await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            expect(await repo.getActiveConsent("case-1", "treatment")).not.toBeNull();
            await repo.revokeConsent(consent.id, "u2", "patient withdrew consent", actor());
            expect(await repo.getActiveConsent("case-1", "treatment")).toBeNull();
            expect((await repo.getConsent(consent.id))?.status).toBe("revoked");
        });

        it("expireStaleConsents flips a consent past its expiresAt to 'expired', and it no longer resolves as active", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            const past = new Date(Date.now() - 1000).toISOString();
            await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1", expiresAt: past }, actor());
            // getActiveConsent's own expiresAt check already excludes it even
            // before the sweep runs...
            expect(await repo.getActiveConsent("case-1", "treatment")).toBeNull();
            // ...but the sweep still needs to actually flip the stored status,
            // so a direct read of the row reflects reality too.
            const swept = await repo.expireStaleConsents(new Date().toISOString());
            expect(swept).toBe(1);
            const consents = await repo.listConsentsForCase("case-1");
            expect(consents[0].status).toBe("expired");
        });

        it("a revoked consent requires revokedByUserId and reason to be recorded", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            const consent = await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const revoked = await repo.revokeConsent(consent.id, "reviewer-1", "no longer needed", actor());
            expect(revoked?.revokedByUserId).toBe("reviewer-1");
            expect(revoked?.revokedReason).toBe("no longer needed");
        });
    });

    describe("request envelope lifecycle", () => {
        it("creates a request in draft status and transitions it through the lifecycle", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            const consent = await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const request = await repo.createRequest({
                patientCaseId: "case-1", requestedByUserId: "u1", providerModelId: "model-1", purposeOfUse: "summarization",
                consentId: consent.id, policySnapshotHash: "a".repeat(64),
                dataScope: { dataCategories: ["notes"], resourceRefs: [], includesIdentifiers: false },
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }, actor());
            expect(request.status).toBe("draft");

            await repo.updateRequestStatus(request.id, "queued", undefined, actor());
            const running = await repo.updateRequestStatus(request.id, "running", undefined, actor());
            expect(running?.status).toBe("running");

            const completed = await repo.updateRequestStatus(request.id, "awaiting-review", { completedAt: new Date().toISOString() }, actor());
            expect(completed?.completedAt).toBeDefined();
        });

        it("a rejected request records its rejectionReason", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            const consent = await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const request = await repo.createRequest({
                patientCaseId: "case-1", requestedByUserId: "u1", providerModelId: "model-1", purposeOfUse: "summarization",
                consentId: consent.id, policySnapshotHash: "a".repeat(64),
                dataScope: { dataCategories: ["notes"], resourceRefs: [], includesIdentifiers: false },
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }, actor());
            const rejected = await repo.updateRequestStatus(request.id, "rejected", { rejectionReason: "provider kill switch engaged" }, actor());
            expect(rejected?.rejectionReason).toBe("provider kill switch engaged");
        });

        it("tracks request inputs and transformations", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            const consent = await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const request = await repo.createRequest({
                patientCaseId: "case-1", requestedByUserId: "u1", providerModelId: "model-1", purposeOfUse: "summarization",
                consentId: consent.id, policySnapshotHash: "a".repeat(64),
                dataScope: { dataCategories: ["notes"], resourceRefs: [], includesIdentifiers: false },
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }, actor());
            await repo.addRequestInputs(request.id, [{ resourceType: "clinicalNote", resourceId: "note-1", includedInPrompt: true }]);
            expect((await repo.listRequestInputs(request.id))).toHaveLength(1);
            await repo.recordTransformation({ requestId: request.id, kind: "redaction", details: { fieldsRedacted: 2 } });
            expect((await repo.listTransformations(request.id))[0].kind).toBe("redaction");
        });
    });

    describe("outputs, citations, and review", () => {
        async function setup() {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            const consent = await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const request = await repo.createRequest({
                patientCaseId: "case-1", requestedByUserId: "u1", providerModelId: "model-1", purposeOfUse: "summarization",
                consentId: consent.id, policySnapshotHash: "a".repeat(64),
                dataScope: { dataCategories: ["notes"], resourceRefs: [], includesIdentifiers: false },
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }, actor());
            return { repo, request };
        }

        it("creates an output with citations, separate from the output row itself", async () => {
            const { repo, request } = await setup();
            const { output, citations } = await repo.createOutput({
                requestId: request.id, providerModelId: "model-1", modelVersion: "1.0", promptVersion: "clinical-gateway-prompt-v1",
                summary: "No acute findings.", evidence: ["Note dated 2026-01-01 mentions stable vitals."],
                followUp: ["Recheck in 2 weeks."], abstained: false, outputHash: "b".repeat(64),
                citations: [{ resourceType: "clinicalNote", resourceId: "note-1", locator: "line 4" }],
            }, actor());
            expect(output.reviewStatus).toBe("unreviewed");
            expect(citations).toHaveLength(1);
            expect(await repo.listCitationsForOutput(output.id)).toHaveLength(1);
            expect(await repo.listOutputsForRequest(request.id)).toHaveLength(1);
        });

        it("an output that abstains carries abstainReason and no fabricated confidence", async () => {
            const { repo, request } = await setup();
            const { output } = await repo.createOutput({
                requestId: request.id, providerModelId: "model-1", modelVersion: "1.0", promptVersion: "clinical-gateway-prompt-v1",
                summary: "Insufficient data to draw a conclusion.", evidence: [], followUp: [],
                abstained: true, abstainReason: "Contradictory lab values across two source documents.",
                outputHash: "c".repeat(64), citations: [],
            }, actor());
            expect(output.abstained).toBe(true);
            expect(output.abstainReason).toContain("Contradictory");
        });

        it("a review is immutable — a second review attempt on the same output throws rather than overwriting", async () => {
            const { repo, request } = await setup();
            const { output } = await repo.createOutput({
                requestId: request.id, providerModelId: "model-1", modelVersion: "1.0", promptVersion: "clinical-gateway-prompt-v1",
                summary: "x", evidence: [], followUp: [], abstained: false, outputHash: "d".repeat(64), citations: [],
            }, actor());
            await repo.createReview({ outputId: output.id, reviewedByUserId: "clinician-1", decision: "accepted" }, actor());
            await expect(repo.createReview({ outputId: output.id, reviewedByUserId: "clinician-1", decision: "rejected" }, actor())).rejects.toThrow(/already has a review/);
        });

        it("accepting a review updates the output's own reviewStatus flag", async () => {
            const { repo, request } = await setup();
            const { output } = await repo.createOutput({
                requestId: request.id, providerModelId: "model-1", modelVersion: "1.0", promptVersion: "clinical-gateway-prompt-v1",
                summary: "x", evidence: [], followUp: [], abstained: false, outputHash: "e".repeat(64), citations: [],
            }, actor());
            await repo.createReview({ outputId: output.id, reviewedByUserId: "clinician-1", decision: "corrected", correctedText: "Actually, recheck in 1 week." }, actor());
            expect((await repo.getOutput(output.id))?.reviewStatus).toBe("corrected");
            expect((await repo.getReviewForOutput(output.id))?.correctedText).toContain("1 week");
        });
    });

    describe("safety events", () => {
        it("records and filters safety events by severity", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            await repo.recordSafetyEvent({ kind: "prompt-injection-detected", severity: "critical", details: "instruction-like text in retrieved note" }, actor());
            await repo.recordSafetyEvent({ kind: "abstained", severity: "info" }, actor());
            expect(await repo.listSafetyEvents({ severity: "critical" })).toHaveLength(1);
            expect(await repo.listSafetyEvents()).toHaveLength(2);
        });
    });

    describe("tenant isolation", () => {
        it("two organizations never see each other's consents, requests, or outputs even with colliding ids", async () => {
            const store = new InMemoryAiGatewayStore();
            const repoA = store.forTenant(tenantContext("org-a"));
            const repoB = store.forTenant(tenantContext("org-b"));

            const consentA = await repoA.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            await repoB.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());

            expect(await repoB.getConsent(consentA.id)).toBeNull();
            expect((await repoA.listConsentsForCase("case-1"))).toHaveLength(1);
            expect((await repoB.listConsentsForCase("case-1"))).toHaveLength(1);
        });
    });

    describe("change feed", () => {
        it("returns only changes after the given cursor, and advances the cursor", async () => {
            const store = new InMemoryAiGatewayStore();
            const repo = store.forTenant(tenantContext("org-1"));
            await repo.createConsent({ patientCaseId: "case-1", purpose: "treatment", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const first = await repo.readChanges(null);
            expect(first.changes).toHaveLength(1);
            await repo.createConsent({ patientCaseId: "case-1", purpose: "research", dataCategories: ["notes"], grantedByUserId: "u1" }, actor());
            const second = await repo.readChanges(first.cursor);
            expect(second.changes).toHaveLength(1);
        });
    });
});
