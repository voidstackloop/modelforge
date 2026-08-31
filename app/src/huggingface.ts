const HF_API = "https://huggingface.co/api";

export interface HfModelSummary {
    id: string;
    downloads: number;
    likes: number;
    tags: string[];
}

export interface HfGgufFile {
    path: string;
    sizeBytes: number | null;
    sha256?: string;
}

async function hfFetchJson<T>(url: string, token?: string | null): Promise<T> {
    let res: Response;
    try {
        res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    } catch (err) {
        throw new Error(`Couldn't reach the Hugging Face API: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`Hugging Face API error (HTTP ${res.status}).`);
    return (await res.json()) as T;
}

// Hugging Face's search endpoint already supports filtering by library/tag —
// "gguf" narrows results to repos that have at least one GGUF file, which is
// what matters for the llama.cpp backend this app supports.
export async function searchGgufModels(query: string, limit = 20, token?: string | null): Promise<HfModelSummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const url = `${HF_API}/models?search=${encodeURIComponent(trimmed)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
    const data = await hfFetchJson<{ id: string; downloads?: number; likes?: number; tags?: string[] }[]>(url, token);
    return data.map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, tags: m.tags ?? [] }));
}

export async function listGgufFiles(modelId: string, token?: string | null): Promise<HfGgufFile[]> {
    const url = `${HF_API}/models/${modelId}/tree/main`;
    const data = await hfFetchJson<{ path: string; type: string; size?: number; lfs?: { oid?: string; size?: number } }[]>(url, token);
    return data
        .filter((entry) => entry.type === "file" && entry.path.toLowerCase().endsWith(".gguf"))
        .map((entry) => ({ path: entry.path, sizeBytes: entry.lfs?.size ?? entry.size ?? null, sha256: entry.lfs?.oid?.match(/^[a-f0-9]{64}$/i)?.[0] }));
}

export interface DownloadProgress {
    receivedBytes: number;
    totalBytes: number | null;
}

// The actual HTTP + resume/verify logic lives in the native Rust addon
// (lib/) for speed — a plain single-stream port wouldn't outperform this,
// but splitting large files across several parallel Range-request
// connections meaningfully does. This wrapper keeps the exact signature the
// rest of the app (main.ts's hf:downloadFile handler) already calls, so
// nothing downstream needed to change.
export async function downloadGgufFile(
    modelId: string,
    filename: string,
    destPath: string,
    onProgress: (progress: DownloadProgress) => void,
    token?: string | null,
    // Verified the same way the job-based DownloadManager already verifies
    // each shard (lib/src/download/job.rs) — the Rust side deletes the
    // finished file and rejects the returned promise on a mismatch, rather
    // than accepting a byte-count-complete-but-corrupted file. `undefined`
    // (the default) skips verification entirely, unchanged from before this
    // parameter existed — no current caller has a checksum to supply yet.
    expectedSha256?: string | null
): Promise<void> {
    const { downloadGgufFileNative } = await import("./native-downloader");
    await downloadGgufFileNative(modelId, filename, destPath, token ?? undefined, expectedSha256 ?? undefined, (err, progress) => {
        if (err) return; // fatal errors surface via the returned promise's rejection instead
        onProgress({ receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes ?? null });
    });
}
