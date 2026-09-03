import { z } from "zod";

/**
 * FHIR R4 resource shapes exposed by server/src/routes/fhir.ts.
 *
 * Scope, deliberately: this is a **read-only FHIR R4 facade** over data that
 * already lives in this system's own domain stores (patient_cases, clinical
 * imaging) — not a general-purpose FHIR resource server, not a new
 * persistence layer, and not a validator for arbitrary inbound FHIR
 * resources. Four resource types are mapped (Patient, DiagnosticReport,
 * ImagingStudy, DocumentReference), chosen because this codebase already has
 * an internal shape close enough to map faithfully — see
 * server/src/fhir/mappers.ts for the mapping and its own disclosed
 * approximations (most notably: Patient has no structured name/birthDate
 * anywhere in this system, so those FHIR fields are simply absent rather
 * than fabricated). docs/FHIR_INTEGRATION.md has the full scope statement,
 * what's NOT implemented (write API, most other R4 resource types, terminology
 * validation, `_include`/chained search, versioned history), and why.
 *
 * Every schema below is `.strict()` the same way the rest of this package is
 * — safe here because these resources are only ever server-constructed
 * (mappers.ts), never parsed from untrusted client input; there is no FHIR
 * write API yet for a real client to send us one of these.
 */

const fhirId = z.string().min(1).max(200);
const fhirInstant = z.string().datetime({ offset: true });
const fhirDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "must be a FHIR date (YYYY, YYYY-MM, or YYYY-MM-DD)");

export const fhirIdentifierSchema = z
    .object({
        system: z.string().max(500).optional(),
        value: z.string().min(1).max(500),
    })
    .strict();
export type FhirIdentifier = z.infer<typeof fhirIdentifierSchema>;

export const fhirCodingSchema = z
    .object({
        system: z.string().max(500).optional(),
        code: z.string().max(200).optional(),
        display: z.string().max(500).optional(),
    })
    .strict();

export const fhirCodeableConceptSchema = z
    .object({
        coding: z.array(fhirCodingSchema).max(50).optional(),
        text: z.string().max(2_000).optional(),
    })
    .strict();
export type FhirCodeableConcept = z.infer<typeof fhirCodeableConceptSchema>;

export const fhirReferenceSchema = z
    .object({
        reference: z.string().max(1_000).optional(),
        display: z.string().max(500).optional(),
    })
    .strict();
export type FhirReference = z.infer<typeof fhirReferenceSchema>;

export const fhirExtensionSchema = z
    .object({
        url: z.string().min(1).max(500),
        valueString: z.string().max(2_000).optional(),
    })
    .strict();

export const fhirMetaSchema = z
    .object({
        lastUpdated: fhirInstant.optional(),
    })
    .strict();

// --- Patient ---
// Administrative gender only — a coded FHIR field this system's free-text
// `sex` case field is heuristically mapped onto (see mappers.ts). Never a
// clinical/biological-sex assertion.
export const fhirAdministrativeGenderSchema = z.enum(["male", "female", "other", "unknown"]);

export const fhirPatientSchema = z
    .object({
        resourceType: z.literal("Patient"),
        id: fhirId,
        meta: fhirMetaSchema.optional(),
        active: z.boolean().optional(),
        identifier: z.array(fhirIdentifierSchema).max(50).optional(),
        gender: fhirAdministrativeGenderSchema.optional(),
        // No `name`/`birthDate`: this system has no structured field for
        // either anywhere in its domain model (patientCaseSchema's
        // `demographics.age` is free text, not a birthDate). Fabricating
        // either here would be worse than omitting them.
        extension: z.array(fhirExtensionSchema).max(20).optional(),
    })
    .strict();
export type FhirPatient = z.infer<typeof fhirPatientSchema>;

// --- DiagnosticReport ---
export const fhirDiagnosticReportStatusSchema = z.enum(["preliminary", "final", "amended", "corrected", "cancelled", "entered-in-error"]);

export const fhirDiagnosticReportSchema = z
    .object({
        resourceType: z.literal("DiagnosticReport"),
        id: fhirId,
        meta: fhirMetaSchema.optional(),
        status: fhirDiagnosticReportStatusSchema,
        code: fhirCodeableConceptSchema,
        subject: fhirReferenceSchema.optional(),
        issued: fhirInstant.optional(),
        effectiveDateTime: fhirInstant.optional(),
        conclusion: z.string().max(100_000).optional(),
        conclusionCode: z.array(fhirCodeableConceptSchema).max(20).optional(),
        imagingStudy: z.array(fhirReferenceSchema).max(20).optional(),
        extension: z.array(fhirExtensionSchema).max(20).optional(),
    })
    .strict();
export type FhirDiagnosticReport = z.infer<typeof fhirDiagnosticReportSchema>;

// --- ImagingStudy ---
export const fhirImagingStudyStatusSchema = z.enum(["registered", "available", "cancelled", "entered-in-error", "unknown"]);

export const fhirImagingStudySeriesSchema = z
    .object({
        uid: z.string().min(1).max(200),
        number: z.number().int().nonnegative().optional(),
        modality: fhirCodingSchema,
        description: z.string().max(2_000).optional(),
        numberOfInstances: z.number().int().nonnegative().optional(),
    })
    .strict();

export const fhirImagingStudySchema = z
    .object({
        resourceType: z.literal("ImagingStudy"),
        id: fhirId,
        meta: fhirMetaSchema.optional(),
        status: fhirImagingStudyStatusSchema,
        identifier: z.array(fhirIdentifierSchema).max(10).optional(),
        modality: z.array(fhirCodingSchema).max(50).optional(),
        subject: fhirReferenceSchema.optional(),
        started: fhirInstant.optional(),
        numberOfSeries: z.number().int().nonnegative().optional(),
        numberOfInstances: z.number().int().nonnegative().optional(),
        description: z.string().max(2_000).optional(),
        series: z.array(fhirImagingStudySeriesSchema).max(1_000).optional(),
    })
    .strict();
export type FhirImagingStudy = z.infer<typeof fhirImagingStudySchema>;

// --- DocumentReference ---
// Always "current": this system's internal DocumentReference (imaging.ts)
// tracks no superseded/entered-in-error lifecycle state, so those FHIR
// status values are never emitted (not the same claim as "never happens" —
// see mappers.ts's doc comment on this specific gap).
export const fhirDocumentReferenceStatusSchema = z.enum(["current"]);

export const fhirAttachmentSchema = z
    .object({
        contentType: z.string().max(200).optional(),
        size: z.number().int().nonnegative().optional(),
        hash: z.string().max(200).optional(),
        title: z.string().max(2_000).optional(),
    })
    .strict();

export const fhirDocumentReferenceSchema = z
    .object({
        resourceType: z.literal("DocumentReference"),
        id: fhirId,
        status: fhirDocumentReferenceStatusSchema,
        type: fhirCodeableConceptSchema.optional(),
        subject: fhirReferenceSchema.optional(),
        date: fhirInstant.optional(),
        content: z.array(z.object({ attachment: fhirAttachmentSchema }).strict()).min(1).max(1),
    })
    .strict();
export type FhirDocumentReference = z.infer<typeof fhirDocumentReferenceSchema>;

// --- OperationOutcome ---
export const fhirIssueSeveritySchema = z.enum(["fatal", "error", "warning", "information"]);
export const fhirIssueCodeSchema = z.enum(["not-found", "forbidden", "invalid", "processing"]);

export const fhirOperationOutcomeSchema = z
    .object({
        resourceType: z.literal("OperationOutcome"),
        issue: z
            .array(
                z
                    .object({
                        severity: fhirIssueSeveritySchema,
                        code: fhirIssueCodeSchema,
                        diagnostics: z.string().max(2_000).optional(),
                    })
                    .strict()
            )
            .min(1),
    })
    .strict();
export type FhirOperationOutcome = z.infer<typeof fhirOperationOutcomeSchema>;

// --- Bundle (searchset only — this facade has no other Bundle use yet) ---
export const fhirBundleEntrySchema = z
    .object({
        fullUrl: z.string().max(2_000).optional(),
        resource: z.unknown(),
    })
    .strict();

export const fhirBundleSchema = z
    .object({
        resourceType: z.literal("Bundle"),
        type: z.literal("searchset"),
        total: z.number().int().nonnegative(),
        entry: z.array(fhirBundleEntrySchema),
    })
    .strict();
export type FhirBundle = z.infer<typeof fhirBundleSchema>;

// --- CapabilityStatement ---
export const fhirCapabilityStatementSchema = z
    .object({
        resourceType: z.literal("CapabilityStatement"),
        status: z.literal("active"),
        date: fhirInstant,
        kind: z.literal("instance"),
        fhirVersion: z.literal("4.0.1"),
        format: z.array(z.literal("json")),
        rest: z.array(
            z
                .object({
                    mode: z.literal("server"),
                    resource: z.array(
                        z
                            .object({
                                type: z.string().min(1).max(100),
                                interaction: z.array(z.object({ code: z.enum(["read", "search-type"]) }).strict()),
                            })
                            .strict()
                    ),
                })
                .strict()
        ),
    })
    .strict();
export type FhirCapabilityStatement = z.infer<typeof fhirCapabilityStatementSchema>;

// --- SMART on FHIR discovery (`.well-known/smart-configuration`) ---
//
// This server is a SMART *resource server*, never its own authorization
// server — actual OAuth authorization/token issuance is delegated entirely
// to whichever external OIDC IdP is configured (auth/oidc-verifier.ts's own
// top doc comment; the same standing architecture decision this reuses
// rather than overrides). `authorization_endpoint`/`token_endpoint` here are
// therefore always the *external IdP's* endpoints, discovered from its own
// `.well-known/openid-configuration` — see server/src/fhir/smart-
// configuration.ts and docs/FHIR_INTEGRATION.md's SMART section for what
// this does and, just as importantly, does not implement (no dynamic client
// registration, no PKCE enforcement by this server since it issues no
// tokens itself, no EHR-launch redirect endpoint).
export const fhirSmartConfigurationSchema = z
    .object({
        issuer: z.string().min(1).max(2_000),
        authorization_endpoint: z.string().min(1).max(2_000),
        token_endpoint: z.string().min(1).max(2_000),
        capabilities: z.array(z.string().min(1).max(200)),
        code_challenge_methods_supported: z.array(z.string().min(1).max(50)),
        grant_types_supported: z.array(z.string().min(1).max(50)),
        scopes_supported: z.array(z.string().min(1).max(200)),
    })
    .strict();
export type FhirSmartConfiguration = z.infer<typeof fhirSmartConfigurationSchema>;

// fhirDate is exported only for reuse by mappers.ts's own input validation
// of `studyDate`-shaped strings; it is not part of any schema's public
// surface above (ImagingStudy.started is a full instant, not a bare date).
export { fhirDate };
