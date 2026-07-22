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

async function hfFetchJson<T>(url: string): Promise<T> {
    let res: Response;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error(`Couldn't reach the Hugging Face API: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`Hugging Face API error (HTTP ${res.status}).`);
    return (await res.json()) as T;
}

// Hugging Face's search endpoint already supports filtering by library/tag —
// "gguf" narrows results to repos that have at least one GGUF file, which is
// what matters for both the Ollama and llama.cpp backends this app supports.
export async function searchGgufModels(query: string, limit = 20): Promise<HfModelSummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const url = `${HF_API}/models?search=${encodeURIComponent(trimmed)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
    const data = await hfFetchJson<{ id: string; downloads?: number; likes?: number; tags?: string[] }[]>(url);
    return data.map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, tags: m.tags ?? [] }));
}

export async function listGgufFiles(modelId: string): Promise<HfGgufFile[]> {
    const url = `${HF_API}/models/${modelId}/tree/main`;
    const data = await hfFetchJson<{ path: string; type: string; size?: number }[]>(url);
    return data
        .filter((entry) => entry.type === "file" && entry.path.toLowerCase().endsWith(".gguf"))
        .map((entry) => ({ path: entry.path, sizeBytes: entry.size ?? null }));
}

export interface DownloadProgress {
    receivedBytes: number;
    totalBytes: number | null;
}

export async function downloadGgufFile(
    modelId: string,
    filename: string,
    destPath: string,
    onProgress: (progress: DownloadProgress) => void
): Promise<void> {
    const fs = await import("node:fs");
    const url = `https://huggingface.co/${modelId}/resolve/main/${encodeURIComponent(filename)}`;
    let res: Response;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error(`Couldn't reach Hugging Face: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) throw new Error(`Failed to download "${filename}" (HTTP ${res.status}).`);

    const totalBytes = Number(res.headers.get("content-length")) || null;
    let receivedBytes = 0;
    const writeStream = fs.createWriteStream(destPath);
    const reader = res.body.getReader();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedBytes += value.byteLength;
            onProgress({ receivedBytes, totalBytes });
            await new Promise<void>((resolve, reject) => {
                writeStream.write(value, (err) => (err ? reject(err) : resolve()));
            });
        }
    } finally {
        writeStream.end();
    }
}
