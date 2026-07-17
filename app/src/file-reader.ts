import * as fs from "node:fs";
import * as path from "node:path";
import { dialog, BrowserWindow } from "electron";
import * as media from "./media";

export interface AttachedFile {
    name: string;
    path: string;
    content: string;
    truncated: boolean;
}

export interface TextAttachment {
    kind: "text";
    name: string;
    path: string;
    content: string;
    truncated: boolean;
}

export interface ImageAttachment {
    kind: "image";
    name: string;
    path: string;
    mimeType: string;
    dataBase64: string;
    sourceVideo?: string;
}

export type MediaAttachment = TextAttachment | ImageAttachment;

export interface OpenFolderResult {
    folderName: string;
    folderPath: string;
    files: AttachedFile[];
    skippedCount: number;
    budgetExceeded: boolean;
}

const MAX_CHARS_PER_FILE = 50_000;
const MAX_TOTAL_CHARS = 400_000;
const MAX_FILES = 300;
const MAX_SINGLE_FILE_BYTES = 500_000;

const IGNORED_DIRS = new Set([
    "node_modules", "dist", "build", "out", "target", "venv", ".venv",
    "__pycache__", "coverage", "vendor", "bin", "obj",
]);

const IGNORED_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
    ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".flac",
    ".zip", ".tar", ".gz", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".pyc",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".pdf", ".lock",
]);

function looksBinary(buffer: Buffer): boolean {
    const sampleLength = Math.min(buffer.length, 8000);
    for (let i = 0; i < sampleLength; i++) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

export async function openAndReadFiles(win: BrowserWindow | null): Promise<AttachedFile[]> {
    const result = win
        ? await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] })
        : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });

    if (result.canceled) return [];

    const files: AttachedFile[] = [];
    for (const filePath of result.filePaths) {
        const name = path.basename(filePath);
        try {
            const buffer = fs.readFileSync(filePath);
            if (looksBinary(buffer)) {
                files.push({ name, path: filePath, content: "[binary file — not readable as text]", truncated: false });
                continue;
            }
            const text = buffer.toString("utf-8");
            const truncated = text.length > MAX_CHARS_PER_FILE;
            files.push({
                name,
                path: filePath,
                content: truncated ? text.slice(0, MAX_CHARS_PER_FILE) : text,
                truncated,
            });
        } catch (err) {
            files.push({
                name,
                path: filePath,
                content: `[failed to read file: ${(err as Error).message}]`,
                truncated: false,
            });
        }
    }
    return files;
}

export async function openAndReadMedia(win: BrowserWindow | null): Promise<MediaAttachment[]> {
    const result = win
        ? await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] })
        : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });

    if (result.canceled) return [];

    const items: MediaAttachment[] = [];
    for (const filePath of result.filePaths) {
        const name = path.basename(filePath);
        try {
            if (media.isImageFile(filePath)) {
                const img = await media.readImage(filePath);
                items.push({ kind: "image", name, path: filePath, mimeType: img.mimeType, dataBase64: img.dataBase64 });
                continue;
            }

            if (media.isVideoFile(filePath)) {
                const frames = await media.extractVideoFrames(filePath, 5);
                frames.forEach((frame, i) => {
                    items.push({
                        kind: "image",
                        name: `${name} (frame ${i + 1})`,
                        path: `${filePath}#frame${i + 1}`,
                        mimeType: frame.mimeType,
                        dataBase64: frame.dataBase64,
                        sourceVideo: name,
                    });
                });
                continue;
            }

            if (media.isPdfFile(filePath)) {
                const text = await media.extractPdfText(filePath);
                const truncated = text.length > MAX_CHARS_PER_FILE;
                items.push({
                    kind: "text",
                    name,
                    path: filePath,
                    content: truncated ? text.slice(0, MAX_CHARS_PER_FILE) : text,
                    truncated,
                });
                continue;
            }

            const buffer = fs.readFileSync(filePath);
            if (looksBinary(buffer)) {
                items.push({ kind: "text", name, path: filePath, content: "[binary file — not readable as text]", truncated: false });
                continue;
            }
            const text = buffer.toString("utf-8");
            const truncated = text.length > MAX_CHARS_PER_FILE;
            items.push({
                kind: "text",
                name,
                path: filePath,
                content: truncated ? text.slice(0, MAX_CHARS_PER_FILE) : text,
                truncated,
            });
        } catch (err) {
            items.push({
                kind: "text",
                name,
                path: filePath,
                content: `[failed to read file: ${(err as Error).message}]`,
                truncated: false,
            });
        }
    }
    return items;
}

interface WalkState {
    totalChars: number;
    skipped: number;
}

function walkDir(rootDir: string, dir: string, files: AttachedFile[], state: WalkState): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (files.length >= MAX_FILES || state.totalChars >= MAX_TOTAL_CHARS) {
            state.skipped++;
            continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
            walkDir(rootDir, fullPath, files, state);
            continue;
        }

        if (!entry.isFile()) continue;
        if (IGNORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

        try {
            const stat = fs.statSync(fullPath);
            if (stat.size > MAX_SINGLE_FILE_BYTES) {
                state.skipped++;
                continue;
            }

            const buffer = fs.readFileSync(fullPath);
            if (looksBinary(buffer)) {
                state.skipped++;
                continue;
            }

            let text = buffer.toString("utf-8");
            let truncated = false;
            if (text.length > MAX_CHARS_PER_FILE) {
                text = text.slice(0, MAX_CHARS_PER_FILE);
                truncated = true;
            }

            const remainingBudget = MAX_TOTAL_CHARS - state.totalChars;
            if (text.length > remainingBudget) {
                text = text.slice(0, Math.max(remainingBudget, 0));
                truncated = true;
            }

            state.totalChars += text.length;
            files.push({
                name: path.relative(rootDir, fullPath).split(path.sep).join("/"),
                path: fullPath,
                content: text,
                truncated,
            });
        } catch {
            state.skipped++;
        }
    }
}

export async function openFolderAndRead(win: BrowserWindow | null): Promise<OpenFolderResult | null> {
    const result = win
        ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
        : await dialog.showOpenDialog({ properties: ["openDirectory"] });

    if (result.canceled || result.filePaths.length === 0) return null;

    const rootDir = result.filePaths[0];
    const files: AttachedFile[] = [];
    const state: WalkState = { totalChars: 0, skipped: 0 };
    walkDir(rootDir, rootDir, files, state);

    return {
        folderName: path.basename(rootDir),
        folderPath: rootDir,
        files,
        skippedCount: state.skipped,
        budgetExceeded: state.totalChars >= MAX_TOTAL_CHARS || files.length >= MAX_FILES,
    };
}
