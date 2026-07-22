export type DiffLine = { type: "same" | "add" | "remove"; text: string };

// Only meant for the small preview shown before approving a write_file call —
// caps input size and falls back to a coarse "whole file replaced" view for
// anything large, rather than paying for a full LCS on big files.
const MAX_DIFF_LINES = 2000;

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
        return [
            ...oldLines.map((text): DiffLine => ({ type: "remove", text })),
            ...newLines.map((text): DiffLine => ({ type: "add", text })),
        ];
    }

    const n = oldLines.length;
    const m = newLines.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] =
                oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const result: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (oldLines[i] === newLines[j]) {
            result.push({ type: "same", text: oldLines[i] });
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            result.push({ type: "remove", text: oldLines[i] });
            i++;
        } else {
            result.push({ type: "add", text: newLines[j] });
            j++;
        }
    }
    while (i < n) result.push({ type: "remove", text: oldLines[i++] });
    while (j < m) result.push({ type: "add", text: newLines[j++] });
    return result;
}
