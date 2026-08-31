import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as cloudBackupStore from "./cloud-backup-store";

describe("cloud-backup-store", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        cloudBackupStore.updateConfig({
            enabled: true,
            endpoint: "https://s3.us-west-2.amazonaws.com",
            region: "us-west-2",
            bucket: "modelforge-test-bucket",
            accessKeyId: "AKIAEXAMPLE",
            pathStyle: false,
        });
        cloudBackupStore.setSecretAccessKey("secret-example-key");
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("throws before making any network call when not fully configured", async () => {
        cloudBackupStore.clearSecretAccessKey();
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy as unknown as typeof fetch;

        await expect(cloudBackupStore.uploadBackup("envelope-json", "backup.mfbackup")).rejects.toThrow(/not fully configured/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("PUTs to a virtual-hosted-style URL (bucket as subdomain) when pathStyle is false", async () => {
        let requestedUrl = "";
        globalThis.fetch = vi.fn(async (req: Request) => {
            requestedUrl = req.url;
            return new Response(null, { status: 200 });
        }) as unknown as typeof fetch;

        await cloudBackupStore.uploadBackup("envelope-json", "modelforge-auto-backup-2026-01-01T00-00-00-000Z.mfbackup");

        expect(requestedUrl).toBe("https://modelforge-test-bucket.s3.us-west-2.amazonaws.com/modelforge-auto-backup-2026-01-01T00-00-00-000Z.mfbackup");
    });

    it("PUTs to a path-style URL (bucket in the path) when pathStyle is true", async () => {
        cloudBackupStore.updateConfig({ pathStyle: true });
        let requestedUrl = "";
        globalThis.fetch = vi.fn(async (req: Request) => {
            requestedUrl = req.url;
            return new Response(null, { status: 200 });
        }) as unknown as typeof fetch;

        await cloudBackupStore.uploadBackup("envelope-json", "backup.mfbackup");

        expect(requestedUrl).toBe("https://s3.us-west-2.amazonaws.com/modelforge-test-bucket/backup.mfbackup");
    });

    it("signs the request with an Authorization header (SigV4)", async () => {
        let authHeader: string | null = null;
        globalThis.fetch = vi.fn(async (req: Request) => {
            authHeader = req.headers.get("authorization");
            return new Response(null, { status: 200 });
        }) as unknown as typeof fetch;

        await cloudBackupStore.uploadBackup("envelope-json", "backup.mfbackup");

        expect(authHeader).toMatch(/^AWS4-HMAC-SHA256 /);
        expect(authHeader).toContain("AKIAEXAMPLE");
    });

    it("surfaces the S3 <Message> from an XML error body on a failed upload", async () => {
        globalThis.fetch = vi.fn(async () => {
            const xml = "<Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>";
            return new Response(xml, { status: 403 });
        }) as unknown as typeof fetch;

        await expect(cloudBackupStore.uploadBackup("envelope-json", "backup.mfbackup")).rejects.toThrow(/Access Denied\./);
    });

    it("testConnection PUTs then DELETEs a temporary test object", async () => {
        const methods: string[] = [];
        globalThis.fetch = vi.fn(async (req: Request) => {
            methods.push(req.method);
            return new Response(null, { status: 200 });
        }) as unknown as typeof fetch;

        await cloudBackupStore.testConnection();

        expect(methods).toEqual(["PUT", "DELETE"]);
    });

    it("testConnection still throws if the PUT fails, without needing the DELETE to succeed", async () => {
        globalThis.fetch = vi.fn(async () => new Response("<Error><Message>nope</Message></Error>", { status: 403 })) as unknown as typeof fetch;

        await expect(cloudBackupStore.testConnection()).rejects.toThrow(/nope/);
    });
});
