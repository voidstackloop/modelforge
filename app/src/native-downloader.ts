import * as path from "node:path";

export interface NativeDownloadProgress {
    receivedBytes: number;
    totalBytes?: number;
}

export interface JobEvent {
    jobId: string;
    kind: "shard_progress" | "shard_state" | "job_state" | "job_error";
    shardFilename?: string;
    shardState?: string;
    jobState?: string;
    receivedBytes?: number;
    jobReceivedBytes?: number;
    totalBytes?: number;
    bytesPerSec?: number;
    etaSeconds?: number;
    errorMessage?: string;
    errorKind?: string;
    retryable?: boolean;
}

export interface JsShard {
    filename: string;
    path: string;
    expectedBytes: number;
    receivedBytes: number;
    sha256?: string;
}

export interface JsDownloadJob {
    id: string;
    modelId: string;
    token?: string;
    destinationDir: string;
    shards: JsShard[];
}

export interface NativeDownloadManager {
    setGlobalConcurrency(limit: number): void;
    setBandwidthLimit(bytesPerSec: number | undefined | null): void;
    pauseJob(jobId: string): void;
    cancelJob(jobId: string): void;
    startJob(job: JsDownloadJob, onEvent: (err: Error | null, event: JobEvent) => void): Promise<void>;
}

interface NativeAddon {
    downloadGgufFile(
        modelId: string,
        filename: string,
        destPath: string,
        token: string | undefined | null,
        onProgress: (err: Error | null, progress: NativeDownloadProgress) => void
    ): Promise<void>;
    DownloadManager: new () => NativeDownloadManager;
}

// The Rust addon is built by `lib`'s `napi build` step into app/native/ as a
// plain filesystem artifact (not an npm dependency under node_modules —
// see the plan for why: a `file:` dependency would need `npm ci` to
// reconcile a different lockfile integrity hash per platform's .node
// binary). `dist/native-downloader.js` sits one level under app/, so
// app/native is a sibling reached by going up just one directory. Electron
// transparently redirects native-module requires from inside app.asar to
// the asarUnpack'd app.asar.unpacked counterpart at packaging time.
let nativeAddon: NativeAddon | undefined;

function getNativeAddon(): NativeAddon {
    if (!nativeAddon) {
        nativeAddon = require(path.join(__dirname, "..", "native")) as NativeAddon;
    }
    return nativeAddon;
}

export function downloadGgufFileNative(
    modelId: string,
    filename: string,
    destPath: string,
    token: string | undefined | null,
    onProgress: (err: Error | null, progress: NativeDownloadProgress) => void
): Promise<void> {
    return getNativeAddon().downloadGgufFile(modelId, filename, destPath, token, onProgress);
}

// One instance for the app's lifetime — its global concurrency semaphore
// and bandwidth limiter are only meaningfully "global" if nothing else
// constructs a second one. Purely additive to `downloadGgufFileNative`
// above, which stays exactly as-is for the existing single-file `hf:
// downloadFile` flow.
let downloadManager: NativeDownloadManager | undefined;

export function getDownloadManager(): NativeDownloadManager {
    if (!downloadManager) {
        const { DownloadManager } = getNativeAddon();
        downloadManager = new DownloadManager();
    }
    return downloadManager;
}
