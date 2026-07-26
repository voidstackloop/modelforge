import * as path from "node:path";
import * as fs from "node:fs";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import { logger } from "../logger";
import * as rag from "../rag";
import * as settingsStore from "../settings-store";
import * as huggingface from "../huggingface";
import * as accounts from "../accounts";
import type { AttachedFile } from "../file-reader";
import { requireString, getLlamaCppModelsDir } from "../app-state";

export function registerRagIpc(): void {
    ipcMain.handle(
        "rag:indexFolder",
        (_event: IpcMainInvokeEvent, input: { folderPath: string; folderName: string; files: AttachedFile[] }) =>
            rag.indexFolder({ ...input, embeddingModel: settingsStore.getSettings().ragEmbeddingModel })
    );
    ipcMain.handle(
        "rag:query",
        (_event: IpcMainInvokeEvent, { collectionId, query, topK }: { collectionId: string; query: string; topK?: number }) =>
            rag.query(collectionId, query, topK)
    );
    ipcMain.handle("rag:listCollections", () => rag.listCollections());
    ipcMain.handle("rag:deleteCollection", (_event: IpcMainInvokeEvent, id: string) => rag.deleteCollection(requireString(id, "collection id")));

    ipcMain.handle("hf:search", async (_event: IpcMainInvokeEvent, query: string) => {
        try {
            return { results: await huggingface.searchGgufModels(String(query ?? ""), 20, accounts.getAccountToken("huggingface")) };
        } catch (err) {
            return { error: (err as Error).message };
        }
    });

    ipcMain.handle("hf:listFiles", async (_event: IpcMainInvokeEvent, modelId: string) => {
        requireString(modelId, "model id");
        try {
            return { files: await huggingface.listGgufFiles(modelId, accounts.getAccountToken("huggingface")) };
        } catch (err) {
            return { error: (err as Error).message };
        }
    });

    ipcMain.handle(
        "hf:downloadFile",
        async (
            event: IpcMainInvokeEvent,
            { requestId, modelId, filename }: { requestId: string; modelId: string; filename: string }
        ) => {
            requireString(modelId, "model id");
            requireString(filename, "filename");
            const dir = getLlamaCppModelsDir();
            const destPath = path.join(dir, filename.replace(/[/\\]/g, "_"));
            const channel = `hf:downloadProgress:${requestId}`;
            try {
                await huggingface.downloadGgufFile(modelId, filename, destPath, (progress) =>
                    event.sender.send(channel, progress)
                , accounts.getAccountToken("huggingface"));
                return { path: destPath };
            } catch (err) {
                const error = err as Error;
                logger.error(`Hugging Face download failed (${modelId}/${filename}): ${error.message}`);
                fs.rmSync(destPath, { force: true });
                return { error: error.message };
            }
        }
    );
}
