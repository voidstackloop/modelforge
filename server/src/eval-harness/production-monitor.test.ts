import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAiGatewayStore } from "../store/in-memory-ai-gateway-store.js";
import type { TenantAiGatewayRepository } from "../store/ai-gateway-store.js";
import type { TenantContext } from "../tenant-context.js";
import { computeProductionQualitySnapshot, DEFAULT_DRIFT_THRESHOLDS, detectProductionQualityDrift } from "./production-monitor.js";

const actor = () => ({ externalSubject: "idp|clinician", userId: "user-1", organizationId: undefined as unknown as string });

function tenantContext(organizationId: string): TenantContext {
    return { organizationId, schemaName: `tenant_${organizationId.replaceAll("-", "")}`, issuer: "test", subject: "test" };
}

async function makeOutput(repo: TenantAiGatewayRepository, providerModelId: string, opts: { abstained?: boolean; review?: "accepted" | "rejected" | "corrected" | "escalated" }) {
    const { output } = await repo.createOutput(
        {
            requestId: "req-1",
            providerModelId,
            modelVersion: "v1",
            promptVersion: "clinical-gateway-prompt-v1",
            summary: opts.abstained ? "Abstained." : "No interactions found.",
            evidence: [],
            followUp: [],
            abstained: opts.abstained ?? false,
            abstainReason: opts.abstained ? "insufficient evidence" : undefined,
            outputHash: "a".repeat(64),
            citations: [],
        },
        actor()
    );
    if (opts.review) {
        await repo.createReview(
            {
                outputId: output.id,
                reviewedByUserId: "clinician-1",
                decision: opts.review,
                correctedText: opts.review === "corrected" ? "corrected text" : undefined,
                escalationReason: opts.review === "escalated" ? "needs specialist" : undefined,
            },
            actor()
        );
    }
    return output;
}

describe("computeProductionQualitySnapshot", () => {
    it("reports all-zero rates for a model with no outputs yet, never NaN/divide-by-zero", async () => {
        const repo = new InMemoryAiGatewayStore().forTenant(tenantContext("org-1"));
        const snapshot = await computeProductionQualitySnapshot(repo, "model-1");
        expect(snapshot).toMatchObject({ outputCount: 0, abstentionRate: 0, reviewedRate: 0, acceptanceRate: 0, rejectionRate: 0, correctionRate: 0, escalationRate: 0, unreviewedCount: 0 });
    });

    it("computes abstention rate over ALL outputs but decision rates only over REVIEWED outputs, so a review backlog doesn't dilute the acceptance rate", async () => {
        const repo = new InMemoryAiGatewayStore().forTenant(tenantContext("org-1"));
        await makeOutput(repo, "model-1", { review: "accepted" });
        await makeOutput(repo, "model-1", { review: "rejected" });
        await makeOutput(repo, "model-1", { abstained: true }); // unreviewed
        await makeOutput(repo, "model-1", {}); // unreviewed

        const snapshot = await computeProductionQualitySnapshot(repo, "model-1");
        expect(snapshot.outputCount).toBe(4);
        expect(snapshot.abstentionRate).toBeCloseTo(0.25, 5); // 1 of 4 abstained
        expect(snapshot.reviewedRate).toBeCloseTo(0.5, 5); // 2 of 4 reviewed
        expect(snapshot.unreviewedCount).toBe(2);
        expect(snapshot.acceptanceRate).toBeCloseTo(0.5, 5); // 1 of 2 REVIEWED
        expect(snapshot.rejectionRate).toBeCloseTo(0.5, 5);
    });

    it("only counts outputs for the requested provider model", async () => {
        const repo = new InMemoryAiGatewayStore().forTenant(tenantContext("org-1"));
        await makeOutput(repo, "model-1", { review: "accepted" });
        await makeOutput(repo, "model-2", { review: "rejected" });
        expect((await computeProductionQualitySnapshot(repo, "model-1")).outputCount).toBe(1);
        expect((await computeProductionQualitySnapshot(repo, "model-2")).outputCount).toBe(1);
    });
});

describe("detectProductionQualityDrift", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("reports insufficientData and never alerts when either window is below minimumOutputCount", async () => {
        const repo = new InMemoryAiGatewayStore().forTenant(tenantContext("org-1"));
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        await makeOutput(repo, "model-1", { review: "rejected" });
        const splitAt = new Date("2026-01-02T00:00:00Z").toISOString();
        vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
        await makeOutput(repo, "model-1", { review: "rejected" });

        const report = await detectProductionQualityDrift(repo, "model-1", undefined, splitAt);
        expect(report.sufficientData).toBe(false);
        expect(report.drifted).toBe(false);
        expect(report.alerts).toEqual([]);
    });

    it("flags a real rejection-rate spike between two well-populated windows, and never on a stable model", async () => {
        const repo = new InMemoryAiGatewayStore().forTenant(tenantContext("org-1"));
        const n = DEFAULT_DRIFT_THRESHOLDS.minimumOutputCount;

        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        for (let i = 0; i < n; i++) await makeOutput(repo, "model-1", { review: "accepted" }); // baseline: 100% accepted
        const splitAt = new Date("2026-01-02T00:00:00Z").toISOString();

        vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
        for (let i = 0; i < n; i++) await makeOutput(repo, "model-1", { review: "rejected" }); // current: 100% rejected

        const report = await detectProductionQualityDrift(repo, "model-1", undefined, splitAt);
        expect(report.sufficientData).toBe(true);
        expect(report.baseline.acceptanceRate).toBeCloseTo(1, 5);
        expect(report.current.rejectionRate).toBeCloseTo(1, 5);
        expect(report.drifted).toBe(true);
        expect(report.alerts.some((a) => a.includes("acceptance rate dropped"))).toBe(true);
        expect(report.alerts.some((a) => a.includes("rejection rate rose"))).toBe(true);
    });

    it("does not flag drift when a model behaves identically across both windows", async () => {
        const repo = new InMemoryAiGatewayStore().forTenant(tenantContext("org-1"));
        const n = DEFAULT_DRIFT_THRESHOLDS.minimumOutputCount;

        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        for (let i = 0; i < n; i++) await makeOutput(repo, "model-1", { review: "accepted" });
        const splitAt = new Date("2026-01-02T00:00:00Z").toISOString();
        vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
        for (let i = 0; i < n; i++) await makeOutput(repo, "model-1", { review: "accepted" });

        const report = await detectProductionQualityDrift(repo, "model-1", undefined, splitAt);
        expect(report.sufficientData).toBe(true);
        expect(report.drifted).toBe(false);
        expect(report.alerts).toEqual([]);
    });
});
