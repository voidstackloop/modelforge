import { z } from "zod";

/**
 * Inbound HL7 v2 ingestion — tracking what happened when an inbound
 * message (ORU^R01 lab result, or an ADT admit/update event) was matched
 * against this tenant's patient cases. See server/src/hl7/ingestion.ts for
 * the actual match/apply logic and docs/HL7_V2_INTEGRATION.md for the full
 * architecture and disclosed scope.
 *
 * Same "ambiguous match requires human review, never a guess" discipline
 * as clinical imaging's own DICOM patient matching (packages/contracts's
 * imaging.ts, `ImagingIngestionJob`) — this schema is deliberately
 * structured the same way: a job row persists regardless of outcome,
 * `matchStatus` records what patient-matching found, `status` records
 * what (if anything) was actually applied to a case as a result.
 */
const identifierSchema = z.string().min(1).max(200);
const timestampSchema = z.string().datetime({ offset: true });

export const hl7IngestionMatchStatusSchema = z.enum(["matched", "ambiguous", "no-match"]);
export const hl7IngestionStatusSchema = z.enum(["pending-review", "applied", "rejected"]);

export const hl7IngestionJobSchema = z
    .object({
        id: identifierSchema,
        /** e.g. "ORU^R01", "ADT^A01", "ADT^A08" — free text, not a closed
         * enum, since HL7 v2 trigger events are inherently open-ended (see
         * server/src/hl7/adt-parser.ts's own doc comment on accepting any
         * ADT trigger event uniformly). */
        messageType: z.string().min(1).max(20),
        messageControlId: z.string().max(200),
        /** The raw inbound message text — kept for review (a reviewer
         * resolving an ambiguous/no-match job needs to see what the
         * message actually said), same "clinical text lives directly in a
         * tenant-schema row" pattern as AiOutput.summary/PatientCase's own
         * clinicalNotes, not a separate blob store. */
        rawMessage: z.string().min(1).max(50_000),
        receivedAt: timestampSchema,
        patientIdentifierValue: z.string().max(200).optional(),
        patientIdentifierIssuer: z.string().max(200).optional(),
        matchStatus: hl7IngestionMatchStatusSchema,
        matchedCaseId: identifierSchema.optional(),
        /** Populated only when matchStatus is "ambiguous" — the actual
         * candidate case ids a reviewer must choose between, never a
         * silent pick-one. */
        candidateCaseIds: z.array(identifierSchema).max(200).optional(),
        status: hl7IngestionStatusSchema,
        /** Set only for an applied ORU message — how many observations
         * were merged into the matched case's labResults. Always 0 for an
         * applied ADT message (see ingestion.ts: ADT has no case field of
         * its own to update once the patient is matched — the job record
         * itself is the audit trail of "this visit event was received and
         * recognized," not a data mutation). */
        observationsAdded: z.number().int().nonnegative().optional(),
        reviewedByUserId: identifierSchema.optional(),
        reviewedAt: timestampSchema.optional(),
        rejectionReason: z.string().max(2_000).optional(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict()
    .refine((v) => v.matchStatus !== "ambiguous" || (v.candidateCaseIds !== undefined && v.candidateCaseIds.length > 1), {
        message: "an ambiguous match must list its candidate case ids",
        path: ["candidateCaseIds"],
    })
    .refine((v) => v.matchStatus !== "matched" || v.status === "pending-review" || v.matchedCaseId !== undefined, {
        message: "an applied/rejected job with matchStatus matched must record matchedCaseId",
        path: ["matchedCaseId"],
    })
    .refine((v) => (v.status === "rejected") === (v.rejectionReason !== undefined), {
        message: "rejectionReason is required for (and only for) a rejected job",
        path: ["rejectionReason"],
    })
    .refine((v) => (v.reviewedByUserId !== undefined) === (v.reviewedAt !== undefined), {
        message: "reviewedByUserId and reviewedAt must be set together",
        path: ["reviewedAt"],
    });
export type Hl7IngestionJob = z.infer<typeof hl7IngestionJobSchema>;
