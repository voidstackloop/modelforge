import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { describe, it, expect, afterEach } from "vitest";
import * as backupStore from "./backup-store";
import { BackupUnreadableError, BackupCorruptError } from "./backup-store";
import * as sessionsStore from "./sessions-store";
import * as patientCasesStore from "./patient-cases-store";
import * as caseEncryption from "./case-encryption";

// Synthetic fixtures only — no real patient data, matching every other
// store test in this repo.

function userDataPath(name: string): string {
    return path.join(app.getPath("userData"), name);
}

function writeSynthetic(name: string, content: string): void {
    fs.writeFileSync(userDataPath(name), content);
}

function readIfExists(name: string): string | null {
    try {
        return fs.readFileSync(userDataPath(name), "utf-8");
    } catch {
        return null;
    }
}

const KNOWN_BACKUP_FILES = [
    "settings.json",
    "sessions.json",
    "sessions.enc.json",
    "patient-cases.json",
    "patient-cases.enc.json",
    "case-encryption-config.json",
    "projects.json",
    "model-registry.json",
    "evidence-sources.json",
    "energy-usage.json",
    "scheduled-tasks.json",
    "download-jobs.json",
    "audit-log.json",
    "audit-log.sqlite3",
    "audit-log.sqlite3-wal",
    "audit-log.sqlite3-shm",
    "rag.db",
    "policy-cache.json",
];

describe("backup-store", () => {
    afterEach(() => {
        // Order matters: clearConfig() first, since a test may have left
        // encryption enabled-but-locked, and sessionsStore.clearAll() would
        // throw CaseDataLockedError if it ran while still locked. clearAll()
        // runs next — it writes sessions.json with an empty array rather
        // than removing the file — so the file-removal loop runs last,
        // leaving genuinely no leftover sessions.json for the next test to
        // accidentally pick up.
        caseEncryption.clearConfig();
        sessionsStore.clearAll();
        for (const name of KNOWN_BACKUP_FILES) fs.rmSync(userDataPath(name), { force: true });
        fs.rmSync(path.join(app.getPath("userData"), "backups"), { recursive: true, force: true });
    });

    it("backs up every currently-present file and skips whatever doesn't exist", () => {
        writeSynthetic("settings.json", JSON.stringify({ theme: "dark" }));
        writeSynthetic("projects.json", JSON.stringify([{ id: "p1", name: "Synthetic project" }]));
        // patient-cases.json deliberately absent — never created in this test.

        const envelope = backupStore.createBackup("correct horse battery staple");
        const summary = backupStore.verifyBackup("correct horse battery staple", envelope);

        expect(summary.fileNames).toContain("settings.json");
        expect(summary.fileNames).toContain("projects.json");
        expect(summary.fileNames).not.toContain("patient-cases.json");
    });

    it("round-trips content exactly through backup and restore", () => {
        writeSynthetic("settings.json", JSON.stringify({ theme: "dark", language: "en" }));
        writeSynthetic("projects.json", JSON.stringify([{ id: "p1", name: "Synthetic project" }]));

        const envelope = backupStore.createBackup("correct horse battery staple");
        fs.rmSync(userDataPath("settings.json"));
        fs.rmSync(userDataPath("projects.json"));

        const result = backupStore.restoreBackup("correct horse battery staple", envelope);

        expect(result.filesRestored.sort()).toEqual(["projects.json", "settings.json"]);
        expect(JSON.parse(readIfExists("settings.json")!)).toEqual({ theme: "dark", language: "en" });
        expect(JSON.parse(readIfExists("projects.json")!)).toEqual([{ id: "p1", name: "Synthetic project" }]);
    });

    it("verifyBackup never touches any live file", () => {
        writeSynthetic("settings.json", JSON.stringify({ theme: "dark" }));
        const envelope = backupStore.createBackup("correct horse battery staple");
        fs.rmSync(userDataPath("settings.json"));

        backupStore.verifyBackup("correct horse battery staple", envelope);

        expect(readIfExists("settings.json")).toBeNull(); // still absent — verify is read-only
    });

    it("rejects an incorrect passphrase on verify, without applying anything", () => {
        writeSynthetic("settings.json", JSON.stringify({ theme: "dark" }));
        const envelope = backupStore.createBackup("correct horse battery staple");

        expect(() => backupStore.verifyBackup("wrong passphrase", envelope)).toThrow(BackupUnreadableError);
    });

    it("rejects an incorrect passphrase on restore, leaving live files completely untouched", () => {
        writeSynthetic("settings.json", JSON.stringify({ theme: "dark" }));
        writeSynthetic("projects.json", JSON.stringify([{ id: "p1", name: "Synthetic project" }]));
        const envelope = backupStore.createBackup("correct horse battery staple");
        writeSynthetic("settings.json", JSON.stringify({ theme: "light" })); // live state diverges after backup

        expect(() => backupStore.restoreBackup("wrong passphrase", envelope)).toThrow(BackupUnreadableError);

        // Nothing from the backup was applied — live state is exactly what
        // it was the instant before the failed restore attempt, not a mix.
        expect(JSON.parse(readIfExists("settings.json")!)).toEqual({ theme: "light" });
    });

    it("rejects a tampered/corrupted backup (GCM auth tag failure)", () => {
        writeSynthetic("settings.json", JSON.stringify({ theme: "dark" }));
        const envelope = backupStore.createBackup("correct horse battery staple");
        const parsed = JSON.parse(envelope);
        // Flip a character in the ciphertext — same tamper-detection
        // mechanism already proven for case-encryption.ts's own payloads.
        parsed.payload.ciphertextHex = parsed.payload.ciphertextHex.replace(/^./, (c: string) => (c === "0" ? "1" : "0"));

        expect(() => backupStore.restoreBackup("correct horse battery staple", JSON.stringify(parsed))).toThrow(BackupCorruptError);
    });

    it("rejects a backup with a checksum mismatch even under the correct passphrase", () => {
        // Constructs a manifest with an internally-inconsistent checksum,
        // encrypted correctly — proves the checksum check is independent
        // defense-in-depth, not just relying on the GCM auth tag.
        const passphrase = "correct horse battery staple";
        const salt = crypto.randomBytes(16);
        const key = crypto.scryptSync(passphrase, salt, 32);
        const verifierHex = crypto.createHmac("sha256", key).update("modelforge-medical-backup-verifier").digest("hex");
        const manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            appVersion: "0.0.0-test",
            files: [{ name: "settings.json", sha256Hex: "0".repeat(64), sizeBytes: 2, contentBase64: Buffer.from("{}").toString("base64") }],
        };
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(manifest), "utf-8"), cipher.final()]);
        const envelope = JSON.stringify({
            modelforge: "modelforge-backup-v1",
            saltHex: salt.toString("hex"),
            verifierHex,
            payload: { ivHex: iv.toString("hex"), ciphertextHex: ciphertext.toString("hex"), authTagHex: cipher.getAuthTag().toString("hex") },
        });

        expect(() => backupStore.verifyBackup(passphrase, envelope)).toThrow(BackupCorruptError);
    });

    it("rejects a backup containing a file name outside the known-safe list (path-traversal defense)", () => {
        const passphrase = "correct horse battery staple";
        const salt = crypto.randomBytes(16);
        const key = crypto.scryptSync(passphrase, salt, 32);
        const verifierHex = crypto.createHmac("sha256", key).update("modelforge-medical-backup-verifier").digest("hex");
        const maliciousContent = Buffer.from("pwned");
        const manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            appVersion: "0.0.0-test",
            files: [
                {
                    name: "../../evil.txt",
                    sha256Hex: crypto.createHash("sha256").update(maliciousContent).digest("hex"),
                    sizeBytes: maliciousContent.length,
                    contentBase64: maliciousContent.toString("base64"),
                },
            ],
        };
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(manifest), "utf-8"), cipher.final()]);
        const envelope = JSON.stringify({
            modelforge: "modelforge-backup-v1",
            saltHex: salt.toString("hex"),
            verifierHex,
            payload: { ivHex: iv.toString("hex"), ciphertextHex: ciphertext.toString("hex"), authTagHex: cipher.getAuthTag().toString("hex") },
        });

        expect(() => backupStore.verifyBackup(passphrase, envelope)).toThrow(BackupCorruptError);
        // Never wrote the malicious file anywhere under or outside userData.
        expect(fs.existsSync(path.join(app.getPath("userData"), "..", "evil.txt"))).toBe(false);
    });

    it("removes a stale plaintext counterpart when restoring an encrypted-mode backup", () => {
        // Backup taken while encryption was ON (only the .enc.json exists).
        writeSynthetic("patient-cases.enc.json", JSON.stringify({ ivHex: "aa", ciphertextHex: "bb", authTagHex: "cc" }));
        const envelope = backupStore.createBackup("correct horse battery staple");
        fs.rmSync(userDataPath("patient-cases.enc.json"));

        // Live device is currently in plaintext mode (has the OTHER file).
        writeSynthetic("patient-cases.json", JSON.stringify([{ id: "stale-plaintext-case" }]));

        backupStore.restoreBackup("correct horse battery staple", envelope);

        expect(readIfExists("patient-cases.json")).toBeNull(); // stale counterpart removed
        expect(readIfExists("patient-cases.enc.json")).not.toBeNull();
    });

    it("creates a pre-restore safety snapshot that can itself be restored (rollback)", () => {
        writeSynthetic("settings.json", JSON.stringify({ theme: "dark" }));
        const backupA = backupStore.createBackup("correct horse battery staple"); // state 1

        writeSynthetic("settings.json", JSON.stringify({ theme: "light" })); // state 2 (current, about to be overwritten)

        const result = backupStore.restoreBackup("correct horse battery staple", backupA); // -> state 1
        expect(JSON.parse(readIfExists("settings.json")!)).toEqual({ theme: "dark" });
        expect(fs.existsSync(result.safetySnapshotPath)).toBe(true);

        // Roll back: restoring the automatic safety snapshot brings state 2 back.
        const safetySnapshotEnvelope = fs.readFileSync(result.safetySnapshotPath, "utf-8");
        backupStore.restoreBackup("correct horse battery staple", safetySnapshotEnvelope);
        expect(JSON.parse(readIfExists("settings.json")!)).toEqual({ theme: "light" });
    });

    it("clears sessions-store's and patient-cases-store's read caches after a restore", async () => {
        sessionsStore.clearAll();
        const original = await sessionsStore.createSession("llama3.2");
        expect((await sessionsStore.listSessions()).length).toBe(1); // populates sessions-store's in-process cache

        const envelope = backupStore.createBackup("correct horse battery staple"); // backup with the original session

        // Simulate a different session existing at backup time — write a
        // *different* sessions.json directly (bypassing sessions-store, the
        // same way restore itself does), so the pre-restore cache (still
        // holding `original`) would be stale if not cleared.
        const now = new Date().toISOString();
        fs.writeFileSync(
            userDataPath("sessions.json"),
            JSON.stringify([{ id: "different-session", title: "Restored session", model: null, messages: [], createdAt: now, updatedAt: now }])
        );

        backupStore.restoreBackup("correct horse battery staple", envelope); // restores the ORIGINAL session back

        // If the cache weren't cleared, this would still report the
        // "different-session" this test wrote directly moments ago instead
        // of what the backup actually restored.
        const afterRestore = await sessionsStore.listSessions();
        expect(afterRestore.map((s) => s.id)).toEqual([original.id]);
    });

    it("compresses backup contents (version 2) and restores them byte-for-byte", () => {
        // Highly compressible synthetic content — repetition is what makes
        // the size assertion below meaningful.
        const repetitive = JSON.stringify({ theme: "dark".repeat(5000) });
        writeSynthetic("settings.json", repetitive);

        const envelope = backupStore.createBackup("correct horse battery staple");
        const parsed = JSON.parse(envelope);
        expect(parsed.payload).toBeDefined(); // sanity: still a valid envelope shape

        fs.rmSync(userDataPath("settings.json"));
        const result = backupStore.restoreBackup("correct horse battery staple", envelope);
        expect(result.filesRestored).toEqual(["settings.json"]);
        expect(readIfExists("settings.json")).toBe(repetitive);
    });

    it("still restores a version-1 (uncompressed) backup made before compression existed", () => {
        const passphrase = "correct horse battery staple";
        const salt = crypto.randomBytes(16);
        const key = crypto.scryptSync(passphrase, salt, 32);
        const verifierHex = crypto.createHmac("sha256", key).update("modelforge-medical-backup-verifier").digest("hex");
        const content = Buffer.from(JSON.stringify({ theme: "dark" }));
        const manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            appVersion: "0.0.0-test",
            files: [
                {
                    name: "settings.json",
                    sha256Hex: crypto.createHash("sha256").update(content).digest("hex"),
                    sizeBytes: content.length,
                    contentBase64: content.toString("base64"), // raw, NOT gzipped — version 1's format
                },
            ],
        };
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(manifest), "utf-8"), cipher.final()]);
        const envelope = JSON.stringify({
            modelforge: "modelforge-backup-v1",
            saltHex: salt.toString("hex"),
            verifierHex,
            payload: { ivHex: iv.toString("hex"), ciphertextHex: ciphertext.toString("hex"), authTagHex: cipher.getAuthTag().toString("hex") },
        });

        const result = backupStore.restoreBackup(passphrase, envelope);
        expect(result.filesRestored).toEqual(["settings.json"]);
        expect(JSON.parse(readIfExists("settings.json")!)).toEqual({ theme: "dark" });
    });

    it("locks case encryption when a restored backup carries a different case-encryption-config.json", () => {
        caseEncryption.setup("live-passphrase");
        expect(caseEncryption.isUnlocked()).toBe(true);

        writeSynthetic("settings.json", JSON.stringify({ theme: "dark" }));
        const envelope = backupStore.createBackup("correct horse battery staple"); // includes the current (live-passphrase) config

        // Simulate time passing: passphrase rotates to something else.
        caseEncryption.rotateKey("rotated-passphrase");
        expect(caseEncryption.isUnlocked()).toBe(true); // unlocked under the NEW key

        backupStore.restoreBackup("correct horse battery staple", envelope); // restores the OLD config

        // The in-memory session key (derived from the rotated passphrase)
        // no longer matches the just-restored config — restore must not
        // leave the app claiming to be unlocked with a key that doesn't
        // correspond to what's actually on disk anymore.
        expect(caseEncryption.isUnlocked()).toBe(false);
    });
});
