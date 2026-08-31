import { z } from "zod";

// Every entity id below (organizations, users, groups, policies) is a
// Postgres UUID column — see migrations/001_init.sql. A malformed value
// reaching a store method as a raw string fails there with Postgres's own
// "invalid input syntax for type uuid", which is a real error but not a
// ZodError or AuthzError — app.ts's central error handler would surface it
// as a 500, turning an obviously-malformed client request into a false
// "internal server error." Validating the shape here, before any request
// params reach a store, keeps that distinction intact and reuses the
// existing ZodError -> 400 handling (app.ts) rather than adding a new error
// type or a manual format check per route.
//
// `caseId` is deliberately NOT validated as a UUID: patient_cases.case_id
// is TEXT, not UUID (migrations/002_cases.sql), specifically so this
// service never rejects an id shape the client (app/src/patient-cases-store.ts,
// which does generate UUIDs today, but the contract doesn't require it)
// sends. It only needs to be a non-empty string.
const uuid = z.string().uuid();

export const organizationParamsSchema = z.object({ organizationId: uuid });
export const organizationUserParamsSchema = z.object({ organizationId: uuid, userId: uuid });
export const organizationGroupParamsSchema = z.object({ organizationId: uuid, groupId: uuid });
export const organizationPolicyParamsSchema = z.object({ organizationId: uuid, policyId: uuid });
export const organizationCaseParamsSchema = z.object({ organizationId: uuid, caseId: z.string().min(1) });
// sessionId: same reasoning as caseId above — chat_sessions.id is TEXT,
// client-generated (app/src/sessions-store.ts's randomUUID()), never
// enforced as UUID format server-side.
export const organizationSessionParamsSchema = z.object({ organizationId: uuid, sessionId: z.string().min(1) });

// Imaging study/report/annotation/share-grant/viewer-session/ingestion-job
// ids: same reasoning as caseId/sessionId above — server-generated
// randomUUID() strings stored as TEXT (migrations/017_clinical_imaging.sql),
// not enforced as UUID format at this boundary.
export const organizationStudyParamsSchema = z.object({ organizationId: uuid, studyId: z.string().min(1) });
export const organizationReportParamsSchema = z.object({ organizationId: uuid, studyId: z.string().min(1), reportId: z.string().min(1) });
export const organizationShareGrantParamsSchema = z.object({ organizationId: uuid, shareGrantId: z.string().min(1) });
export const organizationIngestionJobParamsSchema = z.object({ organizationId: uuid, jobId: z.string().min(1) });
export const organizationViewerSessionParamsSchema = z.object({ organizationId: uuid, sessionId: z.string().min(1) });
export const organizationDeidentificationJobParamsSchema = z.object({ organizationId: uuid, jobId: z.string().min(1) });
export const organizationDeidentificationArtifactParamsSchema = organizationDeidentificationJobParamsSchema.extend({ artifactId: z.string().min(1) });

// ClinicalAiGateway ids: server-generated (in-memory stores use randomUUID(),
// same as every other store in this codebase) TEXT identifiers — same
// "don't enforce UUID format at this boundary" reasoning as caseId/studyId
// above.
export const organizationAiRequestParamsSchema = z.object({ organizationId: uuid, requestId: z.string().min(1) });
export const organizationAiOutputParamsSchema = z.object({ organizationId: uuid, outputId: z.string().min(1) });
export const organizationAiConsentParamsSchema = z.object({ organizationId: uuid, caseId: z.string().min(1), consentId: z.string().min(1) });
export const organizationAiProviderParamsSchema = z.object({ organizationId: uuid, providerId: z.string().min(1) });
export const organizationAiProviderModelParamsSchema = z.object({ organizationId: uuid, modelId: z.string().min(1) });
export const organizationAiModelArtifactParamsSchema = z.object({ organizationId: uuid, artifactId: z.string().min(1) });
export const organizationAiInferenceDeploymentParamsSchema = z.object({ organizationId: uuid, deploymentId: z.string().min(1) });

// mcp_registry_entries.id is a real Postgres UUID column (migrations/020_mcp_registry.sql).
export const organizationMcpRegistryEntryParamsSchema = z.object({ organizationId: uuid, entryId: uuid });
