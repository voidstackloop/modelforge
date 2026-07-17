import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { app, dialog, shell, BrowserWindow } from "electron";
import * as sessionsStore from "./sessions-store";
import type { ChatSession } from "./sessions-store";

function sanitizeFilename(name: string): string {
    return name.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 80) || "chat";
}

export async function exportSession(win: BrowserWindow | null, id: string): Promise<{ success: boolean }> {
    const session = sessionsStore.getSession(id);
    if (!session) return { success: false };

    const options = {
        defaultPath: `${sanitizeFilename(session.title)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { success: false };

    fs.writeFileSync(result.filePath, JSON.stringify(session, null, 2));
    return { success: true };
}

export async function exportAllSessions(win: BrowserWindow | null): Promise<{ success: boolean }> {
    const sessions = sessionsStore.listSessions();
    const date = new Date().toISOString().slice(0, 10);

    const options = {
        defaultPath: `modelforge-export-${date}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { success: false };

    fs.writeFileSync(result.filePath, JSON.stringify(sessions, null, 2));
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
        raw = JSON.parse(fs.readFileSync(result.filePaths[0], "utf-8"));
    } catch {
        return { imported: 0 };
    }

    const candidates: unknown[] = Array.isArray(raw) ? raw : [raw];
    let imported = 0;

    for (const candidate of candidates) {
        if (!looksLikeSession(candidate)) continue;
        const now = new Date().toISOString();
        sessionsStore.addSession({
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

export function getUserDataPath(): string {
    return app.getPath("userData");
}

export function openUserDataFolder(): void {
    shell.openPath(app.getPath("userData"));
}
