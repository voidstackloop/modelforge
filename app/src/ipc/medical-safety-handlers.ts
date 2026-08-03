import { ipcMain, IpcMainInvokeEvent } from "electron";
import { checkForEmergencyFlags, redactIdentifiers, checkCitations } from "../medical-safety";
import { requireString } from "../app-state";

export function registerMedicalSafetyIpc(): void {
    ipcMain.handle("medicalSafety:checkEmergency", (_event: IpcMainInvokeEvent, text: string) => {
        requireString(text, "text");
        return checkForEmergencyFlags(text);
    });

    ipcMain.handle("medicalSafety:redact", (_event: IpcMainInvokeEvent, text: string) => {
        requireString(text, "text");
        return redactIdentifiers(text);
    });

    ipcMain.handle(
        "medicalSafety:checkCitations",
        (_event: IpcMainInvokeEvent, { text, knownSourceIds }: { text: string; knownSourceIds: string[] }) => {
            requireString(text, "text");
            return checkCitations(text, knownSourceIds ?? []);
        }
    );
}
