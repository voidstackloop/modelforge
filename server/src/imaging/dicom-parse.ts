import * as dicomParser from "dicom-parser";

/**
 * Safe DICOM Part 10 parsing and metadata extraction — item 5's "validate
 * type, size, DICOM structure, transfer syntax, identifiers, and metadata;
 * protect parsers from malformed files and resource-exhaustion attacks."
 *
 * Uses `dicom-parser` (the same library cornerstone/OHIF's own toolchain
 * uses) rather than a hand-rolled binary parser — a mature, widely-used
 * parser is a materially smaller attack surface than new bespoke DICOM
 * parsing code for exactly the kind of adversarial-input handling this
 * item calls for.
 *
 * Defense-in-depth against resource exhaustion, in order:
 *  1. Caller (ingestion.ts) enforces a hard file-size cap BEFORE this
 *     function ever runs — dicom-parser's own parse cost is bounded by
 *     input size, but an absurdly large file is rejected before that even
 *     matters.
 *  2. dicom-parser parses element *headers* (tag/VR/length/offset) without
 *     eagerly materializing pixel data — it does not decode/decompress
 *     encapsulated (compressed) pixel data during parseDicom() itself.
 *  3. Every numeric field that could drive a downstream allocation (Rows,
 *     Columns, NumberOfFrames) is validated against a fixed sane maximum
 *     here, before this module's caller ever uses them for anything —
 *     see validateDicomBounds. A file claiming a 500,000×500,000 image or
 *     2 billion frames is rejected here, not discovered by allocating
 *     memory for it later.
 */

export class MalformedDicomError extends Error {
    constructor(reason: string) {
        super(`Malformed DICOM file: ${reason}`);
        this.name = "MalformedDicomError";
    }
}

export class UnsupportedTransferSyntaxError extends Error {
    constructor(public readonly transferSyntaxUid: string) {
        super(`Unsupported or unrecognized transfer syntax: ${transferSyntaxUid}`);
        this.name = "UnsupportedTransferSyntaxError";
    }
}

export class MissingRequiredIdentifiersError extends Error {
    constructor(public readonly missing: string[]) {
        super(`DICOM file is missing required identifiers: ${missing.join(", ")}`);
        this.name = "MissingRequiredIdentifiersError";
    }
}

export class DicomBoundsExceededError extends Error {
    constructor(reason: string) {
        super(`DICOM file exceeds safe processing bounds: ${reason}`);
        this.name = "DicomBoundsExceededError";
    }
}

// Transfer syntaxes this server actually understands well enough to trust
// for metadata extraction and (for the uncompressed ones) thumbnailing.
// Anything else is accepted for storage (the original bytes are always
// preserved untouched — item: "keep original DICOM objects immutable") but
// is NOT thumbnailed server-side and is flagged; the embedded viewer
// (OHIF/cornerstone, which carries real codec support this server
// deliberately does not reimplement) remains the path for actually
// rendering those pixels.
export const KNOWN_TRANSFER_SYNTAXES = new Set([
    "1.2.840.10008.1.2", // Implicit VR Little Endian
    "1.2.840.10008.1.2.1", // Explicit VR Little Endian
    "1.2.840.10008.1.2.1.99", // Deflated Explicit VR Little Endian
    "1.2.840.10008.1.2.2", // Explicit VR Big Endian (retired)
    "1.2.840.10008.1.2.4.50", // JPEG Baseline
    "1.2.840.10008.1.2.4.51", // JPEG Extended
    "1.2.840.10008.1.2.4.70", // JPEG Lossless
    "1.2.840.10008.1.2.4.90", // JPEG 2000 Lossless
    "1.2.840.10008.1.2.4.91", // JPEG 2000
    "1.2.840.10008.1.2.5", // RLE Lossless
]);
export const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.1.99", "1.2.840.10008.1.2.2"]);

const MAX_ROWS_COLUMNS = 20_000; // generous for any real radiographic/CT/MR image; rejects absurd claims
const MAX_NUMBER_OF_FRAMES = 20_000; // generous for any real cine/multi-frame series

export interface ExtractedDicomMetadata {
    studyInstanceUid: string;
    seriesInstanceUid: string;
    sopInstanceUid: string;
    sopClassUid: string;
    transferSyntaxUid: string;
    patientId: string;
    issuerOfPatientId: string;
    accessionNumber?: string;
    modality: string;
    studyDate?: string;
    studyTime?: string;
    studyDescription?: string;
    bodyPartExamined?: string;
    institutionName?: string;
    referringPhysicianName?: string;
    seriesNumber?: string;
    instanceNumber?: string;
    rows?: number;
    columns?: number;
    numberOfFrames?: number;
}

const TAG = {
    patientId: "x00100020",
    issuerOfPatientId: "x00100021",
    studyInstanceUid: "x0020000d",
    seriesInstanceUid: "x0020000e",
    sopInstanceUid: "x00080018",
    sopClassUid: "x00080016",
    transferSyntaxUid: "x00020010",
    accessionNumber: "x00080050",
    modality: "x00080060",
    studyDate: "x00080020",
    studyTime: "x00080030",
    studyDescription: "x00081030",
    bodyPartExamined: "x00180015",
    institutionName: "x00080080",
    referringPhysicianName: "x00080090",
    seriesNumber: "x00200011",
    instanceNumber: "x00200013",
    rows: "x00280010",
    columns: "x00280011",
    numberOfFrames: "x00280008",
} as const;

/** Parses a DICOM Part 10 buffer and extracts normalized metadata.
 * Throws one of this module's typed errors on any failure — never returns
 * a partial result, and never includes raw file content or PHI in the
 * error message itself (item 5's "record failures without exposing PHI" —
 * these error *types*, not their message text, are what ingestion.ts logs
 * as the failure category). */
export function parseAndValidateDicom(buffer: Buffer): { dataSet: dicomParser.DataSet; metadata: ExtractedDicomMetadata } {
    let dataSet: dicomParser.DataSet;
    try {
        dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
    } catch (err) {
        throw new MalformedDicomError(err instanceof Error ? err.constructor.name : "unknown parse failure");
    }

    const transferSyntaxUid = dataSet.string(TAG.transferSyntaxUid);
    if (!transferSyntaxUid) throw new MalformedDicomError("missing TransferSyntaxUID in file meta information");
    if (!KNOWN_TRANSFER_SYNTAXES.has(transferSyntaxUid)) throw new UnsupportedTransferSyntaxError(transferSyntaxUid);

    const studyInstanceUid = dataSet.string(TAG.studyInstanceUid);
    const seriesInstanceUid = dataSet.string(TAG.seriesInstanceUid);
    const sopInstanceUid = dataSet.string(TAG.sopInstanceUid);
    const sopClassUid = dataSet.string(TAG.sopClassUid);
    const patientId = dataSet.string(TAG.patientId);
    const modality = dataSet.string(TAG.modality);

    const missing: string[] = [];
    if (!studyInstanceUid) missing.push("StudyInstanceUID");
    if (!seriesInstanceUid) missing.push("SeriesInstanceUID");
    if (!sopInstanceUid) missing.push("SOPInstanceUID");
    if (!sopClassUid) missing.push("SOPClassUID");
    if (!patientId) missing.push("PatientID");
    if (!modality) missing.push("Modality");
    if (missing.length > 0) throw new MissingRequiredIdentifiersError(missing);

    const rows = dataSet.uint16(TAG.rows);
    const columns = dataSet.uint16(TAG.columns);
    const numberOfFrames = dataSet.intString(TAG.numberOfFrames);
    if (rows !== undefined && rows > MAX_ROWS_COLUMNS) throw new DicomBoundsExceededError(`Rows ${rows} exceeds maximum ${MAX_ROWS_COLUMNS}`);
    if (columns !== undefined && columns > MAX_ROWS_COLUMNS) throw new DicomBoundsExceededError(`Columns ${columns} exceeds maximum ${MAX_ROWS_COLUMNS}`);
    if (numberOfFrames !== undefined && numberOfFrames > MAX_NUMBER_OF_FRAMES) throw new DicomBoundsExceededError(`NumberOfFrames ${numberOfFrames} exceeds maximum ${MAX_NUMBER_OF_FRAMES}`);
    if (numberOfFrames !== undefined && numberOfFrames < 1) throw new DicomBoundsExceededError("NumberOfFrames must be positive");

    const metadata: ExtractedDicomMetadata = {
        studyInstanceUid: studyInstanceUid!,
        seriesInstanceUid: seriesInstanceUid!,
        sopInstanceUid: sopInstanceUid!,
        sopClassUid: sopClassUid!,
        transferSyntaxUid,
        patientId: patientId!,
        issuerOfPatientId: dataSet.string(TAG.issuerOfPatientId) ?? "UNKNOWN",
        accessionNumber: dataSet.string(TAG.accessionNumber),
        modality: modality!,
        studyDate: dataSet.string(TAG.studyDate),
        studyTime: dataSet.string(TAG.studyTime),
        studyDescription: dataSet.string(TAG.studyDescription),
        bodyPartExamined: dataSet.string(TAG.bodyPartExamined),
        institutionName: dataSet.string(TAG.institutionName),
        referringPhysicianName: dataSet.string(TAG.referringPhysicianName),
        seriesNumber: dataSet.string(TAG.seriesNumber),
        instanceNumber: dataSet.string(TAG.instanceNumber),
        rows,
        columns,
        numberOfFrames,
    };
    return { dataSet, metadata };
}

/** DICOM DA (date) format YYYYMMDD -> ISO 8601 date, or undefined if
 * absent/malformed — never throws, since a malformed StudyDate is a
 * cosmetic metadata issue, not a reason to reject an otherwise-valid file. */
export function dicomDateToIso(da: string | undefined): string | undefined {
    if (!da || !/^\d{8}$/.test(da)) return undefined;
    return `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}`;
}
