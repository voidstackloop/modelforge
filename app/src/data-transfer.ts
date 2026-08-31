import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { app, dialog, shell, BrowserWindow } from "electron";
import * as sessionsStore from "./sessions-store";
import type { ChatSession } from "./sessions-store";
import type { PromptPreset } from "./settings-store";
import * as auditLogStore from "./audit-log-store";
import * as caseEncryption from "./case-encryption";
import { CaseDataLockedError } from "./case-encryption";
import type { EncryptedPayload } from "./case-encryption";

function sanitizeFilename(name: string): string {
    return name.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 80) || "chat";
}

// --- Encrypted export envelope ----------------------------------------------
//
// JSON exports (a single session, or all of them) can carry the exact same
// clinical detail as sessions.json itself — case context routinely gets
// pasted or typed straight into a chat message. Enabling case encryption at
// rest (Settings → Audit & Privacy) protects sessions.json/patient-cases.json
// on disk, but export wrote a second, unprotected plaintext copy of that same
// content — silently undoing the protection the user had just turned on.
//
// So when case encryption is enabled, a JSON export is wrapped in this
// envelope and encrypted with the *same* session key already protecting
// sessions.json, rather than plaintext. There's no second passphrase to
// invent or remember, and no new "enter a password for this file" UI: the
// user re-enters their existing case-encryption passphrase (by unlocking the
// app) to read the export back in later, exactly like unlocking any other
// store this app protects.
//
// Markdown export (exportSessionMarkdown below) is a deliberately different,
// unencrypted path — the entire point of that format is a human-readable
// file meant to be read or handed to someone outside the app, so it can't be
// encrypted without defeating its own purpose. The renderer warns the user
// visibly before writing one while case encryption is enabled instead.
//
// Trade-off worth being explicit about: because the key is the app's live
// session key, an export can only be decrypted by importing it into a
// ModelForge install with case encryption enabled and unlocked under the
// *same* passphrase that was active at export time. Rotating the
// case-encryption passphrase (Settings) re-encrypts sessions.json in place,
// but a previously-exported file is a static snapshot that migration never
// touches — it stays keyed to whatever passphrase was active when it was
// written. Sharing an export with someone who doesn't hold that passphrase
// is (deliberately) not something this supports; that would need a real,
// separately-designed "share outside the app" feature, not a side effect of
// this fix.
const EXPORT_ENVELOPE_MARKER = "modelforge-encrypted-export-v1";

interface EncryptedExportEnvelope {
    modelforge: typeof EXPORT_ENVELOPE_MARKER;
    payload: EncryptedPayload;
}

function isEncryptedExportEnvelope(value: unknown): value is EncryptedExportEnvelope {
    return !!value && typeof value === "object" && (value as { modelforge?: unknown }).modelforge === EXPORT_ENVELOPE_MARKER;
}

/** Thrown when an exported file's encrypted envelope can't be read back —
 * either because case encryption isn't enabled/unlocked on this install right
 * now, or because the currently-unlocked passphrase doesn't match the one the
 * file was encrypted with (AES-GCM's auth tag catches that rather than
 * silently producing garbage). Never collapsed into "0 imported" — that
 * would look identical to "this file had nothing importable in it," which is
 * a very different, much less alarming situation than "your passphrase is
 * wrong" or "you forgot to unlock." */
export class EncryptedExportUnreadableError extends Error {
    constructor() {
        super(
            "This file is an encrypted ModelForge export. Enable case encryption (Settings → Audit & Privacy) and " +
                "unlock it with the same passphrase that was active when this file was exported, then try importing again."
        );
        this.name = "EncryptedExportUnreadableError";
    }
}

/** Serializes `data` for a JSON export file: encrypted (via the current case-
 * encryption session key) when case encryption is enabled, plain JSON
 * otherwise. Throws CaseDataLockedError rather than falling back to
 * plaintext when encryption is enabled but not currently unlocked — export
 * fails closed instead of silently producing an unprotected file. */
export function serializeForExport(data: unknown): string {
    const json = JSON.stringify(data, null, 2);
    if (!caseEncryption.isEnabled()) return json;
    if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
    const envelope: EncryptedExportEnvelope = {
        modelforge: EXPORT_ENVELOPE_MARKER,
        payload: caseEncryption.encrypt(json, caseEncryption.getSessionKey()!),
    };
    return JSON.stringify(envelope, null, 2);
}

/** Reverses serializeForExport: plain JSON passes through untouched: a
 * recognized encrypted envelope is decrypted with the current case-
 * encryption session key. Throws EncryptedExportUnreadableError — never
 * returns a decoy empty/garbage result — when the envelope can't be
 * decrypted right now, whether that's because encryption is off/locked or
 * because the unlocked passphrase doesn't match the one used at export. */
export function deserializeImportedPayload(raw: string): unknown {
    const parsed: unknown = JSON.parse(raw);
    if (!isEncryptedExportEnvelope(parsed)) return parsed;
    if (!caseEncryption.isEnabled() || !caseEncryption.isUnlocked()) throw new EncryptedExportUnreadableError();
    try {
        return JSON.parse(caseEncryption.decrypt(parsed.payload, caseEncryption.getSessionKey()!));
    } catch {
        throw new EncryptedExportUnreadableError();
    }
}

export async function exportSession(win: BrowserWindow | null, id: string): Promise<{ success: boolean }> {
    const session = await sessionsStore.getSession(id);
    if (!session) return { success: false };

    const options = {
        defaultPath: `${sanitizeFilename(session.title)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { success: false };

    fs.writeFileSync(result.filePath, serializeForExport(session));
    auditLogStore.recordEvent("export", { targetType: "session", targetId: id, detail: caseEncryption.isEnabled() ? "session-json-encrypted" : "session-json" });
    return { success: true };
}

// Tool-call/result messages are omitted from the Markdown rendering — they're
// agent-mode bookkeeping, not something a reader sharing/archiving a
// conversation cares about seeing.
export function sessionToMarkdown(session: ChatSession): string {
    const lines: string[] = [`# ${session.title}`, ""];
    for (const m of session.messages) {
        if (m.role === "tool" || (m.role === "assistant" && !m.content && m.toolCalls?.length)) continue;
        const speaker = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
        lines.push(`**${speaker}:**`, "", m.content, "");
    }
    return lines.join("\n");
}

export async function exportSessionMarkdown(win: BrowserWindow | null, id: string): Promise<{ success: boolean }> {
    const session = await sessionsStore.getSession(id);
    if (!session) return { success: false };

    const options = {
        defaultPath: `${sanitizeFilename(session.title)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { success: false };

    fs.writeFileSync(result.filePath, sessionToMarkdown(session));
    auditLogStore.recordEvent("export", { targetType: "session", targetId: id, detail: "session-markdown" });
    return { success: true };
}

export async function exportAllSessions(win: BrowserWindow | null): Promise<{ success: boolean }> {
    const sessions = await sessionsStore.listSessions();
    const date = new Date().toISOString().slice(0, 10);

    const options = {
        defaultPath: `modelforge-export-${date}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { success: false };

    fs.writeFileSync(result.filePath, serializeForExport(sessions));
    auditLogStore.recordEvent("export", { targetType: "export", detail: caseEncryption.isEnabled() ? `all-sessions-encrypted:${sessions.length}` : `all-sessions:${sessions.length}` });
    return { success: true };
}

function looksLikeSession(value: unknown): value is Partial<ChatSession> {
    return !!value && typeof value === "object" && Array.isArray((value as { messages?: unknown }).messages);
}

export async function importSessions(win: BrowserWindow | null): Promise<{ imported: number }> {
    const options = { properties: ["openFile" as const], filters: [{ name: "JSON", extensions: ["json"] }] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return { imported: 0 };

    let raw: unknown;
    try {
        raw = deserializeImportedPayload(fs.readFileSync(result.filePaths[0], "utf-8"));
    } catch (err) {
        // A recognized-but-undecryptable encrypted envelope (locked/disabled,
        // or the wrong passphrase) must surface as a clear failure, not
        // collapse into the same "0 imported" result as a corrupted file or
        // one with nothing importable in it — those really are silent-safe
        // no-ops, this is not.
        if (err instanceof CaseDataLockedError || err instanceof EncryptedExportUnreadableError) throw err;
        return { imported: 0 };
    }

    const candidates: unknown[] = Array.isArray(raw) ? raw : [raw];
    let imported = 0;

    for (const candidate of candidates) {
        if (!looksLikeSession(candidate)) continue;
        const now = new Date().toISOString();
        await sessionsStore.addSession({
            id: randomUUID(),
            title: typeof candidate.title === "string" ? candidate.title : "Imported chat",
            model: typeof candidate.model === "string" ? candidate.model : null,
            messages: candidate.messages!,
            params: candidate.params ?? null,
            createdAt: now,
            updatedAt: now,
        });
        imported++;
    }

    return { imported };
}

// Presets are shared between machines/teammates as a plain JSON file rather
// than through any live sync — this app has no server component, so "share
// with the team" means "send them this file".
export async function exportPromptPresets(win: BrowserWindow | null, presets: PromptPreset[]): Promise<{ success: boolean }> {
    const date = new Date().toISOString().slice(0, 10);
    const options = {
        defaultPath: `modelforge-prompts-${date}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { success: false };

    fs.writeFileSync(result.filePath, JSON.stringify(presets, null, 2));
    return { success: true };
}

function looksLikePreset(value: unknown): value is Partial<PromptPreset> {
    return !!value && typeof value === "object" && typeof (value as { prompt?: unknown }).prompt === "string";
}

export async function importPromptPresets(win: BrowserWindow | null): Promise<PromptPreset[]> {
    const options = { properties: ["openFile" as const], filters: [{ name: "JSON", extensions: ["json"] }] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return [];

    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(result.filePaths[0], "utf-8"));
    } catch {
        return [];
    }

    const candidates: unknown[] = Array.isArray(raw) ? raw : [raw];
    const now = new Date().toISOString();
    const imported: PromptPreset[] = [];
    for (const candidate of candidates) {
        if (!looksLikePreset(candidate)) continue;
        imported.push({
            id: randomUUID(),
            name: typeof candidate.name === "string" && candidate.name ? candidate.name : "Imported prompt",
            prompt: candidate.prompt!,
            versions: [],
            createdAt: now,
            updatedAt: now,
        });
    }
    return imported;
}

export function getUserDataPath(): string {
    return app.getPath("userData");
}

export function openUserDataFolder(): void {
    shell.openPath(app.getPath("userData"));
}
