import * as fs from "node:fs";
import { createHash } from "node:crypto";

// Streamed, not buffered — a 40GB model shard must never be loaded whole
// into memory just to hash it, same discipline the download itself already
// follows (see huggingface.ts's downloadGgufFile).
export function computeSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

const GGUF_MAGIC = Buffer.from("GGUF", "ascii");

// A file that's the right size and even the right checksum could still be
// garbage if something upstream served an HTML error page sized to match
// (rare, but a Range-into-a-CDN-error-page is a real failure mode) — a
// cheap, independent sanity check on top of the checksum, not a substitute
// for it.
export function hasGgufMagic(filePath: string): boolean {
    let fd: number;
    try {
        fd = fs.openSync(filePath, "r");
    } catch {
        return false;
    }
    try {
        const buf = Buffer.alloc(4);
        const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
        return bytesRead === 4 && buf.equals(GGUF_MAGIC);
    } finally {
        fs.closeSync(fd);
    }
}

export interface DiskSpace {
    freeBytes: number;
    totalBytes: number;
}

// Node 18.15+'s fs.statfsSync — no new dependency needed. `dir` must exist;
// callers resolve/create the destination directory before checking.
export function getDiskSpace(dir: string): DiskSpace {
    const stats = fs.statfsSync(dir);
    return {
        freeBytes: stats.bavail * stats.bsize,
        totalBytes: stats.blocks * stats.bsize,
    };
}
