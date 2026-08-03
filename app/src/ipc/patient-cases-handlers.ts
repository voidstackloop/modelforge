import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as patientCasesStore from "../patient-cases-store";
import * as auditLogStore from "../audit-log-store";
import { checkMedicationConflicts } from "../medical-safety";
import { requireString } from "../app-state";

export function registerPatientCasesIpc(): void {
    ipcMain.handle("patientCases:list", () => patientCasesStore.listCases());

    ipcMain.handle("patientCases:get", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "case id");
        auditLogStore.recordEvent("case-viewed", { targetType: "patient-case", targetId: id });
        return patientCasesStore.getCase(id);
    });

    ipcMain.handle("patientCases:create", (_event: IpcMainInvokeEvent, title: string) => {
        requireString(title, "case title");
        const created = patientCasesStore.createCase(title);
        auditLogStore.recordEvent("case-created", { targetType: "patient-case", targetId: created.id });
        return created;
    });

    ipcMain.handle(
        "patientCases:update",
        (_event: IpcMainInvokeEvent, { id, partial }: { id: string; partial: Record<string, unknown> }) => {
            requireString(id, "case id");
            const updated = patientCasesStore.updateCase(id, partial);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: id });
            return updated;
        }
    );

    ipcMain.handle("patientCases:delete", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "case id");
        patientCasesStore.deleteCase(id);
        auditLogStore.recordEvent("case-deleted", { targetType: "patient-case", targetId: id });
    });

    ipcMain.handle("patientCases:buildContext", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "case id");
        const patientCase = patientCasesStore.getCase(id);
        if (!patientCase) return null;
        return patientCasesStore.buildContextForCase(patientCase);
    });

    ipcMain.handle(
        "patientCases:checkConflicts",
        (_event: IpcMainInvokeEvent, { allergies, medications }: { allergies: string[]; medications: string[] }) =>
            checkMedicationConflicts(allergies ?? [], medications ?? [])
    );

    ipcMain.handle(
        "patientCases:grantConsent",
        (_event: IpcMainInvokeEvent, { caseId, scope, method }: { caseId: string; scope: "ai-assistance" | "remote-model-use" | "research"; method: string }) => {
            requireString(caseId, "case id");
            requireString(method, "consent method");
            const updated = patientCasesStore.grantConsent(caseId, scope, method);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: caseId, detail: `consent-granted:${scope}` });
            return updated;
        }
    );

    ipcMain.handle(
        "patientCases:revokeConsent",
        (_event: IpcMainInvokeEvent, { caseId, consentId }: { caseId: string; consentId: string }) => {
            requireString(caseId, "case id");
            requireString(consentId, "consent id");
            const updated = patientCasesStore.revokeConsent(caseId, consentId);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: caseId, detail: "consent-revoked" });
            return updated;
        }
    );

    ipcMain.handle(
        "patientCases:addNote",
        (_event: IpcMainInvokeEvent, { caseId, author, text }: { caseId: string; author: "clinician" | "model-inference"; text: string }) => {
            requireString(caseId, "case id");
            requireString(text, "note text");
            const updated = patientCasesStore.addClinicalNote(caseId, author, text);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: caseId, detail: `note-added:${author}` });
            return updated;
        }
    );

    ipcMain.handle(
        "patientCases:reviewNote",
        (
            _event: IpcMainInvokeEvent,
            { caseId, noteId, reviewedBy, outcome, comment }: { caseId: string; noteId: string; reviewedBy: string; outcome: "accepted" | "accepted-with-edits" | "rejected"; comment?: string }
        ) => {
            requireString(caseId, "case id");
            requireString(noteId, "note id");
            requireString(reviewedBy, "reviewer name");
            const updated = patientCasesStore.reviewClinicalNote(caseId, noteId, reviewedBy, outcome, comment);
            auditLogStore.recordEvent("case-updated", { targetType: "patient-case", targetId: caseId, detail: `note-reviewed:${outcome}` });
            return updated;
        }
    );
}
