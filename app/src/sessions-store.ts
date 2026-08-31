import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";
import * as caseEncryption from "./case-encryption";
import { CaseDataLockedError } from "./case-encryption";
import { SharedBackendUnavailableError } from "./patient-cases-store";
import type { EncryptedPayload } from "./case-encryption";
import type { ChatMessage, ChatOptions } from "./providers/types";

export { CaseDataLockedError, SharedBackendUnavailableError };

export type { ChatMessage };

export interface ChatSession {
    id: string;
    title: string;
    model: string | null;
    messages: ChatMessage[];
    params?: ChatOptions | null;
    projectId?: string | null;
    systemPrompt?: string | null;
    // Local-only, like params/agentWorkspace/projectId below — a per-device
    // run setting, not part of sharedChatSessionSchema. See
    // shared-sessions-backend.ts's doc comment.
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
    // Owner + explicitly-assigned teammates — shared-backend concept only
    // (see shared-sessions-backend.ts and packages/contracts's
    // sharedChatSessionSchema). Unset for a session that has never been
    // shared; the local backend ignores this field entirely.
    assignedUserIds?: string[] | null;
    // Optimistic-concurrency token from a shared backend — unset for a
    // session that has never been synced. Mirrors PatientCase.version.
    version?: string;
    createdAt: string;
    updatedAt: string;
}

// Thrown by SessionsBackend.writeOne/deleteOne (via updateSession/
// deleteSession below) when expectedVersion no longer matches the backend's
// current copy — mirrors patient-cases-store.ts's CaseWriteConflictError
// exactly, including the "never auto-resolved" rule; see that class's doc
// comment for the full rationale, which applies identically here.
export class SessionWriteConflictError extends Error {
    constructor(public readonly current: ChatSession) {
        super("This chat was updated elsewhere since it was loaded — reload before saving again.");
        this.name = "SessionWriteConflictError";
    }
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

// In-process read cache. This store is the sole writer of sessions.json/
// .enc.json (every write, including the migration paths in
// encryption-handlers.ts, goes through writeAllSync below), so the cache can
// never drift from disk within a running process — every write refreshes it
// to the exact array just persisted.
//
// This matters because a single agent-mode chat turn can call
// sessionsStore.update() once per tool-call round-trip (Chat.tsx's
// runCompletion → continueAfterTools loop), each followed by a sidebar
// refresh() that calls sessions.list() again — without this cache, every one
// of those was a full synchronous read-and-decrypt of every stored session's
// entire message history, just to persist or list one session, growing
// without bound as a user's history accumulates over time.
//
// Every write here is still synchronous and immediate (an earlier version
// of this cache debounced updateSession's disk write to coalesce several
// updates into one — reverted: this is clinical data, and no amount of
// coalescing is worth widening the crash/power-loss window during which an
// update exists only in memory). The cache only removes redundant *reads*;
// it never defers a write.
let cache: ChatSession[] | null = null;

/** Drops the cached array without touching disk. Called automatically via
 * caseEncryption.onBeforeLock (registered below) — see that hook for why a
 * decrypted array must not survive past the passphrase being "forgotten."
 * Safe to call at any other time too; the next read just repopulates it. */
export function clearCache(): void {
    cache = null;
}

// Renamed from readAll/writeAll (this file's pre-P1-item-7 names) to make
// room for the backend-routed async functions below, which now own those
// names. These stay synchronous and are used directly — bypassing whichever
// backend is active — by the handful of operations that only ever make
// sense against *this device's own file*: the encryption-mode migration
// pair (getAllSessionsForMigration/overwriteAllSessions, mirroring
// patient-cases-store.ts's identical pair), clearAll (a destructive local
// wipe — see its own doc comment for why this must never be routed through
// a shared backend), and unassignProject (projectId has no server
// representation at all — see ChatSession's own doc comment on projectId).
function readAllSync(): ChatSession[] {
    if (caseEncryption.isEnabled() && !caseEncryption.isUnlocked()) throw new CaseDataLockedError();
    if (cache !== null) return cache;

    if (caseEncryption.isEnabled()) {
        const payload = readJson<EncryptedPayload | null>(encryptedFilePath(), null);
        cache = payload ? (JSON.parse(caseEncryption.decrypt(payload, caseEncryption.getSessionKey()!)) as ChatSession[]) : [];
    } else {
        cache = readJson<ChatSession[]>(filePath(), []);
    }
    return cache;
}

function writeAllSync(sessions: ChatSession[]): void {
    if (caseEncryption.isEnabled()) {
        if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
        const payload = caseEncryption.encrypt(JSON.stringify(sessions), caseEncryption.getSessionKey()!);
        writeJson(encryptedFilePath(), payload);
        removeIfExists(filePath());
    } else {
        writeJson(filePath(), sessions);
        removeIfExists(encryptedFilePath());
    }
    cache = sessions;
}

// Structural guarantee (see case-encryption.ts's onBeforeLock doc comment):
// runs before the key clears no matter who calls lock() — the
// encryption:lock IPC handler, a test calling it directly, or any future
// caller — rather than relying on every call site remembering to clear the
// cache.
caseEncryption.onBeforeLock(() => clearCache());

/** Same migration-flow pair as patient-cases-store.ts's
 * getAllCasesForMigration/overwriteAllCases — used by encryption-handlers.ts
 * to move session data between plaintext and encrypted storage in lockstep
 * with patient cases. Always the local file, regardless of which
 * SessionsBackend is active — same reasoning as that pair: at-rest
 * encryption is a local-storage-specific concern a shared backend handles
 * its own way. */
export function getAllSessionsForMigration(): ChatSession[] {
    return readAllSync();
}

export function overwriteAllSessions(sessions: ChatSession[]): void {
    writeAllSync(sessions);
}

/** Wipes this device's local session file. Deliberately never routed
 * through the active backend: on a shared backend, "clear all" cannot mean
 * "delete every teammate's session history" without a much more explicit,
 * separately-confirmed design (out of scope here — see P1 item 7's plan) —
 * so while a shared backend is active, this clears only this device's
 * (currently-inert, since reads/writes go to the network) local cache, not
 * anything visible to the user. Disclosed limitation, not a silent gap. */
export function clearAll(): void {
    writeAllSync([]);
}

/** projectId is a local-only, device-only chat-organization concept with no
 * server representation (see ChatSession's own doc comment) — there is
 * nothing to route to a shared backend here under any circumstance. */
export function unassignProject(projectId: string): void {
    const all = readAllSync();
    let changed = false;
    for (const s of all) {
        if (s.projectId === projectId) {
            s.projectId = null;
            changed = true;
        }
    }
    if (changed) writeAllSync(all);
}

// --- Persistence backend seam (mirrors patient-cases-store.ts exactly) -----
//
// Same rationale as PatientCasesBackend: this app is single-user,
// local-first by default (localSessionsBackend below, wrapping
// readAllSync/writeAllSync, is the only backend registered by default). The
// interface exists as a documented plug point for a shared backend — see
// shared-sessions-backend.ts, built against this exact interface, and
// routes/sessions.ts on the server side.
export type SessionsBackendScope = "local" | "shared";

export interface SessionsBackend {
    readonly name: string;
    readonly label: string;
    readonly scope: SessionsBackendScope;
    readonly limitations: string;
    isAvailable?(): boolean;
    readAll(): Promise<ChatSession[]>;
    writeAll(sessions: ChatSession[]): Promise<void>;
    /** Incremental sync — see PatientCasesBackend.readSince's identical doc
     * comment; the same contract applies here. */
    readSince?(cursor: string | null): Promise<{ sessions: ChatSession[]; cursor: string; deletedIds?: string[] }>;
    /** Single-session write with optimistic concurrency — see
     * PatientCasesBackend.writeOne's identical doc comment (including the
     * idempotencyKey contract, used by a future offline-outbox extension;
     * this slice does not wrap sessions with case-offline-cache.ts's
     * wrapper — see P1 item 7's plan for that disclosed gap). */
    writeOne?(
        session: ChatSession,
        expectedVersion: string | null,
        idempotencyKey?: string
    ): Promise<{ session: ChatSession; version: string } | { conflict: true; current: ChatSession }>;
    /** Single-session delete with optimistic concurrency — mirrors
     * PatientCasesBackend.deleteOne exactly, including its idempotent-404
     * contract. */
    deleteOne?(id: string, expectedVersion: string | null, idempotencyKey?: string): Promise<{ deleted: true } | { conflict: true; current: ChatSession }>;
}

export const localSessionsBackend: SessionsBackend = {
    name: "modelforge-local-json",
    label: "Local (this device)",
    scope: "local",
    limitations:
        "Stores chat sessions in a local file on this device only (optionally encrypted at rest via Settings → " +
        "Audit & Privacy) — not shared with any other device or user. A shared backend for a care team can be " +
        "registered behind this same interface.",
    readAll: async () => readAllSync(),
    writeAll: async (sessions) => writeAllSync(sessions),
};

const sessionsBackendRegistry = new Map<string, SessionsBackend>([[localSessionsBackend.name, localSessionsBackend]]);
let activeSessionsBackend: SessionsBackend = localSessionsBackend;

/** Adds (or replaces) a backend in the registry, keyed by its `name`. Registering alone never changes which backend is active — see `selectSessionsBackend`. */
export function registerSessionsBackend(backend: SessionsBackend): void {
    sessionsBackendRegistry.set(backend.name, backend);
}

function isSessionsBackendAvailable(backend: SessionsBackend): boolean {
    try {
        return backend.isAvailable?.() ?? true;
    } catch {
        return false;
    }
}

/** Every currently-registered backend's public identity and current usability — what a Settings UI lists to choose from. */
export function listSessionsBackends(): { name: string; label: string; scope: SessionsBackendScope; available: boolean }[] {
    return [...sessionsBackendRegistry.values()].map((backend) => ({
        name: backend.name,
        label: backend.label,
        scope: backend.scope,
        available: isSessionsBackendAvailable(backend),
    }));
}

export function getSessionsBackend(): SessionsBackend {
    return activeSessionsBackend;
}

/** Makes the named registered backend active — see
 * selectPatientCasesBackend's identical doc comment for the fail-safe
 * contract (an unregistered name leaves the current backend untouched and
 * returns false, rather than throwing). */
export function selectSessionsBackend(name: string): boolean {
    const backend = sessionsBackendRegistry.get(name);
    if (!backend || !isSessionsBackendAvailable(backend)) return false;
    activeSessionsBackend = backend;
    return true;
}

// Full-read helper mirroring patient-cases-store.ts's readAllCases exactly,
// including its incremental-sync caching strategy — see that function's
// doc comment for the full rationale.
const sharedSyncState = new WeakMap<SessionsBackend, { cursor: string | null; sessions: Map<string, ChatSession> }>();

async function readAllSessions(backend: SessionsBackend): Promise<ChatSession[]> {
    if (backend.readSince && backend.scope === "shared") {
        let state = sharedSyncState.get(backend);
        if (!state) {
            state = { cursor: null, sessions: new Map() };
            sharedSyncState.set(backend, state);
        }
        const batch = await backend.readSince(state.cursor);
        for (const id of batch.deletedIds ?? []) state.sessions.delete(id);
        for (const session of batch.sessions) state.sessions.set(session.id, session);
        state.cursor = batch.cursor;
        return [...state.sessions.values()];
    }
    if (backend.readSince) return (await backend.readSince(null)).sessions;
    return backend.readAll();
}

export async function listSessions(): Promise<ChatSession[]> {
    return (await readAllSessions(getSessionsBackend())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getSession(id: string): Promise<ChatSession | null> {
    return (await readAllSessions(getSessionsBackend())).find((s) => s.id === id) ?? null;
}

/** Applies `mutate` to the session with `id` and persists the result —
 * mirrors patient-cases-store.ts's mutateCase exactly, including the
 * expectedVersion fallback contract described there. */
async function mutateSession(
    id: string,
    expectedVersion: string | null | undefined,
    mutate: (current: ChatSession) => ChatSession
): Promise<ChatSession | null> {
    const backend = getSessionsBackend();
    if (backend.writeOne) {
        const current = (await readAllSessions(backend)).find((s) => s.id === id);
        if (!current) return null;
        const versionToCheck = expectedVersion !== undefined ? expectedVersion : (current.version ?? null);
        const result = await backend.writeOne(mutate(current), versionToCheck);
        if ("conflict" in result) throw new SessionWriteConflictError(result.current);
        return result.session;
    }
    const all = await backend.readAll();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    all[idx] = mutate(all[idx]);
    await backend.writeAll(all);
    return all[idx];
}

/** Writes a session that must not already exist on the active backend
 * (id fresh) — shared by createSession and addSession (the import flow),
 * which are otherwise identical "create" operations differing only in
 * whether the caller supplies the initial content or this function builds
 * defaults. Routed through the active backend (not the raw local file)
 * so an imported/created session is visible immediately regardless of
 * whether local or shared mode is active — see addSession's own doc
 * comment for why this matters specifically for imports. */
async function createOne(session: ChatSession): Promise<ChatSession> {
    const backend = getSessionsBackend();
    if (backend.writeOne) {
        const result = await backend.writeOne(session, null);
        if ("conflict" in result) throw new SessionWriteConflictError(result.current);
        return result.session;
    }
    const all = await backend.readAll();
    all.push(session);
    await backend.writeAll(all);
    return session;
}

export async function createSession(model: string | null, projectId: string | null = null): Promise<ChatSession> {
    const now = new Date().toISOString();
    return createOne({
        id: randomUUID(),
        title: "New chat",
        model,
        messages: [],
        projectId,
        createdAt: now,
        updatedAt: now,
    });
}

export async function updateSession(
    id: string,
    partial: Partial<
        Pick<
            ChatSession,
            | "title"
            | "model"
            | "messages"
            | "params"
            | "projectId"
            | "systemPrompt"
            | "agentMode"
            | "agentWorkspace"
            | "planSteps"
            | "contextSummary"
            | "contextSummaryThroughIndex"
            | "tags"
            | "assignedUserIds"
        >
    >
): Promise<ChatSession | null> {
    return mutateSession(id, undefined, (current) => ({ ...current, ...partial, updatedAt: new Date().toISOString() }));
}

export async function deleteSession(id: string): Promise<void> {
    const backend = getSessionsBackend();
    if (backend.deleteOne) {
        const current = (await readAllSessions(backend)).find((s) => s.id === id);
        if (!current) return;
        const result = await backend.deleteOne(id, current.version ?? null);
        if ("conflict" in result) throw new SessionWriteConflictError(result.current);
        return;
    }
    await backend.writeAll((await backend.readAll()).filter((s) => s.id !== id));
}

/** Used by data-transfer.ts's importSessions — routed through the active
 * backend (not the raw local file) so an imported session appears in
 * listSessions() immediately even when a shared backend is active; a local-
 * file-only write here would make an imported session vanish from view the
 * instant shared mode is on, since reads would no longer look at that file
 * at all. */
export async function addSession(session: ChatSession): Promise<ChatSession> {
    return createOne(session);
}
