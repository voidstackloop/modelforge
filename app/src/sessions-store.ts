import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";
import * as caseEncryption from "./case-encryption";
import { CaseDataLockedError } from "./case-encryption";
import type { EncryptedPayload } from "./case-encryption";
import type { ChatMessage, ChatOptions } from "./providers/types";

export { CaseDataLockedError };

export type { ChatMessage };

export interface ChatSession {
    id: string;
    title: string;
    model: string | null;
    messages: ChatMessage[];
    params?: ChatOptions | null;
    projectId?: string | null;
    systemPrompt?: string | null;
    agentMode?: boolean;
    agentWorkspace?: string | null;
    // The agent's last set_plan checklist for this conversation, persisted so
    // reopening a chat mid-task shows where the plan stood.
    planSteps?: { text: string; done: boolean }[];
    // Running summary produced by context compaction, replacing everything
    // in `messages` before contextSummaryThroughIndex when this session's
    // history is sent to a provider.
    contextSummary?: string;
    contextSummaryThroughIndex?: number;
    tags?: string[];
    createdAt: string;
    updatedAt: string;
}

function filePath(): string {
    return path.join(app.getPath("userData"), "sessions.json");
}

// Shares patient-cases-store.ts's encryption gate exactly — one passphrase,
// one enable/disable toggle in Settings, protects both stores together. This
// is deliberate: chat sessions routinely carry the same clinical detail as a
// Patient Case (case context gets pasted or typed directly into a message),
// so a user enabling "case encryption" and believing their clinical data is
// now protected while sessions.json sat in plaintext next to it would be a
// real, dangerous gap — not a hypothetical one.
function encryptedFilePath(): string {
    return path.join(app.getPath("userData"), "sessions.enc.json");
}

function removeIfExists(target: string): void {
    try {
        fs.rmSync(target, { force: true });
    } catch {
        // Best effort — leftover stale file is a cleanliness issue, not a correctness one.
    }
}

function readAll(): ChatSession[] {
    if (caseEncryption.isEnabled()) {
        if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
        const payload = readJson<EncryptedPayload | null>(encryptedFilePath(), null);
        if (!payload) return [];
        return JSON.parse(caseEncryption.decrypt(payload, caseEncryption.getSessionKey()!)) as ChatSession[];
    }
    return readJson<ChatSession[]>(filePath(), []);
}

function writeAll(sessions: ChatSession[]): void {
    if (caseEncryption.isEnabled()) {
        if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
        const payload = caseEncryption.encrypt(JSON.stringify(sessions), caseEncryption.getSessionKey()!);
        writeJson(encryptedFilePath(), payload);
        removeIfExists(filePath());
    } else {
        writeJson(filePath(), sessions);
        removeIfExists(encryptedFilePath());
    }
}

/** Same migration-flow pair as patient-cases-store.ts's
 * getAllCasesForMigration/overwriteAllCases — used by encryption-handlers.ts
 * to move session data between plaintext and encrypted storage in lockstep
 * with patient cases. */
export function getAllSessionsForMigration(): ChatSession[] {
    return readAll();
}

export function overwriteAllSessions(sessions: ChatSession[]): void {
    writeAll(sessions);
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
    partial: Partial<
        Pick<
            ChatSession,
            "title" | "model" | "messages" | "params" | "projectId" | "systemPrompt" | "agentMode" | "agentWorkspace" | "planSteps" | "contextSummary" | "contextSummaryThroughIndex" | "tags"
        >
    >
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
