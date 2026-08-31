import * as fs from "node:fs";
import { app } from "electron";
import type { MigrationPreview, MigrationSession, PatientCase } from "@modelforge/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as backupStore from "./backup-store";
import * as patientCasesStore from "./patient-cases-store";
import * as settingsStore from "./settings-store";
import * as client from "./shared-backend-client";
import { activateStagedMigration, rollbackStagedMigration, stageLocalCases } from "./case-migration";

vi.mock("./backup-store", () => ({ createBackup: vi.fn(), verifyBackup: vi.fn() }));
vi.mock("./patient-cases-store", () => ({ getAllCasesForMigration: vi.fn(), selectPatientCasesBackend: vi.fn() }));
vi.mock("./settings-store", () => ({ saveSettings: vi.fn() }));
vi.mock("./shared-backend-client", () => ({
    startCaseMigration: vi.fn(),
    uploadCaseMigrationBatch: vi.fn(),
    validateCaseMigration: vi.fn(),
    activateCaseMigration: vi.fn(),
    rollbackCaseMigration: vi.fn(),
}));

const preview: MigrationPreview = {
    total: 1,
    valid: 1,
    invalid: 0,
    collisions: 0,
    items: [{ caseId: "case-1", status: "accepted", errors: [] }],
};
const session = (status: MigrationSession["status"], withPreview = false): MigrationSession => ({
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    status,
    sourceFingerprint: "source",
    totalItems: 1,
    acceptedItems: withPreview ? 1 : 0,
    preview: withPreview ? preview : undefined,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
});

describe("case migration orchestration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(patientCasesStore.getAllCasesForMigration).mockResolvedValue([{ id: "case-1" } as PatientCase]);
        vi.mocked(backupStore.createBackup).mockReturnValue("verified-encrypted-backup");
        vi.mocked(client.uploadCaseMigrationBatch).mockResolvedValue(session("staging"));
        vi.mocked(client.validateCaseMigration).mockResolvedValue(preview);
        vi.mocked(patientCasesStore.selectPatientCasesBackend).mockReturnValue(true);
    });

    it("creates and verifies a safety backup, uploads stable batches, and validates", async () => {
        vi.mocked(client.startCaseMigration).mockResolvedValue(session("staging"));
        const result = await stageLocalCases();

        expect(backupStore.createBackup).toHaveBeenCalledOnce();
        expect(backupStore.verifyBackup).toHaveBeenCalledTimes(2);
        expect(fs.existsSync(result.backupPath)).toBe(true);
        expect(result.recoveryKey.length).toBeGreaterThan(32);
        expect(client.uploadCaseMigrationBatch).toHaveBeenCalledWith(
            session("staging").id,
            [expect.objectContaining({ itemKey: expect.stringMatching(/^case-1:[a-f0-9]{64}$/) })]
        );
        expect(client.validateCaseMigration).toHaveBeenCalledWith(session("staging").id);
        expect(result.preview).toEqual(preview);
    });

    it("resumes a previously validated fingerprint without re-uploading", async () => {
        vi.mocked(client.startCaseMigration).mockResolvedValue(session("validated", true));
        const result = await stageLocalCases();

        expect(client.uploadCaseMigrationBatch).not.toHaveBeenCalled();
        expect(client.validateCaseMigration).not.toHaveBeenCalled();
        expect(result.preview).toEqual(preview);
    });

    it("persists backend authority only after activation or rollback succeeds", async () => {
        vi.mocked(client.activateCaseMigration).mockResolvedValue(session("active", true));
        await activateStagedMigration(session("active").id);
        expect(patientCasesStore.selectPatientCasesBackend).toHaveBeenCalledWith("modelforge-shared-http");
        expect(settingsStore.saveSettings).toHaveBeenCalledWith({ patientCasesBackendId: "modelforge-shared-http" });

        vi.mocked(client.rollbackCaseMigration).mockResolvedValue(session("rolled-back", true));
        await rollbackStagedMigration(session("active").id);
        expect(patientCasesStore.selectPatientCasesBackend).toHaveBeenCalledWith("modelforge-local-json");
        expect(settingsStore.saveSettings).toHaveBeenCalledWith({ patientCasesBackendId: "modelforge-local-json" });
    });
});
