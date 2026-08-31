import { describe, expect, it } from "vitest";
import { ggufGroupFor, ggufGroupSize, groupGgufFiles } from "./gguf";

describe("GGUF download helpers", () => {
    const files = [
        { path: "model-Q4_K_M-00002-of-00002.gguf", sizeBytes: 4_000, sha256: "b" },
        { path: "model-Q5_K_M.gguf", sizeBytes: 9_000, sha256: "c" },
        { path: "model-Q4_K_M-00001-of-00002.gguf", sizeBytes: 5_000, sha256: "a" },
    ];

    it("presents every sharded model as one ordered downloadable variant", () => {
        const groups = groupGgufFiles(files);
        expect(groups).toHaveLength(2);
        expect(groups[0].map((file) => file.path)).toEqual([
            "model-Q4_K_M-00001-of-00002.gguf",
            "model-Q4_K_M-00002-of-00002.gguf",
        ]);
        expect(ggufGroupFor(files, files[1].path)).toEqual([files[1]]);
    });

    it("uses the complete shard set for memory sizing", () => {
        const group = ggufGroupFor(files, files[0].path);
        expect(ggufGroupSize(group)).toBe(9_000);
        expect(ggufGroupSize([{ path: "unknown.gguf", sizeBytes: null }])).toBeNull();
    });
});
