import { describe, it, expect } from "vitest";
import { createMetricsRegistry, DOWNLOAD_DURATION_BUCKETS_SECONDS } from "./metrics";

describe("metrics registry", () => {
    it("starts every counter at zero", () => {
        const registry = createMetricsRegistry();
        const snapshot = registry.snapshot();
        expect(snapshot.downloadsStartedTotal).toBe(0);
        expect(snapshot.downloadChecksumFailuresTotal).toBe(0);
        expect(snapshot.downloadBytesTotal).toBe(0);
        expect(snapshot.nativeAddonUnavailableTotal).toBe(0);
        for (const outcome of ["ready", "failed", "cancelled"] as const) expect(snapshot.downloadsCompletedTotal[outcome]).toBe(0);
    });

    it("a simple counter accumulates across increments", () => {
        const registry = createMetricsRegistry();
        registry.downloadsStarted.inc();
        registry.downloadsStarted.inc();
        registry.downloadsStarted.inc(5);
        expect(registry.snapshot().downloadsStartedTotal).toBe(7);
    });

    it("a labeled counter tracks each label value independently", () => {
        const registry = createMetricsRegistry();
        registry.downloadsCompleted.inc("ready");
        registry.downloadsCompleted.inc("ready");
        registry.downloadsCompleted.inc("failed");
        const snapshot = registry.snapshot().downloadsCompletedTotal;
        expect(snapshot.ready).toBe(2);
        expect(snapshot.failed).toBe(1);
        expect(snapshot.cancelled).toBe(0);
    });

    it("a labeled counter rejects a value outside its declared set (bounded cardinality enforced at runtime, not just by types)", () => {
        const registry = createMetricsRegistry();
        // @ts-expect-error deliberately passing an out-of-enum label to prove the runtime guard, not just the compile-time one
        expect(() => registry.downloadRetries.inc("totally_made_up_kind")).toThrow();
    });

    it("independent registries do not share state", () => {
        const a = createMetricsRegistry();
        const b = createMetricsRegistry();
        a.downloadsStarted.inc();
        expect(a.snapshot().downloadsStartedTotal).toBe(1);
        expect(b.snapshot().downloadsStartedTotal).toBe(0);
    });

    describe("histogram", () => {
        it("places an observation in the first bucket boundary it doesn't exceed", () => {
            const registry = createMetricsRegistry();
            registry.downloadDurationSeconds.observe(3); // <= 5
            const { cumulativeBuckets, count, sum } = registry.snapshot().downloadDurationSecondsHistogram;
            expect(cumulativeBuckets["1"]).toBe(0);
            expect(cumulativeBuckets["5"]).toBe(1);
            expect(cumulativeBuckets["15"]).toBe(1); // cumulative — still includes the same observation
            expect(count).toBe(1);
            expect(sum).toBe(3);
        });

        it("places an observation larger than every boundary into +Inf only", () => {
            const registry = createMetricsRegistry();
            const largest = DOWNLOAD_DURATION_BUCKETS_SECONDS[DOWNLOAD_DURATION_BUCKETS_SECONDS.length - 1];
            registry.downloadDurationSeconds.observe(largest * 10);
            const { cumulativeBuckets } = registry.snapshot().downloadDurationSecondsHistogram;
            for (const boundary of DOWNLOAD_DURATION_BUCKETS_SECONDS) expect(cumulativeBuckets[String(boundary)]).toBe(0);
            expect(cumulativeBuckets["+Inf"]).toBe(1);
        });

        it("accumulates count and sum across multiple observations", () => {
            const registry = createMetricsRegistry();
            registry.downloadDurationSeconds.observe(1);
            registry.downloadDurationSeconds.observe(2);
            registry.downloadDurationSeconds.observe(100);
            const { count, sum } = registry.snapshot().downloadDurationSecondsHistogram;
            expect(count).toBe(3);
            expect(sum).toBe(103);
        });
    });
});
