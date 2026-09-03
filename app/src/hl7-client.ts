import { hl7IngestionJobSchema, type Hl7IngestionJob } from "@modelforge/contracts";
import { z } from "zod";
import { authorizedRequest, SharedBackendClientError } from "./shared-backend-client";
import { getSharedBackendConfig } from "./shared-backend-config-store";

// REST glue for server/src/routes/hl7.ts's inbound-ingestion review queue —
// GET .../inbound/jobs and POST .../inbound/jobs/:jobId/resolve. Outbound
// ORU^R01 generation and the raw /parse endpoint have no UI need yet (no
// clinician-facing use for either) so aren't wired here.

export type Hl7ResolveDecision = { action: "apply"; caseId: string } | { action: "reject"; reason: string };

function organizationId(): string {
    const id = getSharedBackendConfig()?.organizationId;
    if (!id) throw new SharedBackendClientError("Select a shared-backend organization before using HL7 ingestion review.");
    return id;
}

async function expectJson<T>(response: Response, action: string): Promise<T> {
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const body = (await response.json()) as { message?: string; error?: string };
            detail = body.message ?? body.error ?? detail;
        } catch { /* response was not JSON */ }
        throw new SharedBackendClientError(`${action} failed: ${detail}`);
    }
    return response.json() as Promise<T>;
}

export async function listHl7IngestionJobs(status?: Hl7IngestionJob["status"]): Promise<Hl7IngestionJob[]> {
    const org = organizationId();
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const body = await expectJson<{ jobs: unknown[] }>(
        await authorizedRequest(`/organizations/${encodeURIComponent(org)}/hl7/v2/inbound/jobs${query}`),
        "Loading HL7 ingestion queue"
    );
    return z.array(hl7IngestionJobSchema).parse(body.jobs);
}

export async function resolveHl7IngestionJob(jobId: string, decision: Hl7ResolveDecision): Promise<Hl7IngestionJob> {
    const org = organizationId();
    return hl7IngestionJobSchema.parse(
        await expectJson(
            await authorizedRequest(`/organizations/${encodeURIComponent(org)}/hl7/v2/inbound/jobs/${encodeURIComponent(jobId)}/resolve`, { method: "POST", body: JSON.stringify(decision) }),
            "Resolving HL7 ingestion job"
        )
    );
}
