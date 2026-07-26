import { ipcMain, IpcMainInvokeEvent } from "electron";
import { logger } from "../logger";
import * as fileReader from "../file-reader";
import * as secretsStore from "../secrets-store";
import * as accounts from "../accounts";
import * as openaiProvider from "../providers/openai";
import { secretsSetInputSchema, parseOrThrow } from "../schemas";
import { getMainWindow, requireString } from "../app-state";

export function registerFilesIpc(): void {
    ipcMain.handle("files:openAndRead", () => fileReader.openAndReadFiles(getMainWindow()));
    ipcMain.handle("files:openFolderAndRead", () => fileReader.openFolderAndRead(getMainWindow()));
    ipcMain.handle("files:openMedia", () => fileReader.openAndReadMedia(getMainWindow()));

    ipcMain.handle("secrets:has", (_event: IpcMainInvokeEvent, key: string) =>
        secretsStore.hasSecret(requireString(key, "secret key"))
    );
    ipcMain.handle("secrets:set", (_event: IpcMainInvokeEvent, input: unknown) => {
        const { key, value } = parseOrThrow(secretsSetInputSchema, input, "secrets:set arguments");
        secretsStore.setSecret(key, value ?? "");
    });
    ipcMain.handle("secrets:isEncryptionAvailable", () => secretsStore.isEncryptionAvailable());

    ipcMain.handle("accounts:status", (_event: IpcMainInvokeEvent, provider: accounts.AccountProvider) =>
        accounts.getLinkedAccount(provider)
    );
    ipcMain.handle("accounts:connect", async (_event: IpcMainInvokeEvent, { provider, token }: { provider: accounts.AccountProvider; token: string }) =>
        accounts.connectAccount(provider, requireString(token, "access token"))
    );
    ipcMain.handle("accounts:disconnect", (_event: IpcMainInvokeEvent, provider: accounts.AccountProvider) =>
        accounts.disconnectAccount(provider)
    );

    ipcMain.handle(
        "audio:transcribe",
        async (_event: IpcMainInvokeEvent, { audioBase64, mimeType }: { audioBase64: string; mimeType: string }) => {
            requireString(audioBase64, "audio data");
            const apiKey = secretsStore.getSecret("openai_api_key");
            if (!apiKey) {
                return { error: "Voice input needs an OpenAI API key — add one in Settings to use it." };
            }
            try {
                const buffer = Buffer.from(audioBase64, "base64");
                const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("ogg") ? "ogg" : "wav";
                const text = await openaiProvider.transcribeAudio(apiKey, buffer, `audio.${ext}`);
                return { text };
            } catch (err) {
                const error = err as Error;
                logger.error(`Audio transcription failed: ${error.message}`);
                return { error: error.message };
            }
        }
    );
}
