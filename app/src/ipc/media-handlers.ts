import { ipcMain, IpcMainInvokeEvent, desktopCapturer } from "electron";
import { logger } from "../logger";
import * as figma from "../figma";
import * as ocr from "../ocr";
import * as secretsStore from "../secrets-store";
import { requireString } from "../app-state";

export function registerMediaIpc(): void {
    ipcMain.handle("ocr:recognize", async (_event: IpcMainInvokeEvent, imageBase64: string) => {
        requireString(imageBase64, "image data");
        try {
            return { text: await ocr.recognizeText(imageBase64) };
        } catch (err) {
            const error = err as Error;
            logger.error(`OCR failed: ${error.message}`);
            return { error: `OCR failed: ${error.message}` };
        }
    });

    ipcMain.handle("figma:fetchFrame", async (_event: IpcMainInvokeEvent, url: string) => {
        requireString(url, "Figma URL");
        const token = secretsStore.getSecret("figma_token");
        if (!token) return { error: "Add a Figma personal access token in Settings first." };
        try {
            return { result: await figma.fetchFigmaFrameImage(token, url) };
        } catch (err) {
            return { error: (err as Error).message };
        }
    });

    ipcMain.handle("screen:listSources", async () => {
        try {
            const sources = await desktopCapturer.getSources({
                types: ["screen", "window"],
                thumbnailSize: { width: 400, height: 250 },
            });
            return sources.map((s) => ({ id: s.id, name: s.name, thumbnailDataUrl: s.thumbnail.toDataURL() }));
        } catch (err) {
            logger.error(`Failed to list screen capture sources: ${(err as Error).message}`);
            return [];
        }
    });

    ipcMain.handle("screen:capture", async (_event: IpcMainInvokeEvent, sourceId: string) => {
        requireString(sourceId, "source id");
        try {
            // Re-query at full size rather than reusing the small picker
            // thumbnail — sources can also disappear between listing and
            // capture (a window closed, a display disconnected).
            const sources = await desktopCapturer.getSources({
                types: ["screen", "window"],
                thumbnailSize: { width: 2560, height: 1440 },
            });
            const match = sources.find((s) => s.id === sourceId);
            if (!match) return { error: "That screen/window is no longer available." };
            const dataUrl = match.thumbnail.toDataURL();
            const dataBase64 = dataUrl.split(",")[1] ?? "";
            if (!dataBase64) return { error: "Capture returned an empty image." };
            return { dataBase64, mimeType: "image/png" };
        } catch (err) {
            const error = err as Error;
            logger.error(`Screen capture failed: ${error.message}`);
            return { error: error.message };
        }
    });
}
