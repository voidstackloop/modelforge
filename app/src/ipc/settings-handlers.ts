import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as settingsStore from "../settings-store";
import type { AppSettings } from "../settings-store";
import * as llamacpp from "../llamacpp-manager";
import * as downloadQueue from "../download-queue";
import { setupMenu } from "../menu";
import { checkForUpdatesManually } from "../updater";
import { appSettingsSchema, parseOrThrow } from "../schemas";
import { getMainWindow } from "../app-state";
import { selectMedicationSafetyProvider } from "../medical-safety";
import { selectPatientCasesBackend } from "../patient-cases-store";
import { selectSessionsBackend } from "../sessions-store";
import { mainComputeAgent } from "../compute-agent";
import { logger } from "../logger";

export function registerSettingsIpc(): void {
    ipcMain.handle("settings:get", () => settingsStore.getSettings());
    ipcMain.handle("settings:save", async (_event: IpcMainInvokeEvent, input: unknown) => {
        const partial: Partial<AppSettings> = parseOrThrow(appSettingsSchema, input, "settings");
        const current = settingsStore.getSettings();
        const next = { ...current, ...partial };
        if (partial.llamaCppMaxThreads !== undefined || partial.llamaCppVramReserveGB !== undefined || partial.llamaCppRamReserveGB !== undefined || partial.llamaCppNumaPolicy !== undefined) {
            await llamacpp.setLlamaCppRuntimeConfig({
                maxThreads: next.llamaCppMaxThreads,
                vramReserveBytes: next.llamaCppVramReserveGB === undefined ? undefined : next.llamaCppVramReserveGB * 1024 ** 3,
                ramReserveBytes: next.llamaCppRamReserveGB === undefined ? undefined : next.llamaCppRamReserveGB * 1024 ** 3,
                numa: next.llamaCppNumaPolicy ?? "auto",
            });
        }
        // Computed from the *requested* patch, before saveSettings() strips
        // any policy-managed keys — used below to skip the runtime
        // side-effecting selectXProvider/-Backend calls for a key policy
        // rejected, not just to keep it out of settings.json. Without this,
        // a rejected medicationSafetyProviderId/patientCasesBackendId could
        // still flip which *runtime object* is active even though
        // getSettings() would keep reporting policy's value — settings.json
        // and the actually-running registry entry would silently diverge.
        const rejectedByPolicy = settingsStore.getRejectedPolicyKeys(partial);
        if (rejectedByPolicy.length > 0) {
            logger.warn(`settings:save — organization policy manages ${rejectedByPolicy.join(", ")}; the requested change to ${rejectedByPolicy.length === 1 ? "it was" : "them was"} not applied.`);
        }
        const saved = settingsStore.saveSettings(partial);
        if (partial.llamaCppMaxCachedModels !== undefined) llamacpp.setModelCacheLimit(saved.llamaCppMaxCachedModels ?? 2);
        if (partial.downloadGlobalConcurrency !== undefined || partial.downloadBandwidthMbps !== undefined) {
            downloadQueue.configure({ concurrency: saved.downloadGlobalConcurrency ?? 2, bandwidthMbps: saved.downloadBandwidthMbps ?? 0 });
        }
        if (partial.keybindings !== undefined) {
            setupMenu(() => getMainWindow(), () => checkForUpdatesManually(() => getMainWindow()), saved.keybindings);
        }
        if (
            partial.medicationSafetyProviderId !== undefined &&
            !rejectedByPolicy.includes("medicationSafetyProviderId") &&
            !selectMedicationSafetyProvider(partial.medicationSafetyProviderId)
        ) {
            // Fails safe (see selectMedicationSafetyProvider's own doc
            // comment): the setting still saves as requested — so the UI can
            // show what's configured — but whichever provider was already
            // active keeps running rather than the app silently ending up
            // with no medication-safety check at all.
            logger.error(`Configured medication safety provider "${partial.medicationSafetyProviderId}" is not registered — the previously active provider remains in use.`);
        }
        if (
            partial.patientCasesBackendId !== undefined &&
            !rejectedByPolicy.includes("patientCasesBackendId") &&
            !selectPatientCasesBackend(partial.patientCasesBackendId)
        ) {
            // Same fail-safe shape as the medication safety provider above —
            // see selectPatientCasesBackend's own doc comment.
            logger.error(`Configured patient cases backend "${partial.patientCasesBackendId}" is not registered — the previously active backend remains in use.`);
        }
        if (
            partial.sessionsBackendId !== undefined &&
            !rejectedByPolicy.includes("sessionsBackendId") &&
            !selectSessionsBackend(partial.sessionsBackendId)
        ) {
            // Same fail-safe shape as the patient cases backend above — see
            // selectSessionsBackend's own doc comment.
            logger.error(`Configured sessions backend "${partial.sessionsBackendId}" is not registered — the previously active backend remains in use.`);
        }
        if (partial.computeAgentEnabled !== undefined || partial.computeNodeId !== undefined) {
            if (saved.computeAgentEnabled && saved.computeNodeId) {
                mainComputeAgent.start();
            } else {
                await mainComputeAgent.stop();
            }
        }
        return saved;
    });
}
