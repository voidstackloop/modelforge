import { z } from "zod";

// This package is the only runtime source of truth for clinical payloads
// crossing the Electron/server boundary. Keep storage-only metadata in
// CaseResourceAttributes rather than accepting it from an untrusted client.
const identifierSchema = z.string().min(1).max(200);
const timestampSchema = z.string().datetime({ offset: true });

export const caseFieldSchema = <T extends z.ZodType>(valueSchema: T) =>
    z.object({ value: valueSchema, includeInContext: z.boolean() }).strict();

export const labResultSchema = z
    .object({
        id: identifierSchema,
        name: z.string().min(1).max(500),
        value: z.string().max(10_000),
        unit: z.string().max(200).optional(),
        referenceRange: z.string().max(500).optional(),
        observedAt: timestampSchema.optional(),
    })
    .strict();

export const clinicalNoteReviewSchema = z
    .object({
        reviewedBy: z.string().min(1).max(500),
        reviewedAt: timestampSchema,
        outcome: z.enum(["accepted", "accepted-with-edits", "rejected"]),
        comment: z.string().max(20_000).optional(),
    })
    .strict();

export const clinicalNoteSchema = z
    .object({
        id: identifierSchema,
        author: z.enum(["clinician", "model-inference"]),
        text: z.string().max(250_000),
        createdAt: timestampSchema,
        review: clinicalNoteReviewSchema.optional(),
    })
    .strict();

export const attachmentRefSchema = z
    .object({
        id: identifierSchema,
        name: z.string().min(1).max(2_000),
        mimeType: z.string().max(500).optional(),
        addedAt: timestampSchema,
    })
    .strict();

export const caseConsentSchema = z
    .object({
        id: identifierSchema,
        scope: z.enum(["ai-assistance", "remote-model-use", "research"]),
        grantedAt: timestampSchema,
        revokedAt: timestampSchema.optional(),
        method: z.string().min(1).max(5_000),
    })
    .strict()
    .refine((value) => value.revokedAt === undefined || value.revokedAt >= value.grantedAt, {
        message: "revokedAt must not precede grantedAt",
        path: ["revokedAt"],
    });

export const patientCaseSchema = z
    .object({
        id: identifierSchema,
        title: z.string().min(1).max(2_000),
        // Optional tenant-local resource labels. They are validated here but
        // never trusted for authorization; the server persists and reads its
        // own CaseResourceAttributes alongside the clinical document.
        patientId: identifierSchema.optional(),
        workspaceId: identifierSchema.optional(),
        departmentId: identifierSchema.optional(),
        assignedUserIds: z.array(identifierSchema).max(1_000).optional(),
        demographics: caseFieldSchema(
            z
                .object({
                    age: z.string().max(100).optional(),
                    sex: z.string().max(200).optional(),
                    notes: z.string().max(20_000).optional(),
                })
                .strict()
        ),
        presentingComplaint: caseFieldSchema(z.string().max(100_000)),
        symptomsTimeline: caseFieldSchema(z.string().max(100_000)),
        vitalSigns: caseFieldSchema(z.string().max(100_000)),
        conditions: caseFieldSchema(z.array(z.string().max(2_000)).max(10_000)),
        allergies: caseFieldSchema(z.array(z.string().max(2_000)).max(10_000)),
        medications: caseFieldSchema(z.array(z.string().max(2_000)).max(10_000)),
        labResults: caseFieldSchema(z.array(labResultSchema).max(10_000)),
        imagingAndReports: caseFieldSchema(z.string().max(500_000)),
        clinicalNotes: z.array(clinicalNoteSchema).max(10_000),
        attachments: z.array(attachmentRefSchema).max(10_000),
        consentNote: z.string().max(20_000).optional(),
        consentRecords: z.array(caseConsentSchema).max(10_000).default([]),
        enteredBy: z.string().max(500).optional(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
        version: z.string().regex(/^\d+$/).optional(),
    })
    .strict()
    .refine((value) => value.updatedAt >= value.createdAt, {
        message: "updatedAt must not precede createdAt",
        path: ["updatedAt"],
    });

export const patientCasesFileSchema = z.array(patientCaseSchema);

export type CaseField<T> = { value: T; includeInContext: boolean };
export type LabResult = z.infer<typeof labResultSchema>;
export type ClinicalNoteReview = z.infer<typeof clinicalNoteReviewSchema>;
export type ClinicalNote = z.infer<typeof clinicalNoteSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type CaseConsent = z.infer<typeof caseConsentSchema>;
export type PatientCase = z.infer<typeof patientCaseSchema>;

export const caseResourceAttributesSchema = z
    .object({
        organizationId: identifierSchema,
        caseId: identifierSchema,
        patientId: identifierSchema,
        ownerUserId: identifierSchema,
        workspaceId: identifierSchema.optional(),
        departmentId: identifierSchema.optional(),
        assignedUserIds: z.array(identifierSchema),
        activeConsentScopes: z.array(caseConsentSchema.shape.scope),
    })
    .strict();
export type CaseResourceAttributes = z.infer<typeof caseResourceAttributesSchema>;

export const caseChangeSchema = z.discriminatedUnion("kind", [
    z
        .object({
            sequence: z.string().regex(/^\d+$/),
            kind: z.literal("upsert"),
            caseId: identifierSchema,
            version: z.string().regex(/^\d+$/),
            changedAt: timestampSchema,
            patientCase: patientCaseSchema,
        })
        .strict(),
    z
        .object({
            sequence: z.string().regex(/^\d+$/),
            kind: z.literal("delete"),
            caseId: identifierSchema,
            version: z.string().regex(/^\d+$/),
            changedAt: timestampSchema,
        })
        .strict(),
]);
export type CaseChange = z.infer<typeof caseChangeSchema>;

export const caseChangeFeedSchema = z
    .object({
        changes: z.array(caseChangeSchema),
        cursor: z.string().regex(/^\d+$/),
        // Compatibility projections for clients that have not yet adopted
        // event replay. They are derived from changes, never queried via a
        // second cursor, so the high-water mark stays transactional.
        cases: z.array(patientCaseSchema).optional(),
        deletedIds: z.array(identifierSchema).optional(),
    })
    .strict();
export type CaseChangeFeed = z.infer<typeof caseChangeFeedSchema>;

export const migrationItemStatusSchema = z.enum(["pending", "accepted", "invalid", "collision"]);
export const migrationStatusSchema = z.enum(["staging", "validated", "active", "rolled-back"]);
export const migrationPreviewSchema = z
    .object({
        total: z.number().int().nonnegative(),
        valid: z.number().int().nonnegative(),
        invalid: z.number().int().nonnegative(),
        collisions: z.number().int().nonnegative(),
        items: z.array(
            z
                .object({
                    caseId: identifierSchema,
                    status: migrationItemStatusSchema,
                    errors: z.array(z.string()),
                })
                .strict()
        ),
    })
    .strict();
export type MigrationPreview = z.infer<typeof migrationPreviewSchema>;

export const migrationSessionSchema = z
    .object({
        id: identifierSchema,
        organizationId: identifierSchema,
        status: migrationStatusSchema,
        sourceFingerprint: z.string().min(1),
        totalItems: z.number().int().nonnegative(),
        acceptedItems: z.number().int().nonnegative(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
        preview: migrationPreviewSchema.optional(),
    })
    .strict();
export type MigrationSession = z.infer<typeof migrationSessionSchema>;

export const startMigrationRequestSchema = z
    .object({
        sourceFingerprint: z.string().min(1).max(500),
        totalItems: z.number().int().nonnegative(),
    })
    .strict();
export const migrationBatchRequestSchema = z
    .object({
        items: z
            .array(
                z
                    .object({
                        itemKey: z.string().min(1).max(500),
                        patientCase: z.unknown(),
                    })
                    .strict()
            )
            .min(1)
            .max(100),
    })
    .strict();

// --- Shared chat sessions (P1 item 7: remaining shared clinical domains —
// see server/src/routes/sessions.ts's header comment). Only the fields
// that are safe and meaningful to sync across devices/users live here.
// app/src/sessions-store.ts's full local ChatSession also carries
// `params` (device/hardware-specific runtime tuning — GPU layers, thread
// count; applying one device's values on another's hardware can crash or
// badly misconfigure local inference), `agentWorkspace` (a local
// filesystem path), and `projectId` (app/src/projects-store.ts's local,
// device-only chat-organization concept, no server counterpart in this
// slice) — none of those three are part of this schema, and
// shared-sessions-backend.ts never sends them.

export const usageInfoSchema = z.object({ promptTokens: z.number().int().nonnegative().optional(), completionTokens: z.number().int().nonnegative().optional() }).strict();
export const messageImageSchema = z.object({ mimeType: z.string().max(200), data: z.string().max(50_000_000) }).strict();
export const toolCallSchema = z.object({ id: identifierSchema, name: z.string().min(1).max(500), arguments: z.record(z.string(), z.unknown()) }).strict();

export const chatMessageSchema = z
    .object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string().max(2_000_000),
        // Immutable per-response provenance. Optional for backwards
        // compatibility with sessions written before model attribution was
        // persisted.
        model: z.string().max(500).optional(),
        excludedFromContext: z.boolean().optional(),
        usage: usageInfoSchema.optional(),
        images: z.array(messageImageSchema).max(50).optional(),
        toolCalls: z.array(toolCallSchema).max(500).optional(),
        toolCallId: z.string().max(500).optional(),
        toolName: z.string().max(500).optional(),
        pinned: z.boolean().optional(),
        isVerification: z.boolean().optional(),
    })
    .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const sharedChatSessionSchema = z
    .object({
        id: identifierSchema,
        title: z.string().min(1).max(2_000),
        model: z.string().max(500).nullable(),
        messages: z.array(chatMessageSchema).max(100_000),
        systemPrompt: z.string().max(500_000).optional(),
        tags: z.array(z.string().max(200)).max(200).optional(),
        planSteps: z.array(z.object({ text: z.string().max(5_000), done: z.boolean() }).strict()).max(1_000).optional(),
        contextSummary: z.string().max(2_000_000).optional(),
        contextSummaryThroughIndex: z.number().int().nonnegative().optional(),
        // Owner + explicitly-assigned teammates — same
        // "shared by explicit assignment, not blanket org visibility"
        // model as patient cases. See routes/sessions.ts's authorization
        // model doc comment.
        assignedUserIds: z.array(identifierSchema).max(1_000).optional(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
        version: z.string().regex(/^\d+$/).optional(),
    })
    .strict()
    .refine((value) => value.updatedAt >= value.createdAt, { message: "updatedAt must not precede createdAt", path: ["updatedAt"] });
export type SharedChatSession = z.infer<typeof sharedChatSessionSchema>;

export const sessionResourceAttributesSchema = z
    .object({
        organizationId: identifierSchema,
        sessionId: identifierSchema,
        ownerUserId: identifierSchema,
        assignedUserIds: z.array(identifierSchema),
    })
    .strict();
export type SessionResourceAttributes = z.infer<typeof sessionResourceAttributesSchema>;

export const sessionChangeSchema = z.discriminatedUnion("kind", [
    z
        .object({
            sequence: z.string().regex(/^\d+$/),
            kind: z.literal("upsert"),
            sessionId: identifierSchema,
            version: z.string().regex(/^\d+$/),
            changedAt: timestampSchema,
            session: sharedChatSessionSchema,
        })
        .strict(),
    z
        .object({
            sequence: z.string().regex(/^\d+$/),
            kind: z.literal("delete"),
            sessionId: identifierSchema,
            version: z.string().regex(/^\d+$/),
            changedAt: timestampSchema,
        })
        .strict(),
]);
export type SessionChange = z.infer<typeof sessionChangeSchema>;

export const sessionChangeFeedSchema = z.object({ changes: z.array(sessionChangeSchema), cursor: z.string().regex(/^\d+$/) }).strict();
export type SessionChangeFeed = z.infer<typeof sessionChangeFeedSchema>;

export const apiErrorSchema = z
    .object({
        error: z.string().min(1),
        message: z.string().optional(),
        current: patientCaseSchema.optional(),
    })
    .passthrough();
export type ApiError = z.infer<typeof apiErrorSchema>;

// Clinical imaging — a dedicated domain, kept in its own module. See
// imaging.ts's own top doc comment for the trust-boundary invariants this
// split exists to make visible at a glance.
export * from "./imaging.js";

// ClinicalAiGateway — a dedicated domain, kept in its own module. See
// ai-gateway.ts's own top doc comment for the trust-boundary invariants
// this split exists to make visible at a glance. Note: PatientCase's own
// `consentRecords` (caseConsentSchema, above) already has a coarse
// "ai-assistance"/"remote-model-use" consent scope — the gateway checks
// that first as a cheap prerequisite gate, then additionally requires the
// richer, versioned, purpose-specific, policy-linked AiConsent this module
// defines. The two are layered, not duplicated: the case-level flag is
// "has this patient consented to AI use at all," the gateway's own
// AiConsent is "exactly which purpose, which data categories, since when,
// until when."
export * from "./ai-gateway.js";

// Enterprise CPU/GPU control plane — PHI-free inventory, policy, request,
// and lease contracts shared by the server scheduler and managed node agent.
export * from "./compute.js";
