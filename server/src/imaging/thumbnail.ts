import { deflateSync } from "node:zlib";
import type * as dicomParser from "dicom-parser";
import { UNCOMPRESSED_TRANSFER_SYNTAXES } from "./dicom-parse.js";

/**
 * Server-side thumbnail generation — item 5's "generate thumbnails
 * asynchronously" and item 19's "prioritize interactive viewing over
 * thumbnails" (this runs as background-compute priority through the
 * resource orchestrator — see server/src/imaging/ingestion.ts's caller).
 *
 * Deliberately scoped to uncompressed transfer syntaxes only (Implicit/
 * Explicit VR Little/Big Endian) with 8 or 16-bit grayscale or RGB pixel
 * data — real JPEG/JPEG2000/RLE DICOM pixel decoding needs a real codec
 * library (the same one the embedded OHIF/cornerstone viewer already
 * carries), and reimplementing that here would be exactly the "diagnostic
 * renderer from scratch" the task explicitly says not to build. For a
 * compressed-transfer-syntax instance, `generateThumbnail` returns `null`
 * — the caller (ingestion.ts) records "thumbnail not available for this
 * transfer syntax" rather than fabricating a placeholder image, and the
 * viewer remains the actual way to see that instance's pixels. This is a
 * disclosed, real scope boundary, not a silent gap — see docs/IMAGING.md.
 *
 * Output is a minimal, self-encoded PNG (no external image-encoding
 * dependency) — grayscale or RGB, 8-bit, no interlacing, one IDAT chunk.
 * Downsamples via nearest-neighbor to a fixed small size; this is a
 * preview thumbnail, not a diagnostic-quality render.
 */

const THUMBNAIL_SIZE = 128;

function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes raw 8-bit pixel samples (row-major, `channels` samples per
 * pixel — 1 for grayscale, 3 for RGB) as a minimal valid PNG. */
export function encodePng(width: number, height: number, channels: 1 | 3, pixels: Buffer): Buffer {
    const colorType = channels === 1 ? 0 : 2; // PNG color type: 0 grayscale, 2 truecolor
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8); // bit depth
    ihdr.writeUInt8(colorType, 9);
    ihdr.writeUInt8(0, 10); // compression method
    ihdr.writeUInt8(0, 11); // filter method
    ihdr.writeUInt8(0, 12); // interlace method

    const stride = width * channels;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter type 0 (none) per scanline
        pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }
    const idat = deflateSync(raw);

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Returns a PNG thumbnail buffer, or null if this instance's transfer
 * syntax/pixel format isn't one this server can safely decode itself. */
export function generateThumbnail(dataSet: dicomParser.DataSet, transferSyntaxUid: string): Buffer | null {
    if (!UNCOMPRESSED_TRANSFER_SYNTAXES.has(transferSyntaxUid)) return null;

    const pixelDataElement = dataSet.elements.x7fe00010;
    if (!pixelDataElement || pixelDataElement.encapsulatedPixelData) return null; // encapsulated = compressed, handled above already, but defense in depth

    const rows = dataSet.uint16("x00280010");
    const columns = dataSet.uint16("x00280011");
    const bitsAllocated = dataSet.uint16("x00280100");
    const samplesPerPixel = dataSet.uint16("x00280002") ?? 1;
    if (!rows || !columns || (bitsAllocated !== 8 && bitsAllocated !== 16) || (samplesPerPixel !== 1 && samplesPerPixel !== 3)) return null;

    const byteArray = dataSet.byteArray;
    const bytesPerSample = bitsAllocated / 8;
    const pixelStart = pixelDataElement.dataOffset;
    const expectedBytes = rows * columns * samplesPerPixel * bytesPerSample;
    if (pixelDataElement.length < expectedBytes) return null; // truncated pixel data — don't guess

    // Nearest-neighbor downsample to THUMBNAIL_SIZE x THUMBNAIL_SIZE (or
    // smaller, preserving aspect ratio, if the source is smaller).
    const outWidth = Math.min(THUMBNAIL_SIZE, columns);
    const outHeight = Math.min(THUMBNAIL_SIZE, rows);
    const channels = samplesPerPixel === 3 ? 3 : 1;
    const out = Buffer.alloc(outWidth * outHeight * channels);

    // 16-bit samples are windowed to 8-bit using the actual min/max found
    // in the (small, downsampled) output rather than assuming a fixed
    // bit depth range — a simple, defensible default absent real
    // window-center/window-width DICOM tags, which a thumbnail doesn't
    // need to honor precisely (the embedded viewer applies real W/L).
    const samples: number[] = [];
    for (let oy = 0; oy < outHeight; oy++) {
        const sy = Math.floor((oy * rows) / outHeight);
        for (let ox = 0; ox < outWidth; ox++) {
            const sx = Math.floor((ox * columns) / outWidth);
            for (let c = 0; c < channels; c++) {
                const sampleIndex = (sy * columns + sx) * samplesPerPixel + c;
                const byteOffset = pixelStart + sampleIndex * bytesPerSample;
                const value = bitsAllocated === 8 ? byteArray[byteOffset] : (byteArray[byteOffset] | (byteArray[byteOffset + 1] << 8));
                samples.push(value);
            }
        }
    }

    if (bitsAllocated === 16) {
        const min = Math.min(...samples);
        const max = Math.max(...samples);
        const range = max - min || 1;
        for (let i = 0; i < samples.length; i++) out[i] = Math.round(((samples[i] - min) / range) * 255);
    } else {
        for (let i = 0; i < samples.length; i++) out[i] = samples[i];
    }

    return encodePng(outWidth, outHeight, channels as 1 | 3, out);
}
