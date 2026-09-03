import type { Hl7IngestionJob } from "@modelforge/contracts";
import type { TenantCaseRepository } from "../store/case-store.js";
import type { TenantHl7IngestionRepository } from "../store/hl7-ingestion-store.js";
import { buildAck, type AckContext } from "./ack-builder.js";
import { ingestInboundMessage } from "./ingestion.js";
import { DEFAULT_ENCODING_CHARACTERS, Hl7ParseError, parseHl7Message, type Hl7Message } from "./message.js";

/**
 * Wires hl7/ingestion.ts's `ingestInboundMessage` into an MLLP-shaped
 * `(rawMessage) => Promise<ackText>` handler for mllp-server.ts — the only
 * place in this codebase an inbound HL7 v2 message reaches the ingestion
 * pipeline with no bearer token/IAM check of its own (see mllp-server.ts's
 * own doc comment on why: MLLP's trust model is network-level, not
 * per-message). The synthetic audit actor below (`system:hl7-mllp`)
 * mirrors the same `"system:<job-name>"` convention this codebase already
 * uses for other automated, non-human-initiated actions.
 *
 * Never lets a raw error message (which could carry internal detail — a
 * database error, a stack frame) reach the wire in an ACK/NACK: an
 * `Hl7ParseError` reports its own (already user-safe) message, anything
 * else reports a fixed generic string, with the real error only ever
 * logged server-side via `onError`.
 */
export interface MllpIngestionHandlerOptions {
    organizationId: string;
    caseRepo: TenantCaseRepository;
    ingestionRepo: TenantHl7IngestionRepository;
    ackContext: AckContext;
    onIngested?: (job: Hl7IngestionJob) => void;
    onError?: (err: Error) => void;
}

const SYSTEM_ACTOR_SUBJECT = "system:hl7-mllp";

function summarize(job: Hl7IngestionJob): string {
    if (job.status === "applied") return job.messageType === "ORU^R01" ? `applied — ${job.observationsAdded ?? 0} observation(s) added` : "applied — visit event recorded";
    if (job.matchStatus === "ambiguous") return "ambiguous patient match — queued for review";
    if (job.matchStatus === "no-match") return "no matching patient — queued for review";
    return "queued for review";
}

export function createMllpIngestionHandler(options: MllpIngestionHandlerOptions): (rawMessage: string) => Promise<string> {
    return async (rawMessage: string): Promise<string> => {
        let original: Hl7Message;
        try {
            original = parseHl7Message(rawMessage);
        } catch {
            // Can't even extract MSH-10 to reference in MSA-2 — build the
            // most minimal reject possible against an empty stand-in.
            return buildAck({ segments: [], encoding: DEFAULT_ENCODING_CHARACTERS }, "AR", options.ackContext, "malformed message: could not parse an MSH segment");
        }

        try {
            const { job } = await ingestInboundMessage(options.caseRepo, options.ingestionRepo, rawMessage, { externalSubject: SYSTEM_ACTOR_SUBJECT, organizationId: options.organizationId });
            options.onIngested?.(job);
            return buildAck(original, "AA", options.ackContext, summarize(job));
        } catch (err) {
            if (err instanceof Hl7ParseError) return buildAck(original, "AR", options.ackContext, err.message);
            options.onError?.(err instanceof Error ? err : new Error(String(err)));
            return buildAck(original, "AE", options.ackContext, "internal processing error");
        }
    };
}
