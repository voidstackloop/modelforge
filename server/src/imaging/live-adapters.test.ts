import { describe, expect, it } from "vitest";
import { S3ImagingObjectStore } from "./object-store.js";
import { ProxyDicomwebAdapter } from "./dicomweb-adapter.js";
import { CloudFrontContentDelivery } from "./content-delivery.js";

const s3Configured = Boolean(process.env.IMAGING_S3_BUCKET && process.env.IMAGING_S3_KMS_KEY_ID && process.env.IMAGING_S3_REGION);
const pacsConfigured = Boolean(process.env.IMAGING_PACS_BASE_URL && process.env.IMAGING_PACS_AUTH_HEADER);
const cloudFrontConfigured = Boolean(
    process.env.IMAGING_CLOUDFRONT_DOMAIN && process.env.IMAGING_CLOUDFRONT_KEY_PAIR_ID && process.env.IMAGING_CLOUDFRONT_PRIVATE_KEY && s3Configured
);

describe("live imaging adapters (environment-gated; never mocked)", () => {
    it.runIf(s3Configured)("writes, reads, and deletes a PHI-free S3 probe using SSE-KMS", async () => {
        const store = new S3ImagingObjectStore(
            process.env.IMAGING_S3_BUCKET!,
            process.env.IMAGING_S3_KMS_KEY_ID!,
            process.env.IMAGING_S3_REGION!,
            process.env.IMAGING_S3_KEY_PREFIX
        );
        expect(await store.verifyReadWrite()).toEqual({ write: true, read: true, delete: true });
    });

    it.runIf(pacsConfigured)("performs a real, non-mutating QIDO-RS probe against the configured PACS", async () => {
        const adapter = new ProxyDicomwebAdapter(process.env.IMAGING_PACS_BASE_URL!, process.env.IMAGING_PACS_AUTH_HEADER!);
        expect(await adapter.verifyConnectivity()).toEqual({ qido: true, stow: "not-run", wado: "not-run" });
    });

    /**
     * The two properties that matter for CloudFront delivery and that only a
     * real distribution can prove: a signed URL is actually accepted, and an
     * unsigned one is actually refused. The second half is the important
     * one — it is what confirms Origin Access Control is really in force and
     * the bucket is not publicly readable. Writes the probe object through
     * the same S3 store the application uses, then removes it.
     */
    it.runIf(cloudFrontConfigured)("serves a signed URL and refuses an unsigned one against the real distribution", async () => {
        const store = new S3ImagingObjectStore(
            process.env.IMAGING_S3_BUCKET!,
            process.env.IMAGING_S3_KMS_KEY_ID!,
            process.env.IMAGING_S3_REGION!,
            process.env.IMAGING_S3_KEY_PREFIX
        );
        const delivery = new CloudFrontContentDelivery(
            process.env.IMAGING_CLOUDFRONT_DOMAIN!,
            process.env.IMAGING_CLOUDFRONT_KEY_PAIR_ID!,
            Buffer.from(process.env.IMAGING_CLOUDFRONT_PRIVATE_KEY!, "base64").toString("utf8")
        );
        // PHI-free, random, and short-lived — never a real imaging object.
        const key = `.verification/cdn-${Date.now()}.bin`;
        const payload = Buffer.from("modelforge-cloudfront-probe");
        await store.put(key, payload, "application/octet-stream");
        try {
            const signed = delivery.signObjectUrl(key, 60);
            const signedResponse = await fetch(signed.url);
            expect(signedResponse.status).toBe(200);
            expect(Buffer.from(await signedResponse.arrayBuffer()).equals(payload)).toBe(true);

            const unsignedResponse = await fetch(signed.url.split("?")[0]);
            expect(unsignedResponse.status).toBe(403);
        } finally {
            await store.delete(key);
        }
    });
});
