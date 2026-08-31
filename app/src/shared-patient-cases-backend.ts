import { getValidAccessToken, isAllowedRemoteUrl, isConnected } from "./shared-backend-auth";
import { getSharedBackendConfig, type SharedBackendConfig } from "./shared-backend-config-store";
import {
    SharedBackendUnavailableError,
    type PatientCase,
    type PatientCasesBackend,
} from "./patient-cases-store";
import { caseChangeFeedSchema, patientCaseSchema, type CaseChangeFeed } from "@modelforge/contracts";

// Real HTTP implementation of PatientCasesBackend against packages/server/'s
// patient-case API (packages/server/src/routes/cases.ts, per
// docs/SHARED_BACKEND_DESIGN.md §3) — the client-side counterpart to that
// server's authz-gated endpoints. Every call attaches the bearer token from
// shared-backend-auth.ts's getValidAccessToken(); the server, not this
// module, is what actually enforces who can do what (see routes/cases.ts's
// own doc comment on this file's server side) — this module's job is
// faithfully translating patient-cases-store.ts's backend contract into
// HTTP requests and their responses back into that same contract, nothing
// more.
//
// "No cases" and "couldn't reach the server" must never look the same to a
// clinician (see patient-cases-store.ts's SharedBackendUnavailableError doc
// comment) — every failure path here throws that error rather than
// returning an empty array or null.

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
    // See shared-backend-client.ts's identical check for why: baseUrl is
    // renderer-settable via sharedBackend:setConfig with no format
    // restriction of its own, and this is the point the live bearer token
    // — real clinical-data access — is about to be attached and sent.
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

async function readSince(cursor: string | null): Promise<{ cases: PatientCase[]; cursor: string; deletedIds?: string[] }> {
    const config = requireConfig();
    const query = cursor ? `?since=${encodeURIComponent(cursor)}` : "";
    const response = await authorizedRequest(`/organizations/${config.organizationId}/cases${query}`);
    if (!response.ok) throw new SharedBackendUnavailableError(`Shared backend returned an error listing cases: ${await parseErrorMessage(response)}`);
    const body: unknown = await response.json();
    const parsedFeed = caseChangeFeedSchema.safeParse(body);
    if (parsedFeed.success) {
        const feed: CaseChangeFeed = parsedFeed.data;
        return {
            cases: feed.cases ?? feed.changes.flatMap((change) => (change.kind === "upsert" ? [change.patientCase] : [])),
            cursor: feed.cursor,
            deletedIds: feed.deletedIds ?? feed.changes.flatMap((change) => (change.kind === "delete" ? [change.caseId] : [])),
        };
    }
    // One release of backwards compatibility for a server that still
    // emits the pre-change-feed {cases,cursor} shape.
    const legacy = body as { cases?: unknown[]; cursor?: unknown };
    if (Array.isArray(legacy.cases) && typeof legacy.cursor === "string") {
        const cases = legacy.cases.map((value) => patientCaseSchema.parse(value));
        return { cases, cursor: legacy.cursor };
    }
    throw new SharedBackendUnavailableError("Shared backend returned an invalid case change-feed contract.");
}

async function writeOne(
    patientCase: PatientCase,
    expectedVersion: string | null,
    idempotencyKey?: string
): Promise<{ patientCase: PatientCase; version: string } | { conflict: true; current: PatientCase }> {
    const config = requireConfig();
    const idempotencyHeaders: Record<string, string> = {};
    if (idempotencyKey) idempotencyHeaders["Idempotency-Key"] = idempotencyKey;
    const response =
        expectedVersion === null
            ? await authorizedRequest(`/organizations/${config.organizationId}/cases`, {
                  method: "POST",
                  headers: idempotencyHeaders,
                  body: JSON.stringify(patientCase),
              })
            : await authorizedRequest(`/organizations/${config.organizationId}/cases/${patientCase.id}`, {
                  method: "PUT",
                  headers: { "If-Match": expectedVersion, ...idempotencyHeaders },
                  body: JSON.stringify(patientCase),
              });

    if (response.status === 409 || response.status === 412) {
        const body = (await response.json()) as { current: PatientCase };
        return { conflict: true, current: body.current };
    }
    if (!response.ok) throw new SharedBackendUnavailableError(`Shared backend rejected the write: ${await parseErrorMessage(response)}`);

    const saved = (await response.json()) as PatientCase;
    return { patientCase: saved, version: saved.version! };
}

async function deleteOne(
    id: string,
    expectedVersion: string | null,
    idempotencyKey?: string
): Promise<{ deleted: true } | { conflict: true; current: PatientCase }> {
    const config = requireConfig();
    const headers: Record<string, string> = {};
    if (expectedVersion !== null) headers["If-Match"] = expectedVersion;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await authorizedRequest(`/organizations/${config.organizationId}/cases/${id}`, { method: "DELETE", headers });

    if (response.status === 412) {
        const body = (await response.json()) as { current: PatientCase };
        return { conflict: true, current: body.current };
    }
    // A 404 here means the case is already gone server-side — deleting
    // something that's already deleted is idempotent success from this
    // interface's point of view, not a conflict or an error the caller
    // needs to react to differently than a normal delete.
    if (response.status === 404) return { deleted: true };
    if (!response.ok) throw new SharedBackendUnavailableError(`Shared backend rejected the delete: ${await parseErrorMessage(response)}`);
    return { deleted: true };
}

export function createSharedPatientCasesBackend(): PatientCasesBackend {
    return {
        name: "modelforge-shared-http",
        label: "Shared (institutional backend)",
        scope: "shared",
        limitations:
            "Requires connecting to your institution's shared backend and selecting an organization in Settings → " +
            "Audit & Privacy first (enterprise mode). Every read/write is authorized server-side per the connected " +
            "account's policies — a denied action surfaces as an error, not a silently empty result. Case-level " +
            "at-rest encryption is the server's responsibility, not this client's — see " +
            "docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §7 for the current server-managed-keys posture and its " +
            "trade-offs versus this app's local, device-tied encryption.",

        isAvailable: () => {
            const config = getSharedBackendConfig();
            return isConnected() && config !== null && !!config.organizationId;
        },

        // Required baseline — not the primary path. patient-cases-store.ts
        // prefers readSince/writeOne/deleteOne (all implemented below)
        // whenever a backend provides them, so these two only run if some
        // future caller bypasses that preference. readAll delegates to
        // readSince(null) directly; writeAll performs a best-effort
        // sequential writeOne per case (there is no real bulk-write
        // endpoint — docs/SHARED_BACKEND_DESIGN.md §3 deliberately treats
        // bulk writeAll as "the wrong contract for a shared backend").
        readAll: async () => (await readSince(null)).cases,
        writeAll: async (cases: PatientCase[]) => {
            for (const patientCase of cases) {
                const result = await writeOne(patientCase, patientCase.version ?? null);
                if ("conflict" in result) {
                    throw new SharedBackendUnavailableError(
                        `writeAll: case ${patientCase.id} conflicted with the server's current version — this bulk path does not resolve conflicts; use writeOne per case instead.`
                    );
                }
            }
        },

        readSince,
        writeOne,
        deleteOne,
    };
}
