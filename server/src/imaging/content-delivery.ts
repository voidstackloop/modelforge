import { createSign, createPrivateKey, type KeyObject } from "node:crypto";

/**
 * Content delivery for imaging pixel data (item 19's "lazy-load series and
 * frames" / item 23's "large-study streaming" at real study sizes).
 *
 * ## Why this abstraction exists
 *
 * Every other imaging route in this codebase streams bytes *through* this
 * Fastify process, authorized per request by a viewer session
 * (routes/imaging-dicomweb.ts). That is the correct default and stays the
 * default. It does not scale to real diagnostic imaging: a single CT or MR
 * study is routinely 100 MB - 2 GB across hundreds of instances, and an
 * OHIF viewer lazily fetches them in parallel as the user scrolls. Pulling
 * all of that through one Node process is both a throughput bottleneck and
 * a denial-of-service surface (item 22's "concurrent resource exhaustion").
 *
 * CloudFront in front of the S3 imaging bucket solves that — but only if it
 * is introduced without weakening the authorization model. The rules this
 * implementation holds to:
 *
 *  1. **Authorize first, sign second.** A delivery URL is only ever minted
 *     *after* the same viewer-session scope check that guards the
 *     proxy path (see routes/imaging-dicomweb.ts). This module has no
 *     concept of a caller and cannot authorize anything itself; it is a
 *     pure signer, reached only from an already-authorized code path.
 *  2. **Never a permanent URL.** Signatures are bound to one exact object
 *     path and expire in `DEFAULT_TTL_SECONDS` (60s), far shorter than the
 *     30-minute viewer session that authorized them. Item 8's "never expose
 *     permanent object URLs, credentials, or bucket paths" is satisfied by
 *     the TTL plus the fact that the S3 bucket itself stays private behind
 *     CloudFront Origin Access Control — the client never learns a bucket
 *     name, a region, or an AWS credential.
 *  3. **No PHI or DICOM identifiers in the path.** CloudFront access logs
 *     record the full request path. Object keys are therefore built
 *     entirely from server-generated opaque UUIDs (see
 *     dicomweb-adapter.ts's instanceObjectKey) — no SOPInstanceUID, no
 *     accession number, no patient identifier ever appears in a URL, a
 *     CloudFront log line, or an S3 access log line.
 *  4. **Off by default.** `OriginStreamContentDelivery` is what runs unless
 *     a deployment explicitly configures CloudFront, and it returns `null`
 *     from `signObjectUrl`, which routes read as "stream it yourself." A
 *     misconfiguration degrades to the safe path, never to an open one.
 *
 * ## On RSA-SHA1
 *
 * CloudFront's signed-URL protocol mandates RSA-SHA1; it is not a choice
 * this code makes and cannot be substituted with SHA-256 (CloudFront would
 * reject the signature). The security of the scheme does not rest on SHA-1
 * collision resistance here: the signer is the only party producing
 * policies, the policy is fully server-controlled, and the window is 60
 * seconds. Documented explicitly so a future reader does not mistake it for
 * an oversight — see docs/IMAGING.md's threat-model section.
 */

export interface SignedDeliveryUrl {
    url: string;
    expiresAt: string;
}

export interface ImagingContentDelivery {
    readonly mode: "origin-stream" | "cloudfront";
    /**
     * Returns a short-lived, single-object delivery URL, or `null` when this
     * deployment has no CDN configured — in which case the caller streams
     * the bytes through the origin instead (the default).
     *
     * `objectStorageKey` must already be the opaque, tenant-prefixed key
     * produced by the object store; this method never constructs keys and
     * never inspects them for meaning.
     */
    signObjectUrl(objectStorageKey: string, ttlSeconds?: number): SignedDeliveryUrl | null;
    healthCheck(): Promise<boolean>;
}

/** The default: no CDN. Every byte streams through this server's own
 * authenticated WADO route, exactly as it did before CloudFront support
 * existed. */
export class OriginStreamContentDelivery implements ImagingContentDelivery {
    readonly mode = "origin-stream" as const;
    signObjectUrl(): null {
        return null;
    }
    async healthCheck(): Promise<boolean> {
        return true;
    }
}

/** 60 seconds — long enough for a viewer to start the fetch, short enough
 * that a leaked URL (a screenshot, a copied devtools network entry, a
 * proxy log) is worthless almost immediately. Deliberately decoupled from
 * the 30-minute viewer session: the session is revocable server-side, a
 * signed URL is not, so it gets the much tighter bound. */
export const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;

/** CloudFront's base64 variant for policy/signature query parameters. */
function cloudFrontBase64(input: Buffer): string {
    return input.toString("base64").replaceAll("+", "-").replaceAll("/", "~").replaceAll("=", "_");
}

export class CloudFrontContentDelivery implements ImagingContentDelivery {
    readonly mode = "cloudfront" as const;
    private readonly privateKey: KeyObject;
    private readonly baseUrl: string;

    constructor(
        distributionDomain: string,
        private readonly keyPairId: string,
        privateKeyPem: string,
        private readonly now: () => number = Date.now
    ) {
        if (!distributionDomain) throw new Error("CloudFront distribution domain is required.");
        if (!keyPairId) throw new Error("CloudFront key pair id is required.");
        // Fail at construction, not at first request: a malformed key would
        // otherwise surface as a runtime 500 on a clinician's first image
        // load rather than as a startup failure an operator sees immediately.
        this.privateKey = createPrivateKey(privateKeyPem);
        const normalized = distributionDomain.replace(/\/+$/, "");
        this.baseUrl = normalized.startsWith("https://") ? normalized : `https://${normalized}`;
        if (!this.baseUrl.startsWith("https://")) {
            throw new Error("CloudFront distribution domain must be HTTPS — imaging responses carry PHI.");
        }
    }

    signObjectUrl(objectStorageKey: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): SignedDeliveryUrl {
        const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_TTL_SECONDS);
        const expiresEpochSeconds = Math.floor(this.now() / 1000) + ttl;

        // Each path segment is encoded individually: the key's own "/"
        // separators must stay real path separators for CloudFront to map
        // them onto the S3 object, while any other character is escaped.
        const encodedKey = objectStorageKey.split("/").map(encodeURIComponent).join("/");
        const resource = `${this.baseUrl}/${encodedKey}`;

        // Custom policy (not canned): a canned policy can only express an
        // expiry, while this binds the signature to this exact resource
        // path. A signature that leaked could then never be replayed
        // against a *different* object, only against this one, and only
        // until it expires.
        const policy = JSON.stringify({
            Statement: [{ Resource: resource, Condition: { DateLessThan: { "AWS:EpochTime": expiresEpochSeconds } } }],
        });

        const signer = createSign("RSA-SHA1"); // mandated by CloudFront — see this module's doc comment
        signer.update(policy, "utf8");
        const signature = signer.sign(this.privateKey);

        // Built by hand rather than with URLSearchParams: CloudFront expects
        // its own base64 alphabet verbatim, and percent-encoding the "~"
        // that alphabet uses would invalidate the signature.
        const params = [
            `Policy=${cloudFrontBase64(Buffer.from(policy, "utf8"))}`,
            `Signature=${cloudFrontBase64(signature)}`,
            `Key-Pair-Id=${encodeURIComponent(this.keyPairId)}`,
        ];

        return {
            url: `${resource}?${params.join("&")}`,
            expiresAt: new Date(expiresEpochSeconds * 1000).toISOString(),
        };
    }

    /** There is no useful unauthenticated probe of a private CloudFront
     * distribution — an unsigned request correctly returns 403, which
     * proves the distribution is reachable and locked down but cannot be
     * distinguished from a misconfiguration without signing. Signing
     * capability is what actually matters operationally (a bad key means
     * every image load fails), so that is what this verifies. */
    async healthCheck(): Promise<boolean> {
        try {
            const probe = this.signObjectUrl(".verification/healthcheck", 1);
            return probe.url.includes("Signature=") && probe.url.includes("Key-Pair-Id=");
        } catch {
            return false;
        }
    }
}
