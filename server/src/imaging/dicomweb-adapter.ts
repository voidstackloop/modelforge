/**
 * DICOMweb adapter abstraction — STOW-RS (store), QIDO-RS (search), WADO-RS
 * (retrieve), plus metadata retrieval, streaming, and health checks. Two
 * implementations:
 *
 *  - LocalDicomwebAdapter: this server acts as its own DICOMweb endpoint
 *    against ImagingStore + ImagingObjectStore — the safe local-development
 *    adapter, and what a deployment with no institutional PACS/VNA uses in
 *    production too.
 *  - ProxyDicomwebAdapter: forwards to a real institutional PACS/VNA's own
 *    DICOMweb endpoints — the "prefer integration with an existing PACS/VNA
 *    through an adapter" path. **Not exercised against a real PACS in the
 *    environment this was built in** — no such server is reachable here.
 *    Implemented to the real interface and documented in docs/IMAGING.md;
 *    server/src/imaging/dicomweb-adapter.test.ts exercises
 *    LocalDicomwebAdapter instead, which is what's actually verified.
 *
 * Routes never talk to ImagingStore/ImagingObjectStore directly for
 * DICOMweb operations — always through this interface, so swapping in a
 * real PACS later touches this one file's second implementation, not
 * route handlers.
 */

import { randomUUID } from "node:crypto";
import type { ImagingObjectStore } from "./object-store.js";

const DICOM_CONTENT_TYPE = "application/dicom";
import type { TenantImagingRepository } from "../store/imaging-store.js";

export interface DicomwebStoreResult {
    studyInstanceUid: string;
    storedInstances: number;
    failedInstances: { sopInstanceUid?: string; reason: string }[];
}

export interface DicomwebSearchParams {
    patientId?: string;
    studyInstanceUid?: string;
    modality?: string;
    limit?: number;
}

export interface DicomwebAdapter {
    /** STOW-RS: stores already-validated instances. Ingestion.ts is the
     * only caller — validation/quarantine/patient-matching happens there,
     * before this is ever reached, so this layer's job is purely "persist
     * the bytes and metadata," not policy. */
    storeInstance(input: {
        studyId: string;
        seriesId: string;
        instanceBytes: Buffer;
        sopInstanceUid: string;
        sopClassUid: string;
        transferSyntaxUid: string;
    }): Promise<{ objectStorageKey: string; checksumSha256: string; sizeBytes: number }>;

    /** QIDO-RS: search — deliberately narrow (this server's own metadata
     * store, tenant-scoped by the TenantImagingRepository already bound to
     * the caller), not a general DICOM query/retrieve model. */
    searchStudies(repo: TenantImagingRepository, params: DicomwebSearchParams): Promise<unknown[]>;

    /** WADO-RS: retrieve a single instance's pixel data. */
    retrieveInstance(objectStorageKey: string): Promise<{ data: Buffer; contentType: string }>;

    /** WADO-RS metadata retrieval — DICOM JSON-shaped, per-instance. Kept
     * intentionally minimal (the fields ImagingInstance already carries)
     * rather than a full DICOM-JSON re-serialization of every tag, which
     * this server does not retain past ingestion (only extracted metadata
     * is kept — see docs/IMAGING.md's "what is NOT retained" note). */
    retrieveInstanceMetadata(objectStorageKey: string): Promise<Record<string, unknown>>;

    healthCheck(): Promise<boolean>;
    verifyConnectivity(): Promise<{ qido: boolean; stow: "not-run"; wado: "not-run"; error?: string }>;
}

/**
 * Object-storage key layout: tenant-prefixed, then study/series/instance —
 * matches this file's own "tenant-isolated imaging storage" requirement at
 * the naming level too (even though ImagingObjectStore's own tenant
 * isolation comes from the caller always prefixing with organizationId,
 * not from this function knowing about tenancy itself).
 *
 * **Every segment is a server-generated opaque id — no DICOM identifier
 * appears in an object key.** `organizationId`/`studyId`/`seriesId` are
 * already internal UUIDs; the leaf is a fresh UUID rather than the
 * SOPInstanceUID it replaced. That matters because object keys become URL
 * paths the moment a deployment puts CloudFront in front of the bucket
 * (imaging/content-delivery.ts), and CloudFront and S3 both write full
 * request paths to their access logs — a SOPInstanceUID there would be a
 * stable, patient-linkable identifier sitting in infrastructure logs
 * outside this application's own PHI-safe audit trail.
 *
 * Safe because the key is write-once: `storeInstance` returns it, the
 * caller persists it on the instance row (`objectStorageKey`), and every
 * later retrieval reads it back from there. Nothing re-derives a key from
 * DICOM values, so the leaf does not need to be a deterministic function of
 * anything.
 */
export function instanceObjectKey(organizationId: string, studyId: string, seriesId: string): string {
    return `${organizationId}/${studyId}/${seriesId}/${randomUUID()}.dcm`;
}

export class LocalDicomwebAdapter implements DicomwebAdapter {
    constructor(
        private readonly objectStore: ImagingObjectStore,
        private readonly organizationId: string
    ) {}

    async storeInstance(input: { studyId: string; seriesId: string; instanceBytes: Buffer; sopInstanceUid: string; sopClassUid: string; transferSyntaxUid: string }) {
        const key = instanceObjectKey(this.organizationId, input.studyId, input.seriesId);
        const { checksumSha256, sizeBytes } = await this.objectStore.put(key, input.instanceBytes, "application/dicom");
        return { objectStorageKey: key, checksumSha256, sizeBytes };
    }

    async searchStudies(repo: TenantImagingRepository, params: DicomwebSearchParams): Promise<unknown[]> {
        let studies = await repo.listStudies();
        if (params.studyInstanceUid) studies = studies.filter((s) => s.study.studyInstanceUid === params.studyInstanceUid);
        if (params.modality) studies = studies.filter((s) => s.study.modalities.includes(params.modality!));
        if (params.patientId) studies = studies.filter((s) => s.study.patientIdentifier.value === params.patientId);
        const limited = params.limit ? studies.slice(0, params.limit) : studies;
        return limited.map((s) => s.study);
    }

    async retrieveInstance(objectStorageKey: string) {
        const data = await this.objectStore.get(objectStorageKey);
        return { data, contentType: DICOM_CONTENT_TYPE };
    }

    async retrieveInstanceMetadata(objectStorageKey: string) {
        // Metadata retrieval doesn't need the (potentially large) pixel
        // bytes at all in this server's model — the caller already has the
        // ImagingInstance row; this exists to satisfy the WADO-RS metadata
        // endpoint shape for viewer/PACS-client compatibility.
        return { objectStorageKey };
    }

    async healthCheck() {
        return this.objectStore.healthCheck();
    }

    async verifyConnectivity() {
        const qido = await this.healthCheck();
        return { qido, stow: "not-run" as const, wado: "not-run" as const, ...(qido ? {} : { error: "Local imaging object store is unavailable." }) };
    }
}

/**
 * Forwards to a real PACS/VNA's DICOMweb endpoints. This server never
 * stores pixel data itself in this mode — retrieveInstance streams the
 * PACS's own response through, storeInstance forwards the STOW-RS POST.
 * Bearer/basic auth to the PACS is carried via `authHeader`, configured
 * per institution — see docs/IMAGING.md's PACS integration section for
 * what an operator needs to provide (base URL, auth, and confirming the
 * PACS's own DICOMweb conformance statement covers STOW/QIDO/WADO).
 */
export class ProxyDicomwebAdapter implements DicomwebAdapter {
    constructor(
        private readonly baseUrl: string,
        private readonly authHeader: string
    ) {}

    async storeInstance(input: { studyId: string; seriesId: string; instanceBytes: Buffer; sopInstanceUid: string; sopClassUid: string; transferSyntaxUid: string }) {
        const boundary = `----modelforge-stow-${Date.now()}`;
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`),
            input.instanceBytes,
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const response = await fetch(`${this.baseUrl}/studies`, {
            method: "POST",
            headers: { Authorization: this.authHeader, "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}` },
            body,
        });
        if (!response.ok) throw new Error(`PACS STOW-RS failed: HTTP ${response.status}`);
        const key = `pacs:${input.sopInstanceUid}`; // the PACS is the source of truth; this "key" only identifies which instance to ask for later
        return { objectStorageKey: key, checksumSha256: "", sizeBytes: input.instanceBytes.length };
    }

    async searchStudies(_repo: TenantImagingRepository, params: DicomwebSearchParams): Promise<unknown[]> {
        const query = new URLSearchParams();
        if (params.patientId) query.set("PatientID", params.patientId);
        if (params.studyInstanceUid) query.set("StudyInstanceUID", params.studyInstanceUid);
        if (params.modality) query.set("ModalitiesInStudy", params.modality);
        if (params.limit) query.set("limit", String(params.limit));
        const response = await fetch(`${this.baseUrl}/studies?${query.toString()}`, { headers: { Authorization: this.authHeader, Accept: "application/dicom+json" } });
        if (!response.ok) throw new Error(`PACS QIDO-RS failed: HTTP ${response.status}`);
        return (await response.json()) as unknown[];
    }

    async retrieveInstance(objectStorageKey: string) {
        const sopInstanceUid = objectStorageKey.replace(/^pacs:/, "");
        const response = await fetch(`${this.baseUrl}/instances/${sopInstanceUid}`, { headers: { Authorization: this.authHeader, Accept: "application/octet-stream" } });
        if (!response.ok) throw new Error(`PACS WADO-RS failed: HTTP ${response.status}`);
        return { data: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? DICOM_CONTENT_TYPE };
    }

    async retrieveInstanceMetadata(objectStorageKey: string) {
        const sopInstanceUid = objectStorageKey.replace(/^pacs:/, "");
        const response = await fetch(`${this.baseUrl}/instances/${sopInstanceUid}/metadata`, { headers: { Authorization: this.authHeader, Accept: "application/dicom+json" } });
        if (!response.ok) throw new Error(`PACS metadata retrieval failed: HTTP ${response.status}`);
        return (await response.json()) as Record<string, unknown>;
    }

    async healthCheck() {
        try {
            const response = await fetch(`${this.baseUrl}/studies?limit=1`, { headers: { Authorization: this.authHeader }, signal: AbortSignal.timeout(5_000) });
            return response.ok || response.status === 404;
        } catch {
            return false;
        }
    }

    async verifyConnectivity() {
        try {
            const response = await fetch(`${this.baseUrl}/studies?limit=1`, {
                headers: { Authorization: this.authHeader, Accept: "application/dicom+json" },
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) return { qido: false, stow: "not-run" as const, wado: "not-run" as const, error: `PACS QIDO-RS probe returned HTTP ${response.status}.` };
            await response.arrayBuffer();
            return { qido: true, stow: "not-run" as const, wado: "not-run" as const };
        } catch (error) {
            return { qido: false, stow: "not-run" as const, wado: "not-run" as const, error: error instanceof Error ? error.message : "unknown PACS verification failure" };
        }
    }
}
