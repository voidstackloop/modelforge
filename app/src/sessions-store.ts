import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type { ChatMessage, ChatOptions } from "./providers/types";

export type { ChatMessage };

export interface ChatSession {
    id: string;
    title: string;
    model: string | null;
    messages: ChatMessage[];
    params?: ChatOptions | null;
    projectId?: string | null;
    systemPrompt?: string | null;
    createdAt: string;
    updatedAt: string;
}

function filePath(): string {
    return path.join(app.getPath("userData"), "sessions.json");
}

function readAll(): ChatSession[] {
    try {
        return JSON.parse(fs.readFileSync(filePath(), "utf-8"));
    } catch {
        return [];
    }
}

function writeAll(sessions: ChatSession[]): void {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(sessions, null, 2));
}

export function listSessions(): ChatSession[] {
    return readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getSession(id: string): ChatSession | null {
    return readAll().find((s) => s.id === id) ?? null;
}

export function createSession(model: string | null, projectId: string | null = null): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = {
        id: randomUUID(),
        title: "New chat",
        model,
        messages: [],
        projectId,
        createdAt: now,
        updatedAt: now,
    };
    const all = readAll();
    all.push(session);
    writeAll(all);
    return session;
}

export function updateSession(
    id: string,
    partial: Partial<Pick<ChatSession, "title" | "model" | "messages" | "params" | "projectId" | "systemPrompt">>
): ChatSession | null {
    const all = readAll();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...partial, updatedAt: new Date().toISOString() };
    writeAll(all);
    return all[idx];
}

export function deleteSession(id: string): void {
    writeAll(readAll().filter((s) => s.id !== id));
}

export function addSession(session: ChatSession): void {
    const all = readAll();
    all.push(session);
    writeAll(all);
}

export function clearAll(): void {
    writeAll([]);
}

export function unassignProject(projectId: string): void {
    const all = readAll();
    let changed = false;
    for (const s of all) {
        if (s.projectId === projectId) {
            s.projectId = null;
            changed = true;
        }
    }
    if (changed) writeAll(all);
}
