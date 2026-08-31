import { downloadErrorKindSchema, downloadOutcomeSchema, type DownloadOutcome } from "./schema";
import type { DownloadErrorKind } from "../download-jobs-store";

// A minimal, hand-rolled bounded metrics registry — no metrics library
// dependency is justified for the handful of counters/one histogram this
// slice needs (see the plan's "no new dependency" decision). Every labeled
// metric's legal label values are fixed at construction time from an
// existing enum (schema.ts's downloadErrorKindSchema/downloadOutcomeSchema,
// themselves mirrors of DownloadErrorKind/the 3-value download outcome) —
// both a TypeScript-level and a runtime guard against an unbounded label.

export interface SimpleCounter {
    inc(amount?: number): void;
    value(): number;
}

function createSimpleCounter(): SimpleCounter {
    let total = 0;
    return {
        inc(amount = 1) {
            total += amount;
        },
        value: () => total,
    };
}

export interface Counter<L extends string> {
    inc(label: L, amount?: number): void;
    snapshot(): Record<L, number>;
}

function createCounter<L extends string>(name: string, labelValues: readonly L[]): Counter<L> {
    const counts = new Map<L, number>(labelValues.map((label) => [label, 0]));
    return {
        inc(label, amount = 1) {
            if (!counts.has(label)) throw new Error(`metric "${name}": "${label}" is not one of its declared label values`);
            counts.set(label, (counts.get(label) ?? 0) + amount);
        },
        snapshot: () => Object.fromEntries(counts) as Record<L, number>,
    };
}

export interface HistogramSnapshot {
    /** Cumulative count of observations <= each boundary, keyed by that
     * boundary (Prometheus's own "le" — less-than-or-equal — convention),
     * plus an "+Inf" bucket for everything above the largest boundary. */
    cumulativeBuckets: Record<string, number>;
    count: number;
    sum: number;
}

export interface Histogram {
    observe(value: number): void;
    snapshot(): HistogramSnapshot;
}

function createHistogram(boundaries: readonly number[]): Histogram {
    const perBucketCounts = new Array<number>(boundaries.length + 1).fill(0); // last slot is "+Inf"
    let count = 0;
    let sum = 0;
    return {
        observe(value) {
            count += 1;
            sum += value;
            const bucketIndex = boundaries.findIndex((boundary) => value <= boundary);
            perBucketCounts[bucketIndex === -1 ? boundaries.length : bucketIndex] += 1;
        },
        snapshot() {
            const cumulativeBuckets: Record<string, number> = {};
            let running = 0;
            for (let i = 0; i < boundaries.length; i++) {
                running += perBucketCounts[i];
                cumulativeBuckets[String(boundaries[i])] = running;
            }
            cumulativeBuckets["+Inf"] = running + perBucketCounts[boundaries.length];
            return { cumulativeBuckets, count, sum };
        },
    };
}

// Seconds. Covers a small file finishing in a few seconds through a
// multi-GB model over a slow link taking most of an hour — the aggregation
// window a caller cares about for this metric is "one whole download," not
// a rolling window, so there's no separate time-window config beyond these
// boundaries themselves.
export const DOWNLOAD_DURATION_BUCKETS_SECONDS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600] as const;

export interface MetricsRegistry {
    downloadsStarted: SimpleCounter;
    downloadsCompleted: Counter<DownloadOutcome>;
    downloadRetries: Counter<DownloadErrorKind>;
    downloadChecksumFailures: SimpleCounter;
    downloadBytesTotal: SimpleCounter;
    downloadDurationSeconds: Histogram;
    nativeAddonUnavailable: SimpleCounter;
    snapshot(): {
        downloadsStartedTotal: number;
        downloadsCompletedTotal: Record<DownloadOutcome, number>;
        downloadRetriesTotal: Record<DownloadErrorKind, number>;
        downloadChecksumFailuresTotal: number;
        downloadBytesTotal: number;
        downloadDurationSecondsHistogram: HistogramSnapshot;
        nativeAddonUnavailableTotal: number;
    };
}

/** Builds a fresh, isolated registry — the production singleton lives in
 * index.ts; tests construct their own via this function instead of sharing
 * (and needing to reset) global state. */
export function createMetricsRegistry(): MetricsRegistry {
    const downloadsStarted = createSimpleCounter();
    const downloadsCompleted = createCounter("downloads_completed_total", downloadOutcomeSchema.options);
    const downloadRetries = createCounter("download_retries_total", downloadErrorKindSchema.options);
    const downloadChecksumFailures = createSimpleCounter();
    const downloadBytesTotal = createSimpleCounter();
    const downloadDurationSeconds = createHistogram(DOWNLOAD_DURATION_BUCKETS_SECONDS);
    const nativeAddonUnavailable = createSimpleCounter();

    return {
        downloadsStarted,
        downloadsCompleted,
        downloadRetries,
        downloadChecksumFailures,
        downloadBytesTotal,
        downloadDurationSeconds,
        nativeAddonUnavailable,
        snapshot: () => ({
            downloadsStartedTotal: downloadsStarted.value(),
            downloadsCompletedTotal: downloadsCompleted.snapshot(),
            downloadRetriesTotal: downloadRetries.snapshot(),
            downloadChecksumFailuresTotal: downloadChecksumFailures.value(),
            downloadBytesTotal: downloadBytesTotal.value(),
            downloadDurationSecondsHistogram: downloadDurationSeconds.snapshot(),
            nativeAddonUnavailableTotal: nativeAddonUnavailable.value(),
        }),
    };
}
