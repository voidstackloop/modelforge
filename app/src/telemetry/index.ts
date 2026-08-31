import { logger } from "../logger";
import { telemetryEventSchema, TELEMETRY_SCHEMA_VERSION, type TelemetryEventInput, type TelemetryEventName } from "./schema";
import { TelemetrySink } from "./sink";
import { createMetricsRegistry } from "./metrics";

// The small, provider-neutral internal API other modules record telemetry
// through. Local-only: writes to a JSONL file on disk and updates in-process
// metrics; there is no remote exporter yet (see the plan's "local-only, no
// consent UI needed for this pass" decision — this is the same local trust
// boundary app.log already operates under, not a new one).

const sink = new TelemetrySink();
export const metrics = createMetricsRegistry();

export { newCorrelationId, withCorrelation, getCorrelationId } from "./correlation";
export { redactText, redactDeep } from "./redact";
export type { TelemetryEvent, TelemetryEventName, DownloadOutcome } from "./schema";

/** Validates and records one telemetry event. Never throws — a schema
 * mismatch (a caller bug) or a sink write failure (disk full, permission
 * denied) is logged and otherwise swallowed: recording telemetry must never
 * be the reason a real operation (a download, a chat request) fails. */
export function recordEvent<Name extends TelemetryEventName>(eventName: Name, fields: TelemetryEventInput<Name>): void {
    const candidate = {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        eventName,
        timestamp: new Date().toISOString(),
        ...fields,
    };
    const result = telemetryEventSchema.safeParse(candidate);
    if (!result.success) {
        logger.error(`Telemetry event "${eventName}" failed schema validation: ${result.error.message}`);
        return;
    }
    sink.write(result.data);
}

export function getTelemetrySnapshot() {
    return metrics.snapshot();
}
