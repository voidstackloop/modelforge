import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as evidenceStore from "./evidence-store";

function mockFetchOnce(html: string, status = 200) {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
            ok: status >= 200 && status < 300,
            status,
            text: () => Promise.resolve(html),
        })
    );
}

describe("evidence-store", () => {
    beforeEach(() => {
        for (const s of evidenceStore.listSources()) evidenceStore.deleteSource(s.id);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("rejects a malformed URL without fetching", async () => {
        await expect(evidenceStore.addSourceFromUrl("not a url")).rejects.toThrow(/not a valid URL/);
    });

    it("rejects a non-http(s) URL", async () => {
        await expect(evidenceStore.addSourceFromUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    });

    it("extracts title and description from a fetched page", async () => {
        mockFetchOnce(
            `<html><head><title>Synthetic Guideline on Hypertension</title>
             <meta name="description" content="A synthetic summary for testing."></head><body></body></html>`
        );
        const source = await evidenceStore.addSourceFromUrl("https://www.who.int/synthetic-guideline");
        expect(source.title).toBe("Synthetic Guideline on Hypertension");
        expect(source.excerpt).toBe("A synthetic summary for testing.");
        expect(source.organization).toBe("World Health Organization");
        expect(source.sourceType).toBe("guideline");
    });

    it("never fabricates a title when none is found", async () => {
        mockFetchOnce(`<html><head></head><body>no title here</body></html>`);
        const source = await evidenceStore.addSourceFromUrl("https://example.com/no-title-page");
        expect(source.title).toBe("/no-title-page");
        expect(source.excerpt).toBeUndefined();
    });

    it("throws on a non-ok HTTP response instead of recording a broken source", async () => {
        mockFetchOnce("not found", 404);
        await expect(evidenceStore.addSourceFromUrl("https://example.com/missing")).rejects.toThrow(/404/);
    });

    it("lists and deletes sources", async () => {
        mockFetchOnce(`<html><head><title>T</title></head></html>`);
        const source = await evidenceStore.addSourceFromUrl("https://example.com/a");
        expect(evidenceStore.listSources().map((s) => s.id)).toContain(source.id);
        evidenceStore.deleteSource(source.id);
        expect(evidenceStore.getSource(source.id)).toBeNull();
    });
});
