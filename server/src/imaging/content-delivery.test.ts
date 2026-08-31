import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { CloudFrontContentDelivery, OriginStreamContentDelivery, DEFAULT_TTL_SECONDS } from "./content-delivery.js";

/**
 * The CloudFront signing protocol is verifiable entirely offline: a
 * signature is RSA-SHA1 over the policy document, so a locally-generated
 * keypair lets these tests check the *real* cryptographic output with
 * crypto.verify() rather than just asserting the URL "looks right." What
 * cannot be verified here is that CloudFront itself accepts these URLs —
 * that needs a real distribution and is called out in docs/IMAGING.md.
 */
function decodeCloudFrontBase64(value: string): Buffer {
    return Buffer.from(value.replaceAll("-", "+").replaceAll("~", "/").replaceAll("_", "="), "base64");
}

describe("imaging content delivery", () => {
    let privateKeyPem: string;
    let publicKeyPem: string;

    beforeAll(() => {
        const pair = generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        privateKeyPem = pair.privateKey;
        publicKeyPem = pair.publicKey;
    });

    describe("OriginStreamContentDelivery (the default — no CDN)", () => {
        it("returns null so routes fall back to streaming through this server", async () => {
            const delivery = new OriginStreamContentDelivery();
            expect(delivery.mode).toBe("origin-stream");
            expect(delivery.signObjectUrl()).toBeNull();
            expect(await delivery.healthCheck()).toBe(true);
        });
    });

    describe("CloudFrontContentDelivery", () => {
        const DOMAIN = "d111111abcdef8.cloudfront.net";
        const KEY_PAIR_ID = "K2JCJMDEHXQW5F"; // gitleaks:allow — AWS's own public docs example key pair id
        const KEY = "org-uuid/study-uuid/series-uuid/instance-uuid.dcm";

        function delivery(now?: () => number) {
            return new CloudFrontContentDelivery(DOMAIN, KEY_PAIR_ID, privateKeyPem, now);
        }

        it("produces a signature that actually verifies against the public key, over the exact policy it published", () => {
            const signed = delivery().signObjectUrl(KEY);
            const url = new URL(signed.url);
            const policyRaw = decodeCloudFrontBase64(url.searchParams.get("Policy")!);
            const signatureRaw = decodeCloudFrontBase64(url.searchParams.get("Signature")!);

            const verifier = createVerify("RSA-SHA1");
            verifier.update(policyRaw);
            expect(verifier.verify(publicKeyPem, signatureRaw)).toBe(true);
        });

        it("binds the signature to one exact object (custom policy), so a leaked URL cannot be replayed against a different instance", () => {
            const signed = delivery().signObjectUrl(KEY);
            const url = new URL(signed.url);
            const policy = JSON.parse(decodeCloudFrontBase64(url.searchParams.get("Policy")!).toString("utf8"));

            expect(policy.Statement).toHaveLength(1);
            expect(policy.Statement[0].Resource).toBe(`https://${DOMAIN}/${KEY}`);
            // Swapping the path while keeping the signature must break the
            // Resource<->signature binding — assert the policy names the
            // original object, which is what CloudFront compares against.
            expect(policy.Statement[0].Resource).not.toContain("other-instance");
        });

        it("expires in 60 seconds by default — far shorter than the 30-minute viewer session that authorized it", () => {
            const fixedNow = 1_800_000_000_000;
            const signed = delivery(() => fixedNow).signObjectUrl(KEY);
            const policy = JSON.parse(decodeCloudFrontBase64(new URL(signed.url).searchParams.get("Policy")!).toString("utf8"));

            const expiry = policy.Statement[0].Condition.DateLessThan["AWS:EpochTime"];
            expect(expiry).toBe(Math.floor(fixedNow / 1000) + DEFAULT_TTL_SECONDS);
            expect(signed.expiresAt).toBe(new Date(expiry * 1000).toISOString());
        });

        it("clamps an absurd requested TTL rather than honoring it", () => {
            const fixedNow = 1_800_000_000_000;
            const signed = delivery(() => fixedNow).signObjectUrl(KEY, 60 * 60 * 24 * 365);
            const policy = JSON.parse(decodeCloudFrontBase64(new URL(signed.url).searchParams.get("Policy")!).toString("utf8"));
            const ttl = policy.Statement[0].Condition.DateLessThan["AWS:EpochTime"] - Math.floor(fixedNow / 1000);
            expect(ttl).toBeLessThanOrEqual(300);
        });

        it("never puts a bucket name, region, AWS credential, or DICOM identifier in the URL host or path", () => {
            const signed = delivery().signObjectUrl(KEY);
            const url = new URL(signed.url);
            expect(url.origin).toBe(`https://${DOMAIN}`);
            // Host + path is what lands in CloudFront/S3 access logs and in
            // a browser's history, so that is what must stay free of bucket
            // names, regions, and credentials. The Policy/Signature params
            // are opaque base64 and can contain any byte sequence by chance,
            // so asserting over the whole URL string would be a flaky test,
            // not a stronger one. The object key itself is entirely opaque
            // UUIDs by construction (dicomweb-adapter.ts's instanceObjectKey).
            expect(`${url.host}${url.pathname}`).not.toMatch(/s3|amazonaws\.com|AKIA|SecretAccess/i);
            // The only query parameters are CloudFront's own three — no
            // bucket path, no credential, and nothing caller-supplied.
            expect([...url.searchParams.keys()].sort()).toEqual(["Key-Pair-Id", "Policy", "Signature"]);
            expect(url.searchParams.get("Key-Pair-Id")).toBe(KEY_PAIR_ID);
        });

        it("keeps key path separators intact while escaping anything else, so CloudFront maps onto the right S3 object", () => {
            const signed = delivery().signObjectUrl("org/study/series/name with space.dcm");
            expect(new URL(signed.url).pathname).toBe("/org/study/series/name%20with%20space.dcm");
        });

        it("accepts a domain given with or without an https:// prefix, and always emits https", () => {
            const withScheme = new CloudFrontContentDelivery(`https://${DOMAIN}`, KEY_PAIR_ID, privateKeyPem).signObjectUrl(KEY);
            const withoutScheme = delivery().signObjectUrl(KEY);
            expect(new URL(withScheme.url).origin).toBe(`https://${DOMAIN}`);
            expect(new URL(withoutScheme.url).origin).toBe(`https://${DOMAIN}`);
        });

        it("fails loudly at construction on a malformed private key, not on a clinician's first image load", () => {
            expect(() => new CloudFrontContentDelivery(DOMAIN, KEY_PAIR_ID, "not-a-pem-key")).toThrow();
            expect(() => new CloudFrontContentDelivery("", KEY_PAIR_ID, privateKeyPem)).toThrow(/domain is required/);
            expect(() => new CloudFrontContentDelivery(DOMAIN, "", privateKeyPem)).toThrow(/key pair id is required/);
        });

        it("healthCheck proves signing capability (a bad key breaks every image load) rather than probing an intentionally-403 endpoint", async () => {
            expect(await delivery().healthCheck()).toBe(true);
        });
    });
});
