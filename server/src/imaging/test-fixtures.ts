/**
 * Shared DICOM Part 10 test-fixture builder — dicom-parser ships no sample
 * .dcm files, so every imaging test that needs a real (not mocked) DICOM
 * byte stream constructs one with this. Explicit VR Little Endian only
 * (the transfer syntax every test that needs one uses); good enough to
 * adversarially test parseAndValidateDicom/ingestion against something a
 * real parser actually has to parse, not a hand-waved stand-in.
 */

function evenPad(value: Buffer, padByte: number): Buffer {
    return value.length % 2 === 0 ? value : Buffer.concat([value, Buffer.from([padByte])]);
}

const SHORT_VRS = new Set(["UI", "LO", "CS", "SH", "DA", "TM", "AE", "US", "UL", "IS", "DS", "AS", "PN"]);

function encodeElement(group: number, element: number, vr: string, value: Buffer): Buffer {
    const tag = Buffer.alloc(4);
    tag.writeUInt16LE(group, 0);
    tag.writeUInt16LE(element, 2);
    const vrBuf = Buffer.from(vr, "ascii");
    if (SHORT_VRS.has(vr)) {
        const len = Buffer.alloc(2);
        len.writeUInt16LE(value.length, 0);
        return Buffer.concat([tag, vrBuf, len, value]);
    }
    const reserved = Buffer.from([0, 0]);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(value.length, 0);
    return Buffer.concat([tag, vrBuf, reserved, len, value]);
}

function uiValue(uid: string): Buffer {
    return evenPad(Buffer.from(uid, "ascii"), 0);
}
function strValue(s: string): Buffer {
    return evenPad(Buffer.from(s, "ascii"), 0x20);
}

export interface DicomFixtureOptions {
    studyInstanceUid?: string;
    seriesInstanceUid?: string;
    sopInstanceUid?: string;
    sopClassUid?: string;
    transferSyntaxUid?: string;
    patientId?: string;
    issuerOfPatientId?: string;
    modality?: string;
    accessionNumber?: string;
    studyDate?: string;
    /** Include a small uncompressed 8-bit grayscale PixelData element
     * (rows x columns), for tests exercising thumbnail generation. */
    pixels?: { rows: number; columns: number };
    /** Corrupt the buffer after building — for adversarial tests. */
    corrupt?: (buf: Buffer) => Buffer;
}

let counter = 0;
function uid(): string {
    counter += 1;
    return `1.2.840.99999.1.${Date.now()}.${counter}`;
}

export function buildMinimalDicomFile(options: DicomFixtureOptions = {}): Buffer {
    const transferSyntaxUid = options.transferSyntaxUid ?? "1.2.840.10008.1.2.1";
    const sopClassUid = options.sopClassUid ?? "1.2.840.10008.5.1.4.1.1.7"; // Secondary Capture
    const sopInstanceUid = options.sopInstanceUid ?? uid();
    const studyInstanceUid = options.studyInstanceUid ?? uid();
    const seriesInstanceUid = options.seriesInstanceUid ?? uid();

    const metaElements = Buffer.concat([
        encodeElement(0x0002, 0x0002, "UI", uiValue(sopClassUid)),
        encodeElement(0x0002, 0x0003, "UI", uiValue(sopInstanceUid)),
        encodeElement(0x0002, 0x0010, "UI", uiValue(transferSyntaxUid)),
        encodeElement(0x0002, 0x0012, "UI", uiValue("1.2.840.99999.99")),
    ]);
    const groupLength = encodeElement(0x0002, 0x0000, "UL", (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(metaElements.length, 0);
        return b;
    })());

    const datasetParts: Buffer[] = [
        encodeElement(0x0008, 0x0016, "UI", uiValue(sopClassUid)),
        encodeElement(0x0008, 0x0018, "UI", uiValue(sopInstanceUid)),
        encodeElement(0x0008, 0x0060, "CS", strValue(options.modality ?? "OT")),
        encodeElement(0x0010, 0x0020, "LO", strValue(options.patientId ?? "TESTMRN1")),
        encodeElement(0x0010, 0x0021, "LO", strValue(options.issuerOfPatientId ?? "TEST-HOSPITAL")),
        encodeElement(0x0020, 0x000d, "UI", uiValue(studyInstanceUid)),
        encodeElement(0x0020, 0x000e, "UI", uiValue(seriesInstanceUid)),
    ];
    if (options.accessionNumber) datasetParts.push(encodeElement(0x0008, 0x0050, "SH", strValue(options.accessionNumber)));
    if (options.studyDate) datasetParts.push(encodeElement(0x0008, 0x0020, "DA", strValue(options.studyDate)));

    if (options.pixels) {
        const { rows, columns } = options.pixels;
        datasetParts.push(encodeElement(0x0028, 0x0002, "US", (() => { const b = Buffer.alloc(2); b.writeUInt16LE(1, 0); return b; })())); // SamplesPerPixel
        datasetParts.push(encodeElement(0x0028, 0x0010, "US", (() => { const b = Buffer.alloc(2); b.writeUInt16LE(rows, 0); return b; })())); // Rows
        datasetParts.push(encodeElement(0x0028, 0x0011, "US", (() => { const b = Buffer.alloc(2); b.writeUInt16LE(columns, 0); return b; })())); // Columns
        datasetParts.push(encodeElement(0x0028, 0x0100, "US", (() => { const b = Buffer.alloc(2); b.writeUInt16LE(8, 0); return b; })())); // BitsAllocated
        const pixelData = Buffer.alloc(rows * columns, 128);
        datasetParts.push(encodeElement(0x7fe0, 0x0010, "OB", evenPad(pixelData, 0)));
    }

    const dataset = Buffer.concat(datasetParts);
    const preamble = Buffer.alloc(128, 0);
    const magic = Buffer.from("DICM", "ascii");

    const file: Buffer<ArrayBufferLike> = Buffer.concat([preamble, magic, groupLength, metaElements, dataset]);
    return options.corrupt ? options.corrupt(file) : file;
}
