import { createHash } from "node:crypto";
import dcmjs from "dcmjs";
import type { DeidentificationJob } from "@modelforge/contracts";
import type { ImagingObjectStore } from "./object-store.js";
import type { TenantImagingRepository } from "../store/imaging-store.js";

type DicomElement = { vr?: string; Value?: unknown[] };

const DATE_TAGS = ["00080012", "00080020", "00080021", "00080022", "00080023", "00080024", "00080025", "00100030", "00321040"];
const UID_TAGS = ["00080018", "0020000D", "0020000E", "00200052"];

function exactArrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function firstString(dict: Record<string, unknown>, tag: string): string | undefined {
    const value = (dict[tag] as DicomElement | undefined)?.Value?.[0];
    return typeof value === "string" ? value : undefined;
}

function removePrivateTags(dict: Record<string, unknown>): void {
    for (const [tag, raw] of Object.entries(dict)) {
        if (/^[0-9A-Fa-f]{8}$/.test(tag) && Number.parseInt(tag.slice(0, 4), 16) % 2 === 1) {
            delete dict[tag];
            continue;
        }
        const element = raw as DicomElement;
        if (element?.vr === "SQ" && Array.isArray(element.Value)) {
            for (const item of element.Value) if (item && typeof item === "object") removePrivateTags(item as Record<string, unknown>);
        }
    }
}

function replacementUid(source: string, jobId: string): string {
    const decimal = BigInt(`0x${createHash("sha256").update(jobId).update("\0").update(source).digest("hex")}`).toString(10);
    return `2.25.${decimal}`.slice(0, 64);
}

export interface DeidentificationResult {
    artifactIds: string[];
    burnedInTextSuspected: boolean;
    recognizableFeaturesFlagged: boolean;
    reviewRequired: boolean;
}

/** Applies a conservative PS3.15 Basic Application Confidentiality Profile
 * subset to every instance in a study and writes new immutable derivatives.
 * Pixel bytes are never modified: if pixel data exists and its safety cannot
 * be established from DICOM flags, the candidate is held for human review.
 * The clean-pixel-data profile is therefore never auto-approved in this
 * implementation; that is safer than silently claiming OCR/redaction. */
export async function deidentifyStudy(
    deps: { repo: TenantImagingRepository; objectStore: ImagingObjectStore; organizationId: string },
    job: DeidentificationJob
): Promise<DeidentificationResult> {
    const series = await deps.repo.listSeriesForStudy(job.sourceStudyId);
    const instances = (await Promise.all(series.map((item) => deps.repo.listInstancesForSeries(item.id)))).flat();
    if (instances.length === 0) throw new Error("The source study has no DICOM instances.");

    const artifactIds: string[] = [];
    let burnedInTextSuspected = false;
    let recognizableFeaturesFlagged = false;
    let uncertainPixels = false;

    for (const instance of instances) {
        const original = await deps.objectStore.get(instance.objectStorageKey);
        const dicom = dcmjs.data.DicomMessage.readFile(exactArrayBuffer(original));
        const dict = dicom.dict;
        const retainedDates = new Map<string, unknown>();
        for (const tag of DATE_TAGS) if (dict[tag] !== undefined) retainedDates.set(tag, dict[tag]);
        const retainedUids = new Map<string, string>();
        for (const tag of UID_TAGS) {
            const uid = firstString(dict, tag);
            if (uid !== undefined) retainedUids.set(tag, uid);
        }
        const hasPixelData = dict["7FE00010"] !== undefined;
        const burnedFlag = firstString(dict, "00280301")?.toUpperCase();
        const recognizableFlag = firstString(dict, "00280302")?.toUpperCase();
        burnedInTextSuspected ||= burnedFlag === "YES";
        recognizableFeaturesFlagged ||= recognizableFlag === "YES";
        uncertainPixels ||= hasPixelData && (burnedFlag !== "NO" || recognizableFlag !== "NO");

        dcmjs.anonymizer.cleanTags(dict, {
            "00100010": "ANON^PATIENT",
            "00100020": `MF-${createHash("sha256").update(job.id).digest("hex").slice(0, 16)}`,
            "00100021": "MODELFORGE",
            "00120062": "YES",
            "00120063": `ModelForge PS3.15 ${job.profile}; metadata profile; human pixel review required when flagged`,
        });
        dict["00100010"] = { vr: "PN", Value: [{ Alphabetic: "ANON^PATIENT" }] };
        dict["00100020"] = { vr: "LO", Value: [`MF-${createHash("sha256").update(job.id).digest("hex").slice(0, 16)}`] };
        dict["00100021"] = { vr: "LO", Value: ["MODELFORGE"] };
        dict["00120062"] = { vr: "CS", Value: ["YES"] };
        dict["00120063"] = { vr: "LO", Value: [`ModelForge PS3.15 ${job.profile}; metadata profile; pixel review when flagged`] };
        removePrivateTags(dict);
        for (const [tag, sourceUid] of retainedUids) {
            const current = dict[tag] as DicomElement | undefined;
            dict[tag] = { ...(current ?? { vr: "UI" }), Value: [replacementUid(sourceUid, job.id)] };
        }
        if (job.profile === "retain-longitudinal-full-dates") {
            for (const [tag, value] of retainedDates) dict[tag] = value;
        } else {
            for (const tag of DATE_TAGS) delete dict[tag];
        }

        const output = Buffer.from(dicom.write());
        const objectStorageKey = `${deps.organizationId}/derived/deidentified/${job.id}/${instance.id}.dcm`;
        const stored = await deps.objectStore.put(objectStorageKey, output, "application/dicom");
        const artifact = await deps.repo.createDerivedArtifact({
            kind: "deidentified-instance",
            sourceInstanceId: instance.id,
            sourceStudyId: job.sourceStudyId,
            objectStorageKey,
            checksumSha256: stored.checksumSha256,
            sizeBytes: stored.sizeBytes,
            provenance: {
                targetType: "instance",
                targetId: instance.id,
                action: "deidentified",
                performedBy: "system:dicom-deidentification",
                performedAt: new Date().toISOString(),
                sourceRefs: [instance.id],
                details: { profile: job.profile, purpose: job.purpose, pixelDataModified: false },
            },
        });
        artifactIds.push(artifact.id);
    }

    return {
        artifactIds,
        burnedInTextSuspected,
        recognizableFeaturesFlagged,
        reviewRequired: burnedInTextSuspected || recognizableFeaturesFlagged || uncertainPixels || job.profile === "clean-pixel-data",
    };
}
