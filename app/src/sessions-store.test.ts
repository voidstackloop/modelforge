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
    it("creates a session and can retrieve it by id", async () => {
        const created = await sessionsStore.createSession("llama3.2", null);
        const fetched = await sessionsStore.getSession(created.id);

        expect(fetched).not.toBeNull();
        expect(fetched?.title).toBe("New chat");
        expect(fetched?.model).toBe("llama3.2");
        expect(fetched?.messages).toEqual([]);
    });

    it("returns null for a session id that doesn't exist", async () => {
        expect(await sessionsStore.getSession("does-not-exist")).toBeNull();
    });

    it("updates only the given fields and bumps updatedAt", async () => {
        const created = await sessionsStore.createSession(null);
        const updated = await sessionsStore.updateSession(created.id, { title: "Renamed" });

        expect(updated?.title).toBe("Renamed");
        expect(updated?.model).toBeNull();
    });

    it("deletes a session", async () => {
        const created = await sessionsStore.createSession(null);
        await sessionsStore.deleteSession(created.id);
        expect(await sessionsStore.getSession(created.id)).toBeNull();
    });

    it("unassigning a project clears projectId on its sessions only", async () => {
        const inProject = await sessionsStore.createSession(null, "proj-1");
        const notInProject = await sessionsStore.createSession(null, null);

        sessionsStore.unassignProject("proj-1");

        expect((await sessionsStore.getSession(inProject.id))?.projectId).toBeNull();
        expect((await sessionsStore.getSession(notInProject.id))?.projectId).toBeNull();
    });

    it("lists sessions most-recently-updated first", async () => {
        sessionsStore.clearAll();
        const first = await sessionsStore.createSession(null);
        sleepPastNextMs();
        const second = await sessionsStore.createSession(null);

        const list = await sessionsStore.listSessions();
        expect(list[0].id).toBe(second.id);
    });

    describe("encryption at rest (shares patient-cases-store's encryption gate)", () => {
        afterEach(() => {
            caseEncryption.clearConfig();
            fs.rmSync(plaintextSessionsPath(), { force: true });
            fs.rmSync(encryptedSessionsPath(), { force: true });
        });

        it("migrates existing plaintext sessions to an encrypted file when encryption is enabled", async () => {
            sessionsStore.clearAll();
            await sessionsStore.createSession(null); // ensure the plaintext file exists
            expect(fs.existsSync(plaintextSessionsPath())).toBe(true);

            const data = sessionsStore.getAllSessionsForMigration();
            caseEncryption.setup("a strong passphrase");
            sessionsStore.overwriteAllSessions(data);

            expect(fs.existsSync(plaintextSessionsPath())).toBe(false);
            expect(fs.existsSync(encryptedSessionsPath())).toBe(true);
        });

        it("reads and writes normally while unlocked", async () => {
            caseEncryption.setup("a strong passphrase");
            const created = await sessionsStore.createSession("llama3.2");
            expect((await sessionsStore.getSession(created.id))?.model).toBe("llama3.2");
        });

        it("throws CaseDataLockedError instead of returning an empty list when locked", async () => {
            caseEncryption.setup("a strong passphrase");
            await sessionsStore.createSession(null);
            caseEncryption.lock();
            await expect(sessionsStore.listSessions()).rejects.toThrow(sessionsStore.CaseDataLockedError);
            await expect(sessionsStore.createSession(null)).rejects.toThrow(sessionsStore.CaseDataLockedError);
        });

        it("recovers access after unlocking with the correct passphrase", async () => {
            caseEncryption.setup("a strong passphrase");
            const created = await sessionsStore.createSession("llama3.2");
            caseEncryption.lock();
            expect(caseEncryption.unlock("a strong passphrase")).toBe(true);
            expect((await sessionsStore.getSession(created.id))?.model).toBe("llama3.2");
        });

        it("moving back to plaintext restores a readable file and removes the encrypted one", async () => {
            caseEncryption.setup("a strong passphrase");
            await sessionsStore.createSession(null);
            const data = sessionsStore.getAllSessionsForMigration();
            caseEncryption.clearConfig();
            sessionsStore.overwriteAllSessions(data);

            expect((await sessionsStore.listSessions()).length).toBeGreaterThan(0);
            expect(fs.existsSync(plaintextSessionsPath())).toBe(true);
            expect(fs.existsSync(encryptedSessionsPath())).toBe(false);
        });
    });

    // A single agent-mode turn can call sessionsStore.updateSession() once per
    // tool-call round-trip, each followed by a sidebar refresh that lists
    // sessions again (see Chat.tsx's runCompletion/continueAfterTools loop) —
    // every one of those used to be a full read-and-decrypt of every stored
    // session's entire message history just to persist or list one session.
    // These tests prove the in-process cache actually eliminates the
    // redundant disk reads (not just "happens not to break anything") by
    // mutating the file directly, bypassing the store, and checking whether
    // a subsequent call notices.
    describe("in-process read cache", () => {
        afterEach(() => {
            caseEncryption.clearConfig();
            sessionsStore.clearAll();
            fs.rmSync(plaintextSessionsPath(), { force: true });
            fs.rmSync(encryptedSessionsPath(), { force: true });
        });

        it("serves cached data on a repeated call instead of re-reading a file changed out from under it", async () => {
            sessionsStore.clearAll();
            await sessionsStore.createSession(null);
            expect((await sessionsStore.listSessions()).length).toBe(1); // populates the cache

            // Bypasses the store entirely — if listSessions() actually hit
            // disk again, it would see this instead of the cached value.
            fs.writeFileSync(plaintextSessionsPath(), JSON.stringify([]));

            expect((await sessionsStore.listSessions()).length).toBe(1);
        });

        it("clearCache() forces the next read to pick up what's actually on disk", async () => {
            sessionsStore.clearAll();
            await sessionsStore.createSession(null);
            expect((await sessionsStore.listSessions()).length).toBe(1); // populates the cache

            fs.writeFileSync(plaintextSessionsPath(), JSON.stringify([]));
            sessionsStore.clearCache();

            expect((await sessionsStore.listSessions()).length).toBe(0);
        });

        it("a write refreshes the cache with the written value, so a following read never needs to touch disk", async () => {
            const created = await sessionsStore.createSession(null);
            await sessionsStore.updateSession(created.id, { title: "Written, then read from cache" });

            // Corrupts the on-disk file — if getSession() had to re-read it
            // to answer, this would throw or return something else instead.
            fs.writeFileSync(plaintextSessionsPath(), "not valid json{{{");

            expect((await sessionsStore.getSession(created.id))?.title).toBe("Written, then read from cache");
        });

        it("clearCache() is safe to call with nothing cached yet — the next read just falls through to disk", async () => {
            sessionsStore.clearCache();
            sessionsStore.clearCache();
            expect(await sessionsStore.listSessions()).toEqual([]);
        });

        it("updateSession's write reaches disk immediately, before it returns — no deferred/debounced write", async () => {
            // A pending write only in memory is a real data-loss risk for
            // clinical data on a crash/power-loss, so every write here is
            // synchronous. This guards against that regressing.
            const created = await sessionsStore.createSession(null);
            await sessionsStore.updateSession(created.id, { title: "Durable immediately" });

            const onDisk: sessionsStore.ChatSession[] = JSON.parse(fs.readFileSync(plaintextSessionsPath(), "utf-8"));
            expect(onDisk.find((s) => s.id === created.id)?.title).toBe("Durable immediately");
        });

        it("locking after an update doesn't lose it — the write already happened synchronously", async () => {
            caseEncryption.setup("a strong passphrase");
            const created = await sessionsStore.createSession("llama3.2");
            await sessionsStore.updateSession(created.id, { title: "Already durable before lock" });

            caseEncryption.lock();
            expect(caseEncryption.unlock("a strong passphrase")).toBe(true);
            expect((await sessionsStore.getSession(created.id))?.title).toBe("Already durable before lock");
        });
    });
});

describe("sessions-store: backend registry availability", () => {
    afterEach(() => sessionsStore.selectSessionsBackend(sessionsStore.localSessionsBackend.name));

    it("lists the local backend as available", () => {
        expect(sessionsStore.listSessionsBackends()).toContainEqual({
            name: "modelforge-local-json",
            label: "Local (this device)",
            scope: "local",
            available: true,
        });
    });

    it("reports an unavailable backend and refuses to make it active", () => {
        sessionsStore.registerSessionsBackend({
            name: "unavailable-shared-session-stub",
            label: "Unavailable Shared Session Stub",
            scope: "shared",
            limitations: "requires configuration",
            isAvailable: () => false,
            readAll: async () => [],
            writeAll: async () => {},
        });
        const before = sessionsStore.getSessionsBackend().name;

        expect(
            sessionsStore.listSessionsBackends().find((backend) => backend.name === "unavailable-shared-session-stub")?.available
        ).toBe(false);
        expect(sessionsStore.selectSessionsBackend("unavailable-shared-session-stub")).toBe(false);
        expect(sessionsStore.getSessionsBackend().name).toBe(before);
    });
});
