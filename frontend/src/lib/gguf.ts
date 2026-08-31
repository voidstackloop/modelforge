import type { HfGgufFile } from "@/types/electron";

const SHARD_PATTERN = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

export function groupGgufFiles(files: HfGgufFile[]): HfGgufFile[][] {
    const groups = new Map<string, HfGgufFile[]>();
    for (const file of files) {
        const shard = file.path.match(SHARD_PATTERN);
        const key = shard ? `${shard[1]}-of-${shard[3]}` : file.path;
        const group = groups.get(key) ?? [];
        group.push(file);
        groups.set(key, group);
    }
    return [...groups.values()].map((group) => [...group].sort((a, b) => a.path.localeCompare(b.path)));
}

export function ggufGroupFor(files: HfGgufFile[], selectedPath: string): HfGgufFile[] {
    return groupGgufFiles(files).find((group) => group.some((file) => file.path === selectedPath)) ?? [];
}

export function ggufGroupSize(group: HfGgufFile[]): number | null {
    return group.length > 0 && group.every((file) => file.sizeBytes !== null)
        ? group.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0)
        : null;
}
