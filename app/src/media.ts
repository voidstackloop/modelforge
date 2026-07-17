import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const IMAGE_MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".webm", ".mkv", ".m4v"]);

export function isImageFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() in IMAGE_MIME_TYPES;
}

export function isVideoFile(filePath: string): boolean {
    return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isPdfFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".pdf";
}

export interface ImageData {
    mimeType: string;
    dataBase64: string;
}

export async function readImage(filePath: string): Promise<ImageData> {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[ext] ?? "image/png";
    const buffer = fs.readFileSync(filePath);
    return { mimeType, dataBase64: buffer.toString("base64") };
}

export async function extractPdfText(filePath: string): Promise<string> {
    // pdf-parse v2 switched to a class-based API (v1 was a plain function
    // call) — require() here since the rest of this project is CommonJS.
    const { PDFParse } = require("pdf-parse");
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    try {
        const result = await parser.getText();
        return result.text as string;
    } finally {
        await parser.destroy();
    }
}

function ffmpegBinaryPath(): string {
    // electron-builder's asarUnpack keeps this binary outside the asar archive
    // (asar-packed files can't be exec'd directly); this swap finds it there
    // when the app is packaged, and uses the normal path during development.
    const ffmpegPath = require("ffmpeg-static") as string;
    return ffmpegPath.replace("app.asar", "app.asar.unpacked");
}

export async function extractVideoFrames(filePath: string, count = 5): Promise<ImageData[]> {
    const tmpDir = path.join(os.tmpdir(), `modelforge-frames-${randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const outputPattern = path.join(tmpDir, "frame-%02d.jpg");

    try {
        await new Promise<void>((resolve, reject) => {
            execFile(
                ffmpegBinaryPath(),
                [
                    "-i", filePath,
                    // Sample one frame per second rather than using the
                    // "thumbnail" filter, which needs ~100 input frames per
                    // batch to emit even a single output frame — it silently
                    // under-delivers (or produces nothing) on short clips.
                    "-vf", "fps=1,scale=768:-1",
                    "-frames:v", String(count),
                    outputPattern,
                ],
                { timeout: 60_000 },
                (err) => (err ? reject(err) : resolve())
            );
        });

        const frameFiles = fs
            .readdirSync(tmpDir)
            .filter((f) => f.startsWith("frame-"))
            .sort();

        return frameFiles.map((f) => ({
            mimeType: "image/jpeg",
            dataBase64: fs.readFileSync(path.join(tmpDir, f)).toString("base64"),
        }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
