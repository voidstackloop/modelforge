import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as patientCasesStore from "../patient-cases-store";
import * as auditLogStore from "../audit-log-store";
import { checkMedicationConflicts } from "../medical-safety";
import { requireString } from "../app-state";
import { medicationConflictCheckInputSchema, parseOrThrow } from "../schemas";
import { getSyncStatus, discardConflict } from "../case-offline-cache";
import { getSharedBackendConfig } from "../shared-backend-config-store";

export function registerPatientCasesIpc(): void {
    ipcMain.handle("patientCases:list", () => patientCasesStore.listCases());

    // Lets Settings show what's actually registered/active — the
    // configuration boundary a future shared/networked backend plugs into
    // (see patient-cases-store.ts's backend registry) — without exposing
    // anything beyond a backend's public identity (name/label/scope).
    ipcMain.handle("patientCases:listBackends", () => ({
        active: patientCasesStore.getPatientCasesBackend().name,
        backends: patientCasesStore.listPatientCasesBackends(),
    }));

    ipcMain.handle("patientCases:get", async (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "case id");
        auditLogStore.recordEvent("case-viewed", { targetType: "patient-case", targetId: id });
        return patientCasesStore.getCase(id);
    });

    ipcMain.handle("patientCases:create", async (_event: IpcMainInvokeEvent, title: string) => {
        requireString(title, "case title");
        const created = await patientCasesStore.createCase(title);
        auditLogStore.recordEvent("case-created", { targetType: "patient-case", targetId: created.id });
        return created;
    });

    ipcMain.handle(
        "patientCases:update",
        async (
            _event: IpcMainInvokeEvent,
            { id, partial, expectedVersion }: { id: string; partial: Record<string, unknown>; expectedVersion?: string | null }
        ) => {
            requireString(id, "case id");
            // A rejected CaseWriteConflictError propagates straight through
            // this handler to the renderer's ipcRenderer.invoke() promise —
            // no special handling needed here, same as CaseDataLockedError
            // elsewhere in this file. The audit event only fires on success;
            // a rejected write is not something that happened, so it isn't
            // logged as one.
            const updated = await patientCasesStore.updateCase(id, partial, expectedVersion);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: id });
            return updated;
        }
    );

    ipcMain.handle("patientCases:delete", async (_event: IpcMainInvokeEvent, { id, expectedVersion }: { id: string; expectedVersion?: string | null }) => {
        requireString(id, "case id");
        await patientCasesStore.deleteCase(id, expectedVersion);
        auditLogStore.recordEvent("case-deleted", { targetType: "patient-case", targetId: id });
    });

    ipcMain.handle("patientCases:buildContext", async (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "case id");
        const patientCase = await patientCasesStore.getCase(id);
        if (!patientCase) return null;
        return patientCasesStore.buildContextForCase(patientCase);
    });

    ipcMain.handle("patientCases:checkConflicts", (_event: IpcMainInvokeEvent, rawInput: unknown) => {
        const { allergies, medications } = parseOrThrow(medicationConflictCheckInputSchema, rawInput, "patientCases:checkConflicts arguments");
        return checkMedicationConflicts(allergies, medications);
    });

    ipcMain.handle(
        "patientCases:grantConsent",
        async (_event: IpcMainInvokeEvent, { caseId, scope, method }: { caseId: string; scope: "ai-assistance" | "remote-model-use" | "research"; method: string }) => {
            requireString(caseId, "case id");
            requireString(method, "consent method");
            const updated = await patientCasesStore.grantConsent(caseId, scope, method);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: caseId, detail: `consent-granted:${scope}` });
            return updated;
        }
    );

    ipcMain.handle(
        "patientCases:revokeConsent",
        async (_event: IpcMainInvokeEvent, { caseId, consentId }: { caseId: string; consentId: string }) => {
            requireString(caseId, "case id");
            requireString(consentId, "consent id");
            const updated = await patientCasesStore.revokeConsent(caseId, consentId);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: caseId, detail: "consent-revoked" });
            return updated;
        }
    );

    ipcMain.handle(
        "patientCases:addNote",
        async (_event: IpcMainInvokeEvent, { caseId, author, text }: { caseId: string; author: "clinician" | "model-inference"; text: string }) => {
            requireString(caseId, "case id");
            requireString(text, "note text");
            const updated = await patientCasesStore.addClinicalNote(caseId, author, text);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: caseId, detail: `note-added:${author}` });
            return updated;
        }
    );

    // P1 item 5 (case-offline-cache.ts) — no organization selected (local
    // mode, or shared mode not yet connected) means nothing to report, not
    // an error: the offline cache/outbox only exists per-organization.
    ipcMain.handle("patientCases:getSyncStatus", () => {
        const organizationId = getSharedBackendConfig()?.organizationId;
        return organizationId ? getSyncStatus(organizationId) : { pendingCount: 0, oldestQueuedAt: null, lastSyncedAt: null, conflicts: [] };
    });

    ipcMain.handle("patientCases:discardSyncConflict", (_event: IpcMainInvokeEvent, idempotencyKey: string) => {
        requireString(idempotencyKey, "idempotency key");
        const organizationId = getSharedBackendConfig()?.organizationId;
        if (organizationId) discardConflict(organizationId, idempotencyKey);
    });

    ipcMain.handle(
        "patientCases:reviewNote",
        async (
            _event: IpcMainInvokeEvent,
            { caseId, noteId, reviewedBy, outcome, comment }: { caseId: string; noteId: string; reviewedBy: string; outcome: "accepted" | "accepted-with-edits" | "rejected"; comment?: string }
        ) => {
            requireString(caseId, "case id");
            requireString(noteId, "note id");
            requireString(reviewedBy, "reviewer name");
            const updated = await patientCasesStore.reviewClinicalNote(caseId, noteId, reviewedBy, outcome, comment);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: caseId, detail: `note-reviewed:${outcome}` });
            return updated;
        }
    );
}
