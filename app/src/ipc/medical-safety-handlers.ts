import { ipcMain, IpcMainInvokeEvent } from "electron";
import { checkForEmergencyFlags, redactIdentifiers, checkCitations, getMedicationSafetyProvider, listMedicationSafetyProviders } from "../medical-safety";
import { requireString } from "../app-state";

export function registerMedicalSafetyIpc(): void {
    ipcMain.handle("medicalSafety:checkEmergency", (_event: IpcMainInvokeEvent, text: string) => {
        requireString(text, "text");
        return checkForEmergencyFlags(text);
    });

    // Lets Settings show what's actually registered/active — the
    // configuration boundary a future licensed provider plugs into (see
    // medical-safety.ts's provider registry) — without exposing anything
    // beyond a provider's public identity (name/label/coverage).
    ipcMain.handle("medicalSafety:listMedicationProviders", () => ({
        active: getMedicationSafetyProvider().name,
        providers: listMedicationSafetyProviders(),
    }));

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
