import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { encodePng, generateThumbnail } from "./thumbnail.js";
import { parseAndValidateDicom } from "./dicom-parse.js";
import { buildMinimalDicomFile } from "./test-fixtures.js";

describe("encodePng", () => {
    it("produces a structurally valid PNG whose IDAT round-trips to the original pixels", () => {
        const width = 4;
        const height = 3;
        const pixels = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // 4x3 grayscale
        const png = encodePng(width, height, 1, pixels);

        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        // IHDR chunk: length(4) + "IHDR"(4) + data(13) + crc(4), right after signature.
        const ihdrData = png.subarray(8 + 8, 8 + 8 + 13);
        expect(ihdrData.readUInt32BE(0)).toBe(width);
        expect(ihdrData.readUInt32BE(4)).toBe(height);
        expect(ihdrData.readUInt8(8)).toBe(8); // bit depth
        expect(ihdrData.readUInt8(9)).toBe(0); // grayscale color type

        // Locate and inflate the IDAT chunk to confirm the actual pixel
        // bytes (minus the per-scanline filter-type byte) match input.
        const idatStart = 8 + (8 + 13 + 4); // after signature + IHDR chunk
        const idatLength = png.readUInt32BE(idatStart);
        const idatData = png.subarray(idatStart + 8, idatStart + 8 + idatLength);
        const raw = inflateSync(idatData);
        expect(raw.length).toBe((width + 1) * height);
        for (let y = 0; y < height; y++) {
            expect(raw[y * (width + 1)]).toBe(0); // filter byte
            expect(raw.subarray(y * (width + 1) + 1, y * (width + 1) + 1 + width)).toEqual(pixels.subarray(y * width, y * width + width));
        }
    });
});

describe("generateThumbnail", () => {
    it("generates a thumbnail for an uncompressed grayscale instance", () => {
        const buf = buildMinimalDicomFile({ pixels: { rows: 8, columns: 8 } });
        const { dataSet, metadata } = parseAndValidateDicom(buf);
        const thumbnail = generateThumbnail(dataSet, metadata.transferSyntaxUid);
        expect(thumbnail).not.toBeNull();
        expect(thumbnail!.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });

    it("returns null (not a fabricated placeholder) for an instance with no pixel data", () => {
        const buf = buildMinimalDicomFile();
        const { dataSet, metadata } = parseAndValidateDicom(buf);
        expect(generateThumbnail(dataSet, metadata.transferSyntaxUid)).toBeNull();
    });

    it("returns null for a compressed transfer syntax rather than attempting to decode it", () => {
        // JPEG Baseline — this server deliberately does not carry a JPEG
        // codec (see this module's own doc comment on why).
        const buf = buildMinimalDicomFile({ transferSyntaxUid: "1.2.840.10008.1.2.4.50", pixels: { rows: 8, columns: 8 } });
        const { dataSet, metadata } = parseAndValidateDicom(buf);
        expect(generateThumbnail(dataSet, metadata.transferSyntaxUid)).toBeNull();
    });
});
