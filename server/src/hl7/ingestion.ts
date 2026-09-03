import type { Hl7IngestionJob, LabResult } from "@modelforge/contracts";
import type { TenantCaseRepository } from "../store/case-store.js";
import type { TenantHl7IngestionRepository } from "../store/hl7-ingestion-store.js";
import type { AuditActor } from "../store/audit-store.js";
import { getField, Hl7ParseError, parseHl7Message, splitComponents } from "./message.js";
import { parseOruR01 } from "./inbound-parser.js";
import { parseAdtMessage } from "./adt-parser.js";

/**
 * The shared match/apply pipeline both the HTTP ingestion route
 * (routes/hl7.ts) and, in principle, an MLLP listener (mllp-server.ts) —
 * or any other future inbound transport — call into. Kept separate from
 * both so the actual clinical-safety logic (patient matching, what "apply"
 * means per message type) lives in exactly one place regardless of how a
 * message arrived.
 *
 * Patient matching: exact string equality against a case's own effective
 * patientId (`patientCase.patientId ?? patientCase.id`, the same fallback
 * routes/cases.ts's own resourceForCreate uses) — no fuzzy matching, no
 * partial matching. Zero matches or more than one are BOTH treated as
 * "cannot safely auto-apply," never a guess — the same discipline
 * imaging's own DICOM patient-matching algorithm uses (docs/IMAGING.md).
 * This is deliberately less sophisticated than imaging's own matching
 * (which also considers the identifier's issuer) because PatientCase.patientId
 * is a bare string with no issuer concept anywhere in this system's domain
 * model — a real, disclosed limitation, not an oversight.
 */

export interface IngestOutcome {
    job: Hl7IngestionJob;
}

async function findMatchingCases(caseRepo: TenantCaseRepository, patientIdentifierValue: string): Promise<string[]> {
    const cases = await caseRepo.readAll();
    return cases.filter((c) => (c.patientId ?? c.id) === patientIdentifierValue).map((c) => c.id);
}

/** Appends `newResults` to `caseId`'s labResults field, retrying once on an
 * optimistic-concurrency conflict (a clinician editing the case at the same
 * moment ingestion runs — rare, but not impossible, and worth one retry
 * rather than either silently losing the clinician's concurrent edit or
 * silently dropping the inbound results). A second conflict gives up rather
 * than looping — the caller treats that as "could not apply," never as a
 * a fabricated success. */
async function appendLabResults(caseRepo: TenantCaseRepository, caseId: string, newResults: LabResult[], actor: AuditActor): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = await caseRepo.getOne(caseId);
        if (!current) return false;
        const updated = {
            ...current.patientCase,
            labResults: { ...current.patientCase.labResults, value: [...current.patientCase.labResults.value, ...newResults] },
            updatedAt: new Date().toISOString(),
        };
        const result = await caseRepo.writeOne(updated, current.patientCase.version ?? null, actor, current.resource);
        if (!("conflict" in result)) return true;
    }
    return false;
}

/**
 * Parses and ingests a raw inbound HL7 v2 message: detects ORU^R01 vs. ADT
 * by MSH-9, matches the patient, and — only for an unambiguous single
 * match — applies it (an ORU's observations merge into the matched case's
 * labResults; an ADT has no case field of its own to update once matched,
 * so "applying" it just records the job as applied with zero observations,
 * the audit trail of "this visit event was received and recognized").
 * Anything else (no PID, zero matches, multiple matches, an unsupported
 * message type) creates a `pending-review` job and touches no case data.
 * Throws Hl7ParseError only for a message that isn't well-formed HL7 at
 * all, or isn't ORU/ADT — never for a message that parses fine but simply
 * can't be matched, which is a normal, expected outcome recorded on the
 * job, not an error.
 */
export async function ingestInboundMessage(caseRepo: TenantCaseRepository, ingestionRepo: TenantHl7IngestionRepository, rawMessage: string, actor: AuditActor): Promise<IngestOutcome> {
    // Parse once, just to read MSH-9's own message-type component (the
    // real, spec-correct way to determine message type — never a
    // hand-rolled fixed-offset string peek, which broke on this exact
    // input the first time this was written: MSH-2's own encoding
    // characters aren't a fixed width relative to MSH-9's position without
    // going through the real field-splitting logic). parseOruR01/
    // parseAdtMessage each re-parse below — cheap for a message this
    // small, and keeps each parser fully self-contained.
    const probe = parseHl7Message(rawMessage);
    const probeMsh = probe.segments.find((s) => s.id === "MSH");
    if (!probeMsh) throw new Hl7ParseError("Message has no MSH segment.");
    const [detectedType] = splitComponents(getField(probeMsh, 9), probe.encoding);

    let messageType: string;
    let messageControlId: string;
    let patientIdentifier: { value: string; issuer: string } | undefined;
    let observations: LabResult[] = [];

    if (detectedType === "ORU") {
        const parsed = parseOruR01(rawMessage);
        messageType = "ORU^R01";
        messageControlId = parsed.messageControlId;
        patientIdentifier = parsed.patientIdentifier;
        observations = parsed.observations;
    } else if (detectedType === "ADT") {
        const parsed = parseAdtMessage(rawMessage);
        messageType = `ADT^${parsed.triggerEvent || "?"}`;
        messageControlId = parsed.messageControlId;
        patientIdentifier = parsed.patientIdentifier;
    } else {
        throw new Hl7ParseError(`Unsupported inbound message type${detectedType ? ` "${detectedType}"` : ""} — only ORU and ADT are ingested.`);
    }

    const candidateCaseIds = patientIdentifier ? await findMatchingCases(caseRepo, patientIdentifier.value) : [];
    const receivedAt = new Date().toISOString();
    const baseInput = {
        messageType,
        messageControlId,
        rawMessage,
        receivedAt,
        patientIdentifierValue: patientIdentifier?.value,
        patientIdentifierIssuer: patientIdentifier?.issuer,
    };

    if (candidateCaseIds.length === 1) {
        const caseId = candidateCaseIds[0];
        if (messageType === "ORU^R01") {
            const applied = await appendLabResults(caseRepo, caseId, observations, actor);
            if (applied) {
                const job = await ingestionRepo.createJob({ ...baseInput, matchStatus: "matched", matchedCaseId: caseId, status: "applied", observationsAdded: observations.length }, actor);
                return { job };
            }
            // The one case that matched vanished or hit a concurrency
            // conflict twice in a row between matching and writing —
            // record it for a human to sort out rather than silently
            // dropping the results.
            const job = await ingestionRepo.createJob({ ...baseInput, matchStatus: "matched", matchedCaseId: caseId, status: "pending-review" }, actor);
            return { job };
        }
        // ADT: the patient is matched, there is no further case field to
        // update — the job record itself is the outcome.
        const job = await ingestionRepo.createJob({ ...baseInput, matchStatus: "matched", matchedCaseId: caseId, status: "applied", observationsAdded: 0 }, actor);
        return { job };
    }

    const matchStatus = candidateCaseIds.length === 0 ? "no-match" : "ambiguous";
    const job = await ingestionRepo.createJob(
        { ...baseInput, matchStatus, candidateCaseIds: candidateCaseIds.length > 1 ? candidateCaseIds : undefined, status: "pending-review" },
        actor
    );
    return { job };
}

export type ResolveDecision = { action: "apply"; caseId: string } | { action: "reject"; reason: string };

export class Hl7IngestionResolutionError extends Error {}

/**
 * Resolves a `pending-review` job: "apply" merges the job's already-
 * parsed content into a reviewer-chosen case (must be one of the job's own
 * `candidateCaseIds` when the job was ambiguous — a reviewer picks among
 * what was actually found, never an arbitrary case id, keeping this
 * consistent with imaging's own "reject citations/matches the requesting
 * scope didn't actually produce" discipline); "reject" just records why,
 * touching no case data. Re-parses `job.rawMessage` rather than trusting
 * any cached observations, so resolution always reflects the message
 * exactly as received.
 */
export async function resolveIngestionJob(caseRepo: TenantCaseRepository, ingestionRepo: TenantHl7IngestionRepository, jobId: string, decision: ResolveDecision, reviewerUserId: string, actor: AuditActor): Promise<Hl7IngestionJob | null> {
    const job = await ingestionRepo.getJob(jobId);
    if (!job) return null;
    if (job.status !== "pending-review") throw new Hl7IngestionResolutionError(`Job ${jobId} is already "${job.status}" — only a pending-review job can be resolved.`);

    const reviewedAt = new Date().toISOString();
    if (decision.action === "reject") {
        return ingestionRepo.updateJob(jobId, { status: "rejected", rejectionReason: decision.reason, reviewedByUserId: reviewerUserId, reviewedAt }, actor);
    }

    if (job.matchStatus === "ambiguous" && !(job.candidateCaseIds ?? []).includes(decision.caseId)) {
        throw new Hl7IngestionResolutionError(`Case ${decision.caseId} was not among this job's own candidate matches.`);
    }
    const targetCase = await caseRepo.getOne(decision.caseId);
    if (!targetCase) throw new Hl7IngestionResolutionError(`Case ${decision.caseId} does not exist in this tenant.`);

    let observationsAdded = 0;
    if (job.messageType === "ORU^R01") {
        const parsed = parseOruR01(job.rawMessage);
        const applied = await appendLabResults(caseRepo, decision.caseId, parsed.observations, actor);
        if (!applied) throw new Hl7IngestionResolutionError(`Could not apply to case ${decision.caseId} — a concurrent edit conflict occurred twice; retry.`);
        observationsAdded = parsed.observations.length;
    }

    return ingestionRepo.updateJob(jobId, { status: "applied", matchedCaseId: decision.caseId, observationsAdded, reviewedByUserId: reviewerUserId, reviewedAt }, actor);
}
