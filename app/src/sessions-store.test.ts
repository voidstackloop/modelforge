import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";
import { describe, it, expect, afterEach } from "vitest";
import * as sessionsStore from "./sessions-store";
import * as caseEncryption from "./case-encryption";

function plaintextSessionsPath(): string {
    return path.join(app.getPath("userData"), "sessions.json");
}
function encryptedSessionsPath(): string {
    return plaintextSessionsPath().replace(".json", ".enc.json");
}

// updatedAt has millisecond resolution; force distinct timestamps so
// ordering assertions aren't flaky when operations land in the same tick.
function sleepPastNextMs(): void {
    const start = Date.now();
    while (Date.now() === start) {
        /* busy-wait a few ms */
    }
}

describe("sessions-store", () => {
    it("creates a session and can retrieve it by id", () => {
        const created = sessionsStore.createSession("llama3.2", null);
        const fetched = sessionsStore.getSession(created.id);

        expect(fetched).not.toBeNull();
        expect(fetched?.title).toBe("New chat");
        expect(fetched?.model).toBe("llama3.2");
        expect(fetched?.messages).toEqual([]);
    });

    it("returns null for a session id that doesn't exist", () => {
        expect(sessionsStore.getSession("does-not-exist")).toBeNull();
    });

    it("updates only the given fields and bumps updatedAt", () => {
        const created = sessionsStore.createSession(null);
        const updated = sessionsStore.updateSession(created.id, { title: "Renamed" });

        expect(updated?.title).toBe("Renamed");
        expect(updated?.model).toBeNull();
    });

    it("deletes a session", () => {
        const created = sessionsStore.createSession(null);
        sessionsStore.deleteSession(created.id);
        expect(sessionsStore.getSession(created.id)).toBeNull();
    });

    it("unassigning a project clears projectId on its sessions only", () => {
        const inProject = sessionsStore.createSession(null, "proj-1");
        const notInProject = sessionsStore.createSession(null, null);

        sessionsStore.unassignProject("proj-1");

        expect(sessionsStore.getSession(inProject.id)?.projectId).toBeNull();
        expect(sessionsStore.getSession(notInProject.id)?.projectId).toBeNull();
    });

    it("lists sessions most-recently-updated first", () => {
        sessionsStore.clearAll();
        const first = sessionsStore.createSession(null);
        sleepPastNextMs();
        const second = sessionsStore.createSession(null);

        const list = sessionsStore.listSessions();
        expect(list[0].id).toBe(second.id);
    });

    describe("encryption at rest (shares patient-cases-store's encryption gate)", () => {
        afterEach(() => {
            caseEncryption.clearConfig();
            fs.rmSync(plaintextSessionsPath(), { force: true });
            fs.rmSync(encryptedSessionsPath(), { force: true });
        });

        it("migrates existing plaintext sessions to an encrypted file when encryption is enabled", () => {
            sessionsStore.clearAll();
            sessionsStore.createSession(null); // ensure the plaintext file exists
            expect(fs.existsSync(plaintextSessionsPath())).toBe(true);

            const data = sessionsStore.getAllSessionsForMigration();
            caseEncryption.setup("a strong passphrase");
            sessionsStore.overwriteAllSessions(data);

            expect(fs.existsSync(plaintextSessionsPath())).toBe(false);
            expect(fs.existsSync(encryptedSessionsPath())).toBe(true);
        });

        it("reads and writes normally while unlocked", () => {
            caseEncryption.setup("a strong passphrase");
            const created = sessionsStore.createSession("llama3.2");
            expect(sessionsStore.getSession(created.id)?.model).toBe("llama3.2");
        });

        it("throws CaseDataLockedError instead of returning an empty list when locked", () => {
            caseEncryption.setup("a strong passphrase");
            sessionsStore.createSession(null);
            caseEncryption.lock();
            expect(() => sessionsStore.listSessions()).toThrow(sessionsStore.CaseDataLockedError);
            expect(() => sessionsStore.createSession(null)).toThrow(sessionsStore.CaseDataLockedError);
        });

        it("recovers access after unlocking with the correct passphrase", () => {
            caseEncryption.setup("a strong passphrase");
            const created = sessionsStore.createSession("llama3.2");
            caseEncryption.lock();
            expect(caseEncryption.unlock("a strong passphrase")).toBe(true);
            expect(sessionsStore.getSession(created.id)?.model).toBe("llama3.2");
        });

        it("moving back to plaintext restores a readable file and removes the encrypted one", () => {
            caseEncryption.setup("a strong passphrase");
            sessionsStore.createSession(null);
            const data = sessionsStore.getAllSessionsForMigration();
            caseEncryption.clearConfig();
            sessionsStore.overwriteAllSessions(data);

            expect(sessionsStore.listSessions().length).toBeGreaterThan(0);
            expect(fs.existsSync(plaintextSessionsPath())).toBe(true);
            expect(fs.existsSync(encryptedSessionsPath())).toBe(false);
        });
    });
});
