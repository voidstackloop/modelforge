import { describe, expect, it } from "vitest";
import dcmjs from "dcmjs";
import type { DeidentificationJob } from "@modelforge/contracts";
import { deidentifyStudy } from "./deidentification.js";
import { buildMinimalDicomFile } from "./test-fixtures.js";
import { sha256Hex, type ImagingObjectStore } from "./object-store.js";
import type { TenantImagingRepository } from "../store/imaging-store.js";

describe("deidentifyStudy", () => {
    it("creates a new metadata-scrubbed Part 10 derivative and requires review when pixel safety is unknown", async () => {
        const original = buildMinimalDicomFile({ patientId: "MRN-SECRET", issuerOfPatientId: "HOSPITAL-A", pixels: { rows: 2, columns: 2 } });
        const objects = new Map<string, Buffer>([["org/study/series/original.dcm", original]]);
        const objectStore: ImagingObjectStore = {
            async put(key, data) { objects.set(key, data); return { checksumSha256: sha256Hex(data), sizeBytes: data.length }; },
            async get(key) { const value = objects.get(key); if (!value) throw new Error("missing"); return value; },
            async exists(key) { return objects.has(key); },
            async delete(key) { objects.delete(key); },
            async healthCheck() { return true; },
            async verifyReadWrite() { return { write: true, read: true, delete: true }; },
        };
        const artifacts: Array<{ id: string; objectStorageKey: string }> = [];
        const repo = {
            async listSeriesForStudy() { return [{ id: "series-1" }]; },
            async listInstancesForSeries() { return [{ id: "instance-1", objectStorageKey: "org/study/series/original.dcm" }]; },
            async createDerivedArtifact(input: { objectStorageKey: string }) {
                const artifact = { id: "artifact-1", objectStorageKey: input.objectStorageKey };
                artifacts.push(artifact);
                return artifact;
            },
        } as unknown as TenantImagingRepository;
        const now = new Date().toISOString();
        const job: DeidentificationJob = {
            id: "job-1", sourceStudyId: "study-1", profile: "basic", purpose: "research",
            burnedInTextSuspected: false, recognizableFeaturesFlagged: false, reviewStatus: "pending-review",
            requestedByUserId: "user-1", createdAt: now, updatedAt: now,
        };

        const result = await deidentifyStudy({ repo, objectStore, organizationId: "org" }, job);

        expect(result.artifactIds).toEqual(["artifact-1"]);
        expect(result.reviewRequired).toBe(true);
        expect(artifacts).toHaveLength(1);
        const output = objects.get(artifacts[0].objectStorageKey)!;
        expect(output.equals(original)).toBe(false);
        const arrayBuffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
        const parsed = dcmjs.data.DicomMessage.readFile(arrayBuffer).dict as Record<string, { Value?: unknown[] }>;
        expect(parsed["00100020"].Value?.[0]).not.toBe("MRN-SECRET");
        expect(parsed["00100021"].Value?.[0]).not.toBe("HOSPITAL-A");
        expect(parsed["00120062"].Value?.[0]).toBe("YES");
    });
});
