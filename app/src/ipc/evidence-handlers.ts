import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as evidenceStore from "../evidence-store";
import { requireString } from "../app-state";

export function registerEvidenceIpc(): void {
    ipcMain.handle("evidence:list", () => evidenceStore.listSources());

    ipcMain.handle("evidence:addFromUrl", async (_event: IpcMainInvokeEvent, url: string) => {
        requireString(url, "evidence source URL");
        try {
            return { source: await evidenceStore.addSourceFromUrl(url) };
        } catch (err) {
            return { error: (err as Error).message };
        }
    });

    ipcMain.handle("evidence:delete", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "evidence source id");
        evidenceStore.deleteSource(id);
    });
}
