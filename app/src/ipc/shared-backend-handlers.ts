import { ipcMain, IpcMainInvokeEvent } from "electron";
import { logger } from "../logger";
import * as sharedBackendAuth from "../shared-backend-auth";
import * as sharedBackendClient from "../shared-backend-client";
import { getSharedBackendConfig, setSharedBackendConfig, type SharedBackendConfig } from "../shared-backend-config-store";
import { sharedBackendConfigSchema, parseOrThrow } from "../schemas";
import { requireString } from "../app-state";
import * as caseMigration from "../case-migration";
import * as imagingClient from "../imaging-client";
import * as clinicalAiClient from "../clinical-ai-client";
import { closeOhifLaunch, createOhifLaunch } from "../ohif-viewer";

// IPC surface for enterprise-mode shared-backend connection management
// (docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §4,
// docs/SHARED_BACKEND_DESIGN.md §2). Deliberately does **not** expose the
// access token itself to the renderer at any point — the same boundary
// every provider adapter and MCP server connection already draws (see
// docs/ARCHITECTURE.md: "the renderer never talks to [a remote service]
// directly ... so API keys never need to reach the renderer's JS context").
// A future HTTP-backed PatientCasesBackend calls
// shared-backend-auth.ts's getValidAccessToken() directly, from this same
// main process, never through IPC.
export function registerSharedBackendIpc(): void {
    ipcMain.handle("sharedBackend:getConfig", (): SharedBackendConfig | null => getSharedBackendConfig());

    ipcMain.handle("sharedBackend:setConfig", (_event: IpcMainInvokeEvent, input: unknown) => {
        const config = parseOrThrow(sharedBackendConfigSchema, input, "shared backend config");
        setSharedBackendConfig(config);
    });

    ipcMain.handle("sharedBackend:clearConfig", () => {
        setSharedBackendConfig(null);
        sharedBackendAuth.disconnect();
    });

    ipcMain.handle("sharedBackend:status", () => ({
        configured: getSharedBackendConfig() !== null,
        connected: sharedBackendAuth.isConnected(),
    }));

    ipcMain.handle("sharedBackend:connect", async () => {
        try {
            await sharedBackendAuth.connect();
            return { connected: true };
        } catch (err) {
            const error = err as Error;
            logger.error(`Shared backend OAuth flow failed: ${error.message}`);
            return { connected: false, error: error.message };
        }
    });

    ipcMain.handle("sharedBackend:disconnect", () => {
        sharedBackendAuth.disconnect();
    });

    // Org membership discovery/bootstrap/selection — see
    // shared-backend-client.ts's own doc comment for why these are
    // separate from the PatientCasesBackend contract. Left to reject
    // normally (no catch-and-return-{error} here, unlike :connect above)
    // — the renderer already has a standard catch/toast pattern for a
    // rejected IPC call, and these three don't involve the same
    // long-running-external-flow considerations startOAuthFlow-shaped
    // handlers do.
    ipcMain.handle("sharedBackend:listOrganizations", () => sharedBackendClient.listOrganizationMemberships());

    ipcMain.handle("sharedBackend:createOrganization", (_event: IpcMainInvokeEvent, name: string) => {
        requireString(name, "organization name");
        return sharedBackendClient.createOrganization(name);
    });

    ipcMain.handle("sharedBackend:selectOrganization", (_event: IpcMainInvokeEvent, organizationId: string) => {
        requireString(organizationId, "organization id");
        sharedBackendClient.selectOrganization(organizationId);
    });

    ipcMain.handle("sharedBackend:clearSelectedOrganization", () => {
        sharedBackendClient.clearSelectedOrganization();
    });

    ipcMain.handle("sharedBackend:stageLocalCases", () => caseMigration.stageLocalCases());
    ipcMain.handle("sharedBackend:activateCaseMigration", (_event: IpcMainInvokeEvent, migrationId: string) => {
        requireString(migrationId, "migration id");
        return caseMigration.activateStagedMigration(migrationId);
    });
    ipcMain.handle("sharedBackend:rollbackCaseMigration", (_event: IpcMainInvokeEvent, migrationId: string) => {
        requireString(migrationId, "migration id");
        return caseMigration.rollbackStagedMigration(migrationId);
    });

    ipcMain.handle("imaging:listStudies", (_event, caseId: string) => {
        requireString(caseId, "case id");
        return imagingClient.listImagingStudies(caseId);
    });
    ipcMain.handle("imaging:getStudy", (_event, studyId: string) => {
        requireString(studyId, "study id");
        return imagingClient.getImagingStudy(studyId);
    });
    ipcMain.handle("imaging:listActivity", () => imagingClient.listImagingActivity());
    ipcMain.handle("imaging:upload", (_event, input: { caseId: string; fileName: string; bytes: Uint8Array }) => {
        requireString(input?.caseId, "case id");
        requireString(input?.fileName, "file name");
        if (!(input?.bytes instanceof Uint8Array)) throw new Error("DICOM bytes must be a Uint8Array.");
        return imagingClient.uploadDicom(input.caseId, input.fileName, input.bytes);
    });
    ipcMain.handle("imaging:resolveIngestionJob", (_event, input: { jobId: string; decision: "attach" | "reject"; caseId?: string }) => {
        requireString(input?.jobId, "ingestion job id");
        if (input?.decision !== "attach" && input?.decision !== "reject") throw new Error("Resolution decision must be \"attach\" or \"reject\".");
        if (input.decision === "attach") requireString(input.caseId, "case id");
        return imagingClient.resolveImagingIngestionJob(input.jobId, input.decision, input.caseId);
    });
    ipcMain.handle("imaging:listShares", (_event, studyId: string) => {
        requireString(studyId, "study id");
        return imagingClient.listImagingShares(studyId);
    });
    ipcMain.handle("imaging:createShare", (_event, input: { studyId: string; share: imagingClient.CreateImagingShareInput }) => {
        requireString(input?.studyId, "study id");
        return imagingClient.createImagingShare(input.studyId, input.share);
    });
    ipcMain.handle("imaging:openViewer", async (_event, studyId: string) => {
        requireString(studyId, "study id");
        const viewerSession = await imagingClient.createViewerSession(studyId);
        return createOhifLaunch({
            token: viewerSession.token,
            dicomwebBaseUrl: viewerSession.dicomwebBaseUrl,
            studyInstanceUid: viewerSession.studyInstanceUid,
            expiresAt: viewerSession.session.expiresAt,
        });
    });
    ipcMain.handle("imaging:closeViewer", (_event, viewerUrl: string) => {
        requireString(viewerUrl, "viewer URL");
        closeOhifLaunch(viewerUrl);
    });

    ipcMain.handle("clinicalAi:listModels", () => clinicalAiClient.listClinicalAiModels());
    ipcMain.handle("clinicalAi:listConsents", (_event, caseId: string) => { requireString(caseId, "case id"); return clinicalAiClient.listClinicalAiConsents(caseId); });
    ipcMain.handle("clinicalAi:createConsent", (_event, input: { caseId: string; consent: { purpose: "treatment"|"research"|"teaching"|"quality-improvement"; dataCategories: string[]; expiresAt?: string } }) => {
        requireString(input?.caseId,"case id"); if(!Array.isArray(input?.consent?.dataCategories)||input.consent.dataCategories.length===0)throw new Error("At least one consent data category is required."); return clinicalAiClient.createClinicalAiConsent(input.caseId,input.consent);
    });
    ipcMain.handle("clinicalAi:revokeConsent", (_event, input: { caseId: string; consentId: string; reason: string }) => { requireString(input?.caseId,"case id");requireString(input?.consentId,"consent id");requireString(input?.reason,"reason");return clinicalAiClient.revokeClinicalAiConsent(input.caseId,input.consentId,input.reason); });
    ipcMain.handle("clinicalAi:listImagingOptions", (_event, caseId: string) => { requireString(caseId,"case id"); return clinicalAiClient.listClinicalAiImagingOptions(caseId); });
    ipcMain.handle("clinicalAi:preview", (_event, input: { caseId: string; request: clinicalAiClient.ClinicalAiSubmitInput }) => { requireString(input?.caseId,"case id");return clinicalAiClient.previewClinicalAiRequest(input.caseId,input.request); });
    ipcMain.handle("clinicalAi:submit", (_event, input: { caseId: string; request: clinicalAiClient.ClinicalAiSubmitInput }) => { requireString(input?.caseId,"case id");return clinicalAiClient.submitClinicalAiRequest(input.caseId,input.request); });
    ipcMain.handle("clinicalAi:listActivity", (_event, caseId: string) => { requireString(caseId,"case id");return clinicalAiClient.listClinicalAiActivity(caseId); });
    ipcMain.handle("clinicalAi:review", (_event, input: { outputId: string; review: { decision: "accepted"|"rejected"|"corrected"|"escalated"; correctedText?: string; escalationReason?: string } }) => { requireString(input?.outputId,"output id");return clinicalAiClient.reviewClinicalAiOutput(input.outputId,input.review); });
}
