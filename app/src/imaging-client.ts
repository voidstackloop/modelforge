import type { ImagingIngestionJob, ImagingShareGrant, ImagingStudy, ViewerSession } from "@modelforge/contracts";
import { authorizedRequest, SharedBackendClientError } from "./shared-backend-client";
import { getSharedBackendConfig } from "./shared-backend-config-store";

export interface ImagingStudyDetail {
    study: ImagingStudy;
    series: Array<{ id: string; modality: string; numberOfInstances: number; description?: string }>;
    instances: Array<Array<{ id: string; seriesId: string; sopInstanceUid: string; instanceNumber?: string; hasThumbnail: boolean }>>;
}

export interface CreateImagingShareInput {
    mode: "internal" | "cross-organization" | "external-portal";
    recipientUserId?: string;
    recipientOrganizationId?: string;
    recipientEmail?: string;
    recipientName?: string;
    purposeOfUse: string;
    message?: string;
    expiresInHours: number;
    consentBasis: string;
}

function organizationId(): string {
    const id = getSharedBackendConfig()?.organizationId;
    if (!id) throw new SharedBackendClientError("Select a shared-backend organization before using imaging.");
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

export async function listImagingStudies(caseId: string): Promise<ImagingStudy[]> {
    const org = organizationId();
    return expectJson(await authorizedRequest(`/organizations/${encodeURIComponent(org)}/imaging/studies?caseId=${encodeURIComponent(caseId)}`), "Listing imaging studies");
}

export async function getImagingStudy(studyId: string): Promise<ImagingStudyDetail> {
    const org = organizationId();
    return expectJson(await authorizedRequest(`/organizations/${encodeURIComponent(org)}/imaging/studies/${encodeURIComponent(studyId)}`), "Loading imaging study");
}

export async function listImagingActivity(): Promise<ImagingIngestionJob[]> {
    const org = organizationId();
    return expectJson(await authorizedRequest(`/organizations/${encodeURIComponent(org)}/imaging/ingestion`), "Loading imaging activity");
}

export async function uploadDicom(caseId: string, fileName: string, bytes: Uint8Array): Promise<{ job: ImagingIngestionJob; studyId?: string; requiresReview: boolean }> {
    if (bytes.byteLength === 0) throw new SharedBackendClientError("The selected DICOM file is empty.");
    const org = organizationId();
    const query = new URLSearchParams({ fileName, expectedCaseId: caseId });
    return expectJson(
        await authorizedRequest(`/organizations/${encodeURIComponent(org)}/imaging/ingestion?${query.toString()}`, {
            method: "POST",
            headers: { "Content-Type": "application/dicom" },
            body: Buffer.from(bytes),
        }),
        `Uploading ${fileName}`
    );
}

/** Resolves an ingestion job the server held as
 * "review-required"/"ambiguous-patient-match" — the DICOM file's own
 * PatientID matched more than one case, so a human has to say which case it
 * belongs to (or reject it). See docs/IMAGING.md's patient-matching section
 * for why this is never resolved automatically. */
export async function resolveImagingIngestionJob(
    jobId: string,
    decision: "attach" | "reject",
    caseId?: string
): Promise<{ job: ImagingIngestionJob; studyId?: string; requiresReview: boolean }> {
    const org = organizationId();
    return expectJson(
        await authorizedRequest(`/organizations/${encodeURIComponent(org)}/imaging/ingestion/${encodeURIComponent(jobId)}/resolve`, {
            method: "POST",
            body: JSON.stringify(decision === "attach" ? { decision, caseId } : { decision }),
        }),
        "Resolving imaging ingestion job"
    );
}

export async function listImagingShares(studyId: string): Promise<ImagingShareGrant[]> {
    const org = organizationId();
    return expectJson(await authorizedRequest(`/organizations/${encodeURIComponent(org)}/imaging/studies/${encodeURIComponent(studyId)}/shares`), "Loading imaging shares");
}

export async function createImagingShare(studyId: string, input: CreateImagingShareInput): Promise<{ grant: ImagingShareGrant; external?: { accessToken: string; verificationCode: string } }> {
    const org = organizationId();
    return expectJson(
        await authorizedRequest(`/organizations/${encodeURIComponent(org)}/imaging/studies/${encodeURIComponent(studyId)}/shares`, {
            method: "POST",
            body: JSON.stringify({ ...input, scope: "study", allowDownload: false }),
        }),
        "Creating imaging share"
    );
}

export async function createViewerSession(studyId: string): Promise<{ session: ViewerSession; token: string; dicomwebBaseUrl: string; studyInstanceUid: string }> {
    const config = getSharedBackendConfig();
    const org = organizationId();
    const result = await expectJson<{ session: ViewerSession; token: string }>(
        await authorizedRequest(`/organizations/${encodeURIComponent(org)}/imaging/studies/${encodeURIComponent(studyId)}/viewer-sessions`, {
            method: "POST",
            body: JSON.stringify({ grantedActions: ["view", "measure"] }),
        }),
        "Creating viewer session"
    );
    const detail = await getImagingStudy(studyId);
    return {
        ...result,
        studyInstanceUid: detail.study.studyInstanceUid,
        dicomwebBaseUrl: `${config!.baseUrl}/organizations/${encodeURIComponent(org)}/imaging/dicomweb`,
    };
}
