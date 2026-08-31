import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as caseEncryption from "../case-encryption";
import * as patientCasesStore from "../patient-cases-store";
import * as sessionsStore from "../sessions-store";
import * as ragDb from "../rag-db";
import * as auditLogStore from "../audit-log-store";
import { requireString } from "../app-state";

const MIN_PASSPHRASE_LENGTH = 8;

export function registerEncryptionIpc(): void {
    ipcMain.handle("encryption:status", () => ({
        enabled: caseEncryption.isEnabled(),
        unlocked: caseEncryption.isUnlocked(),
    }));

    ipcMain.handle("encryption:setup", async (_event: IpcMainInvokeEvent, passphrase: string) => {
        requireString(passphrase, "passphrase");
        if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
            return { success: false, error: `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.` };
        }
        if (caseEncryption.isEnabled()) {
            return { success: false, error: "Encryption is already enabled." };
        }
        const cases = await patientCasesStore.getAllCasesForMigration();
        const sessions = sessionsStore.getAllSessionsForMigration();
        const ragContent = ragDb.getAllContentForMigration();
        caseEncryption.setup(passphrase);
        await patientCasesStore.overwriteAllCases(cases);
        sessionsStore.overwriteAllSessions(sessions);
        ragDb.overwriteAllContent(ragContent);
        auditLogStore.recordEvent("settings-changed", { detail: "case-encryption-enabled" });
        return { success: true };
    });

    ipcMain.handle("encryption:unlock", (_event: IpcMainInvokeEvent, passphrase: string) => {
        requireString(passphrase, "passphrase");
        return { success: caseEncryption.unlock(passphrase) };
    });

    ipcMain.handle("encryption:lock", () => {
        // caseEncryption.lock() itself clears both stores' decrypted read
        // caches before the key goes away — see case-encryption.ts's
        // onBeforeLock and the hooks sessions-store.ts/patient-cases-store.ts
        // register with it.
        caseEncryption.lock();
    });

    ipcMain.handle("encryption:disable", async (_event: IpcMainInvokeEvent, passphrase: string) => {
        requireString(passphrase, "passphrase");
        if (!caseEncryption.unlock(passphrase)) {
            return { success: false, error: "Incorrect passphrase." };
        }
        const cases = await patientCasesStore.getAllCasesForMigration();
        const sessions = sessionsStore.getAllSessionsForMigration();
        const ragContent = ragDb.getAllContentForMigration();
        caseEncryption.clearConfig();
        await patientCasesStore.overwriteAllCases(cases);
        sessionsStore.overwriteAllSessions(sessions);
        ragDb.overwriteAllContent(ragContent);
        auditLogStore.recordEvent("settings-changed", { detail: "case-encryption-disabled" });
        return { success: true };
    });

    ipcMain.handle(
        "encryption:changePassphrase",
        async (_event: IpcMainInvokeEvent, { oldPassphrase, newPassphrase }: { oldPassphrase: string; newPassphrase: string }) => {
            requireString(oldPassphrase, "current passphrase");
            requireString(newPassphrase, "new passphrase");
            if (newPassphrase.length < MIN_PASSPHRASE_LENGTH) {
                return { success: false, error: `New passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.` };
            }
            if (!caseEncryption.unlock(oldPassphrase)) {
                return { success: false, error: "Incorrect current passphrase." };
            }
            const cases = await patientCasesStore.getAllCasesForMigration();
            const sessions = sessionsStore.getAllSessionsForMigration();
            const ragContent = ragDb.getAllContentForMigration();
            caseEncryption.rotateKey(newPassphrase);
            await patientCasesStore.overwriteAllCases(cases);
            sessionsStore.overwriteAllSessions(sessions);
            ragDb.overwriteAllContent(ragContent);
            auditLogStore.recordEvent("settings-changed", { detail: "case-encryption-passphrase-changed" });
            return { success: true };
        }
    );
}
