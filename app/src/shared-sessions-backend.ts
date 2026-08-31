import { getValidAccessToken, isAllowedRemoteUrl, isConnected } from "./shared-backend-auth";
import { getSharedBackendConfig, type SharedBackendConfig } from "./shared-backend-config-store";
import { SharedBackendUnavailableError, type ChatSession, type SessionsBackend } from "./sessions-store";
import { sessionChangeFeedSchema, sharedChatSessionSchema, type SessionChangeFeed, type SharedChatSession } from "@modelforge/contracts";

// Real HTTP implementation of SessionsBackend against server/src/routes/
// sessions.ts (P1 item 7) — the client-side counterpart to that server's
// authz-gated endpoints. Structurally identical to
// shared-patient-cases-backend.ts; see that file's own doc comment for the
// shared rationale (this module's job is faithfully translating
// sessions-store.ts's backend contract into HTTP requests and back, nothing
// more — the server is what actually enforces who can do what).
//
// The one real difference from cases: ChatSession carries local-only,
// device-specific fields — `params`, `agentWorkspace`, `projectId` (see
// that interface's own doc comments), and `agentMode` (not part of "what
// syncs" per P1 item 7's plan — agent-mode is a per-device run setting,
// same category as params) — that must never reach the server;
// sharedChatSessionSchema is `.strict()` and would reject them outright.
// This module strips them before every write and restores them afterward
// from `localOnlyFieldsCache` below, a private in-memory map keyed by
// session id: the only way those fields could already be known here is
// that *this device, this process* set them on a prior write, since the
// server never sends them back. A session this device has never written
// simply has them unset, same as a brand-new local session would.

type LocalOnlyFields = Pick<ChatSession, "params" | "agentWorkspace" | "projectId" | "agentMode">;
const LOCAL_ONLY_KEYS = ["params", "agentWorkspace", "projectId", "agentMode"] as const;

const localOnlyFieldsCache = new Map<string, LocalOnlyFields>();

function rememberLocalOnlyFields(session: ChatSession): void {
    if (LOCAL_ONLY_KEYS.some((key) => session[key] !== undefined)) {
        localOnlyFieldsCache.set(session.id, {
            params: session.params,
            agentWorkspace: session.agentWorkspace,
            projectId: session.projectId,
            agentMode: session.agentMode,
        });
    }
}

function withLocalOnlyFields(session: SharedChatSession): ChatSession {
    const remembered = localOnlyFieldsCache.get(session.id);
    return { ...session, ...remembered };
}

function stripLocalOnlyFields(session: ChatSession): SharedChatSession {
    // Destructuring the local-only keys off (rather than an allowlist copy)
    // means adding a field to the shared schema later doesn't silently
    // start dropping it here too.
    const { params: _params, agentWorkspace: _agentWorkspace, projectId: _projectId, agentMode: _agentMode, ...shared } = session;
    void _params;
    void _agentWorkspace;
    void _projectId;
    void _agentMode;
    return sharedChatSessionSchema.parse(shared);
}

function requireConfig(): SharedBackendConfig & { organizationId: string } {
    const config = getSharedBackendConfig();
    if (!config) throw new SharedBackendUnavailableError("No shared backend is configured — set one up in Settings first.");
    if (!config.organizationId) {
        throw new SharedBackendUnavailableError("No organization selected for the shared backend yet — connect and pick one in Settings.");
    }
    return config as SharedBackendConfig & { organizationId: string };
}

async function authorizedRequest(path: string, init?: RequestInit): Promise<Response> {
    const config = requireConfig();
    if (!isAllowedRemoteUrl(config.baseUrl)) {
        throw new SharedBackendUnavailableError(
            "The configured shared backend URL is not a trusted HTTPS endpoint (or an explicit loopback development address) — refusing to send credentials to it."
        );
    }
    const token = await getValidAccessToken();
    if (!token) throw new SharedBackendUnavailableError("Not connected to the shared backend — connect in Settings first.");

    try {
        return await fetch(`${config.baseUrl}${path}`, {
            ...init,
            headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
    } catch (err) {
        throw new SharedBackendUnavailableError(`Could not reach the shared backend: ${(err as Error).message}`);
    }
}

async function parseErrorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { message?: string; error?: string };
        return body.message ?? body.error ?? `HTTP ${response.status}`;
    } catch {
        return `HTTP ${response.status}`;
    }
}

async function readSince(cursor: string | null): Promise<{ sessions: ChatSession[]; cursor: string; deletedIds?: string[] }> {
    const config = requireConfig();
    const query = cursor ? `?since=${encodeURIComponent(cursor)}` : "";
    const response = await authorizedRequest(`/organizations/${config.organizationId}/sessions${query}`);
    if (!response.ok) throw new SharedBackendUnavailableError(`Shared backend returned an error listing sessions: ${await parseErrorMessage(response)}`);
    const body: unknown = await response.json();
    const feed: SessionChangeFeed = sessionChangeFeedSchema.parse(body);
    return {
        sessions: feed.changes.flatMap((change) => (change.kind === "upsert" ? [withLocalOnlyFields(change.session)] : [])),
        cursor: feed.cursor,
        deletedIds: feed.changes.flatMap((change) => (change.kind === "delete" ? [change.sessionId] : [])),
    };
}

async function writeOne(
    session: ChatSession,
    expectedVersion: string | null,
    idempotencyKey?: string
): Promise<{ session: ChatSession; version: string } | { conflict: true; current: ChatSession }> {
    const config = requireConfig();
    const payload = stripLocalOnlyFields(session);
    const idempotencyHeaders: Record<string, string> = {};
    if (idempotencyKey) idempotencyHeaders["Idempotency-Key"] = idempotencyKey;
    const response =
        expectedVersion === null
            ? await authorizedRequest(`/organizations/${config.organizationId}/sessions`, {
                  method: "POST",
                  headers: idempotencyHeaders,
                  body: JSON.stringify(payload),
              })
            : await authorizedRequest(`/organizations/${config.organizationId}/sessions/${session.id}`, {
                  method: "PUT",
                  headers: { "If-Match": expectedVersion, ...idempotencyHeaders },
                  body: JSON.stringify(payload),
              });

    if (response.status === 409 || response.status === 412) {
        const body = (await response.json()) as { current: SharedChatSession };
        return { conflict: true, current: withLocalOnlyFields(body.current) };
    }
    if (!response.ok) throw new SharedBackendUnavailableError(`Shared backend rejected the write: ${await parseErrorMessage(response)}`);

    rememberLocalOnlyFields(session);
    const saved = sharedChatSessionSchema.parse(await response.json());
    return { session: withLocalOnlyFields(saved), version: saved.version! };
}

async function deleteOne(
    id: string,
    expectedVersion: string | null,
    idempotencyKey?: string
): Promise<{ deleted: true } | { conflict: true; current: ChatSession }> {
    const config = requireConfig();
    const headers: Record<string, string> = {};
    if (expectedVersion !== null) headers["If-Match"] = expectedVersion;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await authorizedRequest(`/organizations/${config.organizationId}/sessions/${id}`, { method: "DELETE", headers });

    if (response.status === 412) {
        const body = (await response.json()) as { current: SharedChatSession };
        return { conflict: true, current: withLocalOnlyFields(body.current) };
    }
    // A 404 here means the session is already gone server-side — same
    // idempotent-delete contract as shared-patient-cases-backend.ts's
    // deleteOne.
    if (response.status === 404) {
        localOnlyFieldsCache.delete(id);
        return { deleted: true };
    }
    if (!response.ok) throw new SharedBackendUnavailableError(`Shared backend rejected the delete: ${await parseErrorMessage(response)}`);
    localOnlyFieldsCache.delete(id);
    return { deleted: true };
}

export function createSharedSessionsBackend(): SessionsBackend {
    return {
        name: "modelforge-shared-http",
        label: "Shared (institutional backend)",
        scope: "shared",
        limitations:
            "Requires connecting to your institution's shared backend and selecting an organization in Settings → " +
            "Audit & Privacy first (enterprise mode). A session is visible to its owner and anyone explicitly " +
            "added to it via Share — never automatically to the whole organization. Device/hardware-specific " +
            "settings (GPU layers, thread count) and local project folders never leave this device.",

        isAvailable: () => {
            const config = getSharedBackendConfig();
            return isConnected() && config !== null && !!config.organizationId;
        },

        // Required baseline — sessions-store.ts prefers readSince/writeOne/
        // deleteOne (all implemented below) whenever a backend provides
        // them, so these two only run if some future caller bypasses that
        // preference — see shared-patient-cases-backend.ts's identical
        // readAll/writeAll for why writeAll's per-session loop is the right
        // contract for a shared backend (there is no real bulk-write
        // endpoint).
        readAll: async () => (await readSince(null)).sessions,
        writeAll: async (sessions: ChatSession[]) => {
            for (const session of sessions) {
                const result = await writeOne(session, session.version ?? null);
                if ("conflict" in result) {
                    throw new SharedBackendUnavailableError(
                        `writeAll: session ${session.id} conflicted with the server's current version — this bulk path does not resolve conflicts; use writeOne per session instead.`
                    );
                }
            }
        },

        readSince,
        writeOne,
        deleteOne,
    };
}
