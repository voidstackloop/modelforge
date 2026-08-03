import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as modelRegistryStore from "../model-registry-store";
import * as auditLogStore from "../audit-log-store";
import { requireString } from "../app-state";

export function registerModelRegistryIpc(): void {
    ipcMain.handle("modelRegistry:list", () => modelRegistryStore.listApprovedModels());
    ipcMain.handle("modelRegistry:isActive", () => modelRegistryStore.isRegistryActive());
    ipcMain.handle(
        "modelRegistry:isApproved",
        (_event: IpcMainInvokeEvent, { provider, modelId }: { provider: string; modelId: string }) =>
            modelRegistryStore.isApproved(provider, modelId)
    );

    ipcMain.handle(
        "modelRegistry:approve",
        (
            _event: IpcMainInvokeEvent,
            { provider, modelId, approvedUseCases, approvedBy }: { provider: string; modelId: string; approvedUseCases: string[]; approvedBy?: string }
        ) => {
            requireString(provider, "provider");
            requireString(modelId, "model id");
            const entry = modelRegistryStore.approveModel(provider, modelId, approvedUseCases ?? [], approvedBy);
            auditLogStore.recordEvent("settings-changed", { detail: `model-approved:${provider}/${modelId}` });
            return entry;
        }
    );

    ipcMain.handle("modelRegistry:retire", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "model registry entry id");
        modelRegistryStore.retireModel(id);
        auditLogStore.recordEvent("settings-changed", { detail: "model-retired" });
    });

    ipcMain.handle("modelRegistry:remove", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "model registry entry id");
        modelRegistryStore.removeModel(id);
    });
}
