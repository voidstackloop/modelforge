import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

/**
 * Tenant-isolated storage for immutable DICOM originals and derived
 * artifacts (thumbnails, de-identified copies) — pixel data only, never
 * metadata (that lives in ImagingStore/Postgres). See docs/IMAGING.md.
 *
 * Every key this store is given is expected to already be tenant-prefixed
 * by the caller (server/src/imaging/ingestion.ts): `{organizationId}/...`
 * — this interface does not itself enforce that (it has no concept of
 * "organization"), the same seam boundary as every other swappable backend
 * in this codebase. Never returns or accepts a public/presigned URL —
 * retrieval always streams through this server's own WADO-RS routes,
 * authenticated per request by a viewer session, per item 8's "never
 * expose permanent object URLs."
 */
export interface ImagingObjectStore {
    put(key: string, data: Buffer, contentType: string): Promise<{ checksumSha256: string; sizeBytes: number }>;
    get(key: string): Promise<Buffer>;
    exists(key: string): Promise<boolean>;
    /** Only ever called for quarantine cleanup on ingestion failure —
     * published, immutable originals are never deleted through this
     * method by application code. */
    delete(key: string): Promise<void>;
    healthCheck(): Promise<boolean>;
    /** Performs a real write/read/delete probe. The probe key is random and
     * contains no PHI; callers must surface failures rather than treating a
     * constructor or mock as proof that storage is operational. */
    verifyReadWrite(): Promise<{ write: boolean; read: boolean; delete: boolean; error?: string }>;
}

async function verifyStore(store: ImagingObjectStore): Promise<{ write: boolean; read: boolean; delete: boolean; error?: string }> {
    const key = `.verification/${randomBytes(16).toString("hex")}.bin`;
    const payload = randomBytes(32);
    let write = false;
    let read = false;
    let deleted = false;
    try {
        await store.put(key, payload, "application/octet-stream");
        write = true;
        read = (await store.get(key)).equals(payload);
        await store.delete(key);
        deleted = !(await store.exists(key));
        return { write, read, delete: deleted };
    } catch (error) {
        if (write && !deleted) {
            try { await store.delete(key); } catch { /* best-effort probe cleanup */ }
        }
        return { write, read, delete: deleted, error: error instanceof Error ? error.message : "unknown verification failure" };
    }
}

export function sha256Hex(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

const GCM_AUTH_TAG_LENGTH_BYTES = 16;
const GCM_IV_LENGTH_BYTES = 12;

/**
 * Local filesystem adapter — the safe default when no S3/PACS is
 * configured (local development, and any deployment that intentionally
 * keeps imaging storage on local/attached disk). Every object is
 * AES-256-GCM encrypted at rest with a server-held key (env
 * `IMAGING_ENCRYPTION_KEY`, 32 random bytes base64 — same algorithm and
 * authTagLength-explicit pattern as app/src/case-encryption.ts, kept
 * consistent across this codebase's two independent "encrypt something
 * locally" call sites). This is a *secure* local adapter, not a weaker
 * stand-in: the encryption-at-rest and checksum guarantees are the same
 * shape production gets from S3 SSE-KMS, just with a locally-held key
 * instead of a KMS-managed one — see docs/IMAGING.md's "what AWS
 * integration actually requires" section for the real gap (key rotation,
 * HSM-backed custody, cross-account access control) this does not close.
 */
export class LocalFilesystemImagingObjectStore implements ImagingObjectStore {
    constructor(
        private readonly rootDir: string,
        private readonly encryptionKey: Buffer
    ) {
        if (encryptionKey.length !== 32) throw new Error("IMAGING_ENCRYPTION_KEY must decode to exactly 32 bytes.");
    }

    private resolvePath(key: string): string {
        // Mirrors app/src/case-offline-cache.ts's own path-traversal
        // lesson (a UUID/organizationId-shaped component is not
        // automatically safe to use as a filesystem path segment): reject
        // any key that doesn't stay lexically inside rootDir once resolved.
        const resolved = path.resolve(this.rootDir, key);
        const rel = path.relative(this.rootDir, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`Object key resolves outside the imaging storage root: ${key}`);
        }
        return resolved;
    }

    async put(key: string, data: Buffer, _contentType: string): Promise<{ checksumSha256: string; sizeBytes: number }> {
        const checksumSha256 = sha256Hex(data);
        const iv = randomBytes(GCM_IV_LENGTH_BYTES);
        const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv, { authTagLength: GCM_AUTH_TAG_LENGTH_BYTES });
        const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
        const authTag = cipher.getAuthTag();
        const envelope = Buffer.concat([iv, authTag, ciphertext]);

        const filePath = this.resolvePath(key);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, envelope);
        return { checksumSha256, sizeBytes: data.length };
    }

    async get(key: string): Promise<Buffer> {
        const envelope = await fs.readFile(this.resolvePath(key));
        const iv = envelope.subarray(0, GCM_IV_LENGTH_BYTES);
        const authTag = envelope.subarray(GCM_IV_LENGTH_BYTES, GCM_IV_LENGTH_BYTES + GCM_AUTH_TAG_LENGTH_BYTES);
        const ciphertext = envelope.subarray(GCM_IV_LENGTH_BYTES + GCM_AUTH_TAG_LENGTH_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv, { authTagLength: GCM_AUTH_TAG_LENGTH_BYTES });
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    async exists(key: string): Promise<boolean> {
        try {
            await fs.access(this.resolvePath(key));
            return true;
        } catch {
            return false;
        }
    }

    async delete(key: string): Promise<void> {
        await fs.rm(this.resolvePath(key), { force: true });
    }

    async healthCheck(): Promise<boolean> {
        try {
            await fs.mkdir(this.rootDir, { recursive: true });
            await fs.access(this.rootDir);
            return true;
        } catch {
            return false;
        }
    }

    verifyReadWrite() { return verifyStore(this); }
}

/**
 * AWS S3 adapter — the production object store. SSE-KMS encryption is
 * configured via `kmsKeyId` (passed on every PutObject; the bucket itself
 * should also enforce SSE-KMS via bucket policy as defense in depth, not
 * configured here since bucket policy is an infrastructure/Terraform
 * concern, not application code). **Not exercised against a real AWS
 * account in the environment this was built in** — no AWS credentials or
 * network access exist here. This is the real, production-shaped
 * interface implementation per the task's own instruction to build it
 * even when untestable; server/src/imaging/*.test.ts exercises the
 * *interface* (ImagingObjectStore) against LocalFilesystemImagingObjectStore
 * instead, which is what's actually verified.
 */
export class S3ImagingObjectStore implements ImagingObjectStore {
    private readonly client: S3Client;

    constructor(
        private readonly bucket: string,
        private readonly kmsKeyId: string,
        region: string,
        private readonly keyPrefix: string = ""
    ) {
        this.client = new S3Client({ region });
    }

    private fullKey(key: string): string {
        return this.keyPrefix ? `${this.keyPrefix}/${key}` : key;
    }

    async put(key: string, data: Buffer, contentType: string): Promise<{ checksumSha256: string; sizeBytes: number }> {
        const checksumSha256 = sha256Hex(data);
        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: this.fullKey(key),
                Body: data,
                ContentType: contentType,
                ServerSideEncryption: "aws:kms",
                SSEKMSKeyId: this.kmsKeyId,
                // Integrity check enforced server-side by S3 itself, not just
                // trusted from the client's own checksum computation.
                ChecksumSHA256: Buffer.from(checksumSha256, "hex").toString("base64"),
            })
        );
        return { checksumSha256, sizeBytes: data.length };
    }

    async get(key: string): Promise<Buffer> {
        const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
        const chunks: Buffer[] = [];
        for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks);
    }

    async exists(key: string): Promise<boolean> {
        try {
            await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key), Range: "bytes=0-0" }));
            return true;
        } catch {
            return false;
        }
    }

    async delete(key: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
    }

    async healthCheck(): Promise<boolean> {
        try {
            await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
            return true;
        } catch {
            return false;
        }
    }

    verifyReadWrite() { return verifyStore(this); }
}
