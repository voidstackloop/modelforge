import { z } from "zod";
import type { DownloadErrorKind } from "../download-jobs-store";
import type { NativeUnavailableReason } from "../native-capability";

// Typed, versioned event catalog for local operational telemetry — distinct
// from logger.ts (unstructured human-readable ops log) and audit-log-store.ts
// (compliance-oriented, tamper-evident, PHI-avoidant accountability trail).
// Every schema here is `.strict()`: an event with an unreviewed field fails
// validation at the point of recording rather than silently starting to flow
// into the local sink. Every field is a number, boolean, or a value drawn
// from a fixed, already-existing enum — never a filename, path, URL, or any
// other unbounded string — so cardinality is bounded by construction, not by
// a runtime scrub-after-the-fact step.

export const TELEMETRY_SCHEMA_VERSION = 1;

// Mirrors DownloadErrorKind (download-jobs-store.ts). Kept as an explicit
// literal list (rather than derived automatically) so a schema change there
// is a deliberate, reviewed edit here too; `satisfies` gives a compile-time
// guarantee every value listed is actually a valid DownloadErrorKind.
const DOWNLOAD_ERROR_KINDS = [
    "auth_required",
    "license_required",
    "not_found",
    "disk_space",
    "permission",
    "verification_failed",
    "network",
    "unknown",
] as const satisfies readonly DownloadErrorKind[];
export const downloadErrorKindSchema = z.enum(DOWNLOAD_ERROR_KINDS);

// Mirrors NativeUnavailableReason (native-capability.ts).
const NATIVE_UNAVAILABLE_REASONS = ["not-built", "abi-or-platform-mismatch", "load-error"] as const satisfies readonly NativeUnavailableReason[];
export const nativeUnavailableReasonSchema = z.enum(NATIVE_UNAVAILABLE_REASONS);

export const downloadOutcomeSchema = z.enum(["ready", "failed", "cancelled"]);
export type DownloadOutcome = z.infer<typeof downloadOutcomeSchema>;

// Shared envelope every event carries. `correlationId` is a job id for the
// download events below (already crosses the Electron/Rust N-API boundary
// as JobEvent.jobId — see lib/src/manager.rs) — not a newly-minted id.
function envelope<Name extends string, Fields extends z.ZodRawShape>(eventName: Name, fields: Fields) {
    return z
        .object({
            schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
            eventName: z.literal(eventName),
            timestamp: z.string().min(1),
            correlationId: z.string().min(1).optional(),
            ...fields,
        })
        .strict();
}

export const downloadStartedEventSchema = envelope("download_started", {
    shardCount: z.number().int().nonnegative(),
});

export const downloadResumedEventSchema = envelope("download_resumed", {
    shardCount: z.number().int().nonnegative(),
});

// Emitted at a coarse, documented cadence (see download-worker.ts's
// PROGRESS_SAMPLE_INTERVAL_MS) — not once per raw JobEvent progress tick,
// which would be an unbounded-volume, not unbounded-cardinality, problem.
export const downloadProgressSampledEventSchema = envelope("download_progress_sampled", {
    jobReceivedBytes: z.number().nonnegative(),
    totalBytes: z.number().nonnegative().optional(),
    bytesPerSecond: z.number().nonnegative().optional(),
});

export const downloadPausedEventSchema = envelope("download_paused", {});

export const downloadRetryEventSchema = envelope("download_retry", {
    attempt: z.number().int().positive(),
    errorKind: downloadErrorKindSchema,
});

export const downloadChecksumFailedEventSchema = envelope("download_checksum_failed", {});

export const downloadCompletedEventSchema = envelope("download_completed", {
    outcome: downloadOutcomeSchema,
    durationMs: z.number().nonnegative(),
    totalBytes: z.number().nonnegative().optional(),
    retryCount: z.number().int().nonnegative(),
    errorKind: downloadErrorKindSchema.optional(),
});

// `addon` is a closed enum (just "downloader" today) rather than a free
// string, so a future second native-addon surface (e.g. the SQLite audit
// store, or the JSON datastore helpers) is a deliberate schema edit, not an
// accidental new label value.
export const nativeAddonCapabilityEventSchema = envelope("native_addon_capability", {
    addon: z.enum(["downloader"]),
    available: z.boolean(),
    reason: nativeUnavailableReasonSchema.optional(),
});

// Local-inference lifecycle (docs/LOCAL_INFERENCE_HARDENING_PLAN.md §5) — this
// event family previously didn't exist at all: telemetry was download-
// pipeline-only, so no inference call ever generated any operational
// telemetry (latency, outcome) to feed performance-regression tracking or
// incident visibility. Deliberately just one event per call, unlike the
// multi-phase download lifecycle above — dispatchChat() resolves a single
// generation in one async call, with no separate pause/resume/retry phases
// to track. Runtime-crash detection (as its own distinct event, independent
// of any one call's outcome) is not attempted here — distinguishing "the
// backend process crashed" from "this call failed for an unrelated reason"
// needs its own design and is left for a future pass, not silently assumed.
const LOCAL_INFERENCE_PROVIDERS = ["llamacpp", "mlx", "rocm", "vllm", "custom"] as const;
export const localInferenceProviderSchema = z.enum(LOCAL_INFERENCE_PROVIDERS);

export const inferenceOutcomeSchema = z.enum(["success", "failed", "cancelled", "timed-out"]);
export type InferenceOutcome = z.infer<typeof inferenceOutcomeSchema>;

export const inferenceCompletedEventSchema = envelope("inference_completed", {
    provider: localInferenceProviderSchema,
    outcome: inferenceOutcomeSchema,
    durationMs: z.number().nonnegative(),
});

export const telemetryEventSchema = z.discriminatedUnion("eventName", [
    downloadStartedEventSchema,
    downloadResumedEventSchema,
    downloadProgressSampledEventSchema,
    downloadPausedEventSchema,
    downloadRetryEventSchema,
    downloadChecksumFailedEventSchema,
    downloadCompletedEventSchema,
    nativeAddonCapabilityEventSchema,
    inferenceCompletedEventSchema,
]);

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryEventName = TelemetryEvent["eventName"];

/** Fields a caller supplies for one event, i.e. the envelope minus the parts
 * recordEvent() itself always fills in (schemaVersion, eventName, timestamp). */
export type TelemetryEventInput<Name extends TelemetryEventName> = Omit<
    Extract<TelemetryEvent, { eventName: Name }>,
    "schemaVersion" | "eventName" | "timestamp"
>;
