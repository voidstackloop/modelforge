import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { MigrationPreview, MigrationSession } from "@modelforge/contracts";
import * as backupStore from "./backup-store";
import { getAllCasesForMigration, selectPatientCasesBackend } from "./patient-cases-store";
import { saveSettings } from "./settings-store";
import * as client from "./shared-backend-client";

export interface StagedMigrationResult { session: MigrationSession; preview: MigrationPreview; backupPath: string; recoveryKey: string }
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function createVerifiedSafetyBackup(migrationId: string): { backupPath: string; recoveryKey: string } {
    const recoveryKey = randomBytes(32).toString("base64url");
    const backupJson = backupStore.createBackup(recoveryKey);
    backupStore.verifyBackup(recoveryKey, backupJson);
    const directory = path.join(app.getPath("userData"), "migration-backups");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const backupPath = path.join(directory, `local-cases-${migrationId}.mfbackup`);
    const temporaryPath = `${backupPath}.tmp`;
    fs.writeFileSync(temporaryPath, backupJson, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, backupPath);
    backupStore.verifyBackup(recoveryKey, fs.readFileSync(backupPath, "utf8"));
    return { backupPath, recoveryKey };
}

export async function stageLocalCases(): Promise<StagedMigrationResult> {
    const cases = await getAllCasesForMigration();
    const session = await client.startCaseMigration(fingerprint(cases), cases.length);
    const safety = createVerifiedSafetyBackup(session.id);
    if (session.status === "staging") {
        for (let offset = 0; offset < cases.length; offset += 50) {
            const items = cases.slice(offset, offset + 50).map((patientCase) => ({ itemKey: `${patientCase.id}:${fingerprint(patientCase)}`, patientCase }));
            await client.uploadCaseMigrationBatch(session.id, items);
        }
        const preview = await client.validateCaseMigration(session.id);
        return { session: { ...session, status: "validated", acceptedItems: preview.valid, preview }, preview, ...safety };
    }
    if (session.preview) return { session, preview: session.preview, ...safety };
    throw new Error(`Migration ${session.id} cannot be resumed from status ${session.status} without a validation preview.`);
}

export async function activateStagedMigration(migrationId: string): Promise<MigrationSession> {
    const session = await client.activateCaseMigration(migrationId);
    if (!selectPatientCasesBackend("modelforge-shared-http")) throw new Error("Shared patient-case backend is unavailable after migration activation.");
    saveSettings({ patientCasesBackendId: "modelforge-shared-http" });
    return session;
}

export async function rollbackStagedMigration(migrationId: string): Promise<MigrationSession> {
    const session = await client.rollbackCaseMigration(migrationId);
    selectPatientCasesBackend("modelforge-local-json");
    saveSettings({ patientCasesBackendId: "modelforge-local-json" });
    return session;
}
