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
// what matters for both the Ollama and llama.cpp backends this app supports.
export async function searchGgufModels(query: string, limit = 20, token?: string | null): Promise<HfModelSummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const url = `${HF_API}/models?search=${encodeURIComponent(trimmed)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
    const data = await hfFetchJson<{ id: string; downloads?: number; likes?: number; tags?: string[] }[]>(url, token);
    return data.map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, tags: m.tags ?? [] }));
}

export async function listGgufFiles(modelId: string, token?: string | null): Promise<HfGgufFile[]> {
    const url = `${HF_API}/models/${modelId}/tree/main`;
    const data = await hfFetchJson<{ path: string; type: string; size?: number }[]>(url, token);
    return data
        .filter((entry) => entry.type === "file" && entry.path.toLowerCase().endsWith(".gguf"))
        .map((entry) => ({ path: entry.path, sizeBytes: entry.size ?? null }));
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
    token?: string | null
): Promise<void> {
    const { downloadGgufFileNative } = await import("./native-downloader");
    await downloadGgufFileNative(modelId, filename, destPath, token ?? undefined, (err, progress) => {
        if (err) return; // fatal errors surface via the returned promise's rejection instead
        onProgress({ receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes ?? null });
    });
}
