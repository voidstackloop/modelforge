import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { dialog as electronDialog } from "electron";
import { describe, it, expect, afterEach } from "vitest";
import { sessionToMarkdown, exportSession, importSessions, serializeForExport, deserializeImportedPayload, EncryptedExportUnreadableError } from "./data-transfer";
import * as sessionsStore from "./sessions-store";
import { CaseDataLockedError } from "./sessions-store";
import * as caseEncryption from "./case-encryption";
import type { ChatSession } from "./sessions-store";

// electron-mock.ts's `dialog` export is a controllable stub, not the real
// Electron `Dialog` type — tsc resolves this import against the real
// `electron` package's types (only vitest's runtime alias swaps in the
// mock), so it's re-typed here rather than fighting the real interface.
const dialog = electronDialog as unknown as {
    showSaveDialogResult: { canceled: boolean; filePath?: string };
    showOpenDialogResult: { canceled: boolean; filePaths: string[] };
};

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
    return {
        id: "1",
        title: "Test chat",
        model: "llama3.2",
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("sessionToMarkdown", () => {
    it("renders the title as a heading and each message with its speaker", () => {
        const md = sessionToMarkdown(
            makeSession({
                messages: [
                    { role: "user", content: "Hello" },
                    { role: "assistant", content: "Hi there" },
                ],
            })
        );

        expect(md).toContain("# Test chat");
        expect(md).toContain("**User:**\n\nHello");
        expect(md).toContain("**Assistant:**\n\nHi there");
    });

    it("omits tool-role messages and empty tool-call assistant messages", () => {
        const md = sessionToMarkdown(
            makeSession({
                messages: [
                    { role: "user", content: "What's 2+2?" },
                    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "calc", arguments: {} }] },
                    { role: "tool", content: "4", toolCallId: "1", toolName: "calc" },
                    { role: "assistant", content: "It's 4." },
                ],
            })
        );

        expect(md).not.toContain("calc");
        expect(md).not.toContain("**Tool:**");
        expect(md).toContain("It's 4.");
    });
});

// All fixtures are synthetic — no real patient data.

describe("serializeForExport / deserializeImportedPayload", () => {
    afterEach(() => {
        caseEncryption.clearConfig();
    });

    it("passes plain JSON through unchanged in both directions when encryption is disabled", () => {
        const data = { title: "Plain session", messages: [] };
        const serialized = serializeForExport(data);
        expect(serialized).toContain("Plain session");
        expect(deserializeImportedPayload(serialized)).toEqual(data);
    });

    it("wraps the data in an encrypted envelope when encryption is enabled and unlocked", () => {
        caseEncryption.setup("a strong passphrase");
        const data = { title: "Should never appear in the clear", messages: [] };
        const serialized = serializeForExport(data);

        expect(serialized).not.toContain("Should never appear in the clear");
        expect(JSON.parse(serialized).modelforge).toBe("modelforge-encrypted-export-v1");
    });

    it("round-trips the original data back through deserializeImportedPayload once unlocked", () => {
        caseEncryption.setup("a strong passphrase");
        const data = { title: "Round trip", messages: [{ role: "user", content: "hi" }] };
        const serialized = serializeForExport(data);

        expect(deserializeImportedPayload(serialized)).toEqual(data);
    });

    it("serializeForExport fails closed with CaseDataLockedError instead of falling back to plaintext when locked", () => {
        // Covers a real race, not just a theoretical one: exportSession reads
        // session data into memory, then awaits the save dialog — if an
        // inactivity timeout locks case encryption during that wait, this is
        // the check standing between "already-read plaintext" and a file on
        // disk.
        caseEncryption.setup("a strong passphrase");
        caseEncryption.lock();
        expect(() => serializeForExport({ title: "in-memory already" })).toThrow(CaseDataLockedError);
    });

    it("deserializeImportedPayload throws EncryptedExportUnreadableError for a recognized envelope when encryption is off", () => {
        caseEncryption.setup("a strong passphrase");
        const serialized = serializeForExport({ title: "x" });
        caseEncryption.clearConfig();

        expect(() => deserializeImportedPayload(serialized)).toThrow(EncryptedExportUnreadableError);
    });

    it("deserializeImportedPayload throws EncryptedExportUnreadableError when unlocked under the wrong passphrase", () => {
        caseEncryption.setup("original passphrase");
        const serialized = serializeForExport({ title: "x" });

        // A different install, or a passphrase rotated after this export was
        // written — encryption is on and unlocked, just under a different key.
        caseEncryption.clearConfig();
        caseEncryption.setup("a completely different passphrase");

        expect(() => deserializeImportedPayload(serialized)).toThrow(EncryptedExportUnreadableError);
    });
});

describe("exportSession / importSessions (encrypted round-trip through real files)", () => {
    function tempExportPath(): string {
        return path.join(os.tmpdir(), `modelforge-export-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    }

    afterEach(() => {
        caseEncryption.clearConfig();
        sessionsStore.clearAll();
        dialog.showSaveDialogResult = { canceled: true, filePath: undefined };
        dialog.showOpenDialogResult = { canceled: true, filePaths: [] };
    });

    it("writes plaintext JSON to disk when encryption is disabled", async () => {
        const session = await sessionsStore.createSession("llama3.2", null);
        await sessionsStore.updateSession(session.id, { title: "Plaintext export test" });
        const file = tempExportPath();
        dialog.showSaveDialogResult = { canceled: false, filePath: file };

        const result = await exportSession(null, session.id);

        expect(result.success).toBe(true);
        expect(fs.readFileSync(file, "utf-8")).toContain("Plaintext export test");
        fs.rmSync(file, { force: true });
    });

    it("writes an encrypted envelope to disk when encryption is enabled and unlocked, and re-imports it correctly once re-unlocked", async () => {
        caseEncryption.setup("a strong passphrase");
        const session = await sessionsStore.createSession("llama3.2", null);
        await sessionsStore.updateSession(session.id, { title: "Round trip title" });
        const file = tempExportPath();
        dialog.showSaveDialogResult = { canceled: false, filePath: file };

        const exportResult = await exportSession(null, session.id);
        expect(exportResult.success).toBe(true);
        expect(fs.readFileSync(file, "utf-8")).not.toContain("Round trip title");

        // Simulate reopening the export later: lock, then unlock again with
        // the same passphrase before importing.
        caseEncryption.lock();
        expect(caseEncryption.unlock("a strong passphrase")).toBe(true);
        dialog.showOpenDialogResult = { canceled: false, filePaths: [file] };

        const importResult = await importSessions(null);

        expect(importResult.imported).toBe(1);
        expect((await sessionsStore.listSessions()).some((s) => s.title === "Round trip title")).toBe(true);
        fs.rmSync(file, { force: true });
    });

    it("refuses to export in plaintext when encryption is enabled but locked", async () => {
        caseEncryption.setup("a strong passphrase");
        const session = await sessionsStore.createSession("llama3.2", null);
        caseEncryption.lock();
        const file = tempExportPath();
        dialog.showSaveDialogResult = { canceled: false, filePath: file };

        await expect(exportSession(null, session.id)).rejects.toThrow(CaseDataLockedError);
        expect(fs.existsSync(file)).toBe(false);
    });

    it("throws importing an encrypted export while encryption is off, instead of silently reporting 0 imported", async () => {
        caseEncryption.setup("a strong passphrase");
        const session = await sessionsStore.createSession("llama3.2", null);
        const file = tempExportPath();
        dialog.showSaveDialogResult = { canceled: false, filePath: file };
        await exportSession(null, session.id);

        caseEncryption.clearConfig();
        dialog.showOpenDialogResult = { canceled: false, filePaths: [file] };

        await expect(importSessions(null)).rejects.toThrow(EncryptedExportUnreadableError);
        fs.rmSync(file, { force: true });
    });

    it("still returns 0 imported (not a hard failure) for an unrelated plain JSON file", async () => {
        const file = tempExportPath();
        fs.writeFileSync(file, JSON.stringify({ notASession: true }));
        dialog.showOpenDialogResult = { canceled: false, filePaths: [file] };

        const result = await importSessions(null);

        expect(result.imported).toBe(0);
        fs.rmSync(file, { force: true });
    });
});
