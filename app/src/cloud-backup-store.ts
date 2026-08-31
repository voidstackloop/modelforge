import * as path from "node:path";
import { app } from "electron";
import { AwsClient } from "aws4fetch";
import { readJson, writeJson } from "./json-store";
import * as secretsStore from "./secrets-store";

// Optional secondary backup destination: any S3-compatible object store
// (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, DigitalOcean
// Spaces, ...) identified by an endpoint URL rather than a specific
// provider's SDK/OAuth flow — the same "bring your own credentials"
// pattern already used for LLM provider API keys, just pointed at object
// storage instead. Non-secret config lives in cloud-backup.json (its own
// file, not part of backup-store.ts's BACKUP_FILES — device-tied
// destination config, same rationale as secrets.json's exclusion). The
// secret access key goes through secrets-store.ts exactly like a provider
// API key (OS keychain via Electron safeStorage where available).

export interface CloudBackupConfig {
    enabled: boolean;
    endpoint: string; // e.g. "https://s3.us-west-2.amazonaws.com" or "https://<accountid>.r2.cloudflarestorage.com"
    region: string;
    bucket: string;
    accessKeyId: string;
    // Path-style (endpoint/bucket/key) vs virtual-hosted (bucket.endpoint/key)
    // addressing — providers differ on which they support/require.
    pathStyle: boolean;
}

const DEFAULT_CONFIG: CloudBackupConfig = {
    enabled: false,
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    accessKeyId: "",
    pathStyle: false,
};

const CLOUD_SECRET_KEY = "backup.cloud.secretAccessKey";

function filePath(): string {
    return path.join(app.getPath("userData"), "cloud-backup.json");
}

export function getConfig(): CloudBackupConfig {
    return readJson<CloudBackupConfig>(filePath(), DEFAULT_CONFIG);
}

export function updateConfig(partial: Partial<CloudBackupConfig>): CloudBackupConfig {
    const next = { ...getConfig(), ...partial };
    writeJson(filePath(), next);
    return next;
}

export function setSecretAccessKey(value: string): void {
    secretsStore.setSecret(CLOUD_SECRET_KEY, value);
}

export function hasSecretAccessKey(): boolean {
    return secretsStore.hasSecret(CLOUD_SECRET_KEY);
}

export function clearSecretAccessKey(): void {
    secretsStore.setSecret(CLOUD_SECRET_KEY, "");
}

function buildObjectUrl(cfg: CloudBackupConfig, key: string): string {
    const url = new URL(cfg.endpoint);
    if (cfg.pathStyle) {
        url.pathname = `/${cfg.bucket}/${encodeURIComponent(key)}`;
    } else {
        url.hostname = `${cfg.bucket}.${url.hostname}`;
        url.pathname = `/${encodeURIComponent(key)}`;
    }
    return url.toString();
}

/** S3-compatible error responses are XML — pull out <Message> for a
 * readable error rather than surfacing raw XML to the user; falls back to
 * the HTTP status text if the body doesn't parse as expected. */
function extractErrorMessage(bodyText: string, fallback: string): string {
    const match = /<Message>([^<]*)<\/Message>/i.exec(bodyText);
    return match ? match[1] : fallback;
}

function requireClient(cfg: CloudBackupConfig): AwsClient {
    const secretAccessKey = secretsStore.getSecret(CLOUD_SECRET_KEY);
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !secretAccessKey) {
        throw new Error("Cloud backup destination is not fully configured (endpoint, bucket, access key, and secret key are all required)");
    }
    return new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey, region: cfg.region || "us-east-1", service: "s3" });
}

/** Uploads an already-encrypted backup envelope (backupStore.createBackup's
 * output) to the configured bucket under `filename`. Throws with a
 * readable message on any non-2xx response — callers (backup-scheduler.ts)
 * catch this as a best-effort secondary step, never letting a cloud
 * failure affect the local backup that already succeeded. */
export async function uploadBackup(envelope: string, filename: string): Promise<void> {
    const cfg = getConfig();
    const client = requireClient(cfg);
    const response = await client.fetch(buildObjectUrl(cfg, filename), {
        method: "PUT",
        body: envelope,
        headers: { "content-type": "application/octet-stream" },
    });
    if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Cloud upload failed (${response.status}): ${extractErrorMessage(bodyText, response.statusText)}`);
    }
}

/** Round-trips a tiny test object (PUT then DELETE) so "Test connection"
 * verifies the exact operation real backups need (PutObject), rather than
 * a bucket-level HEAD that may need different permissions than upload
 * itself does. Throws with a readable message on failure. */
export async function testConnection(): Promise<void> {
    const cfg = getConfig();
    const client = requireClient(cfg);
    const testKey = `.modelforge-connection-test-${Date.now()}`;
    const putResponse = await client.fetch(buildObjectUrl(cfg, testKey), {
        method: "PUT",
        body: "modelforge connection test",
        headers: { "content-type": "text/plain" },
    });
    if (!putResponse.ok) {
        const bodyText = await putResponse.text().catch(() => "");
        throw new Error(`Connection test failed (${putResponse.status}): ${extractErrorMessage(bodyText, putResponse.statusText)}`);
    }
    // Cleanup is best-effort — a failed delete of the test object shouldn't
    // report the connection test itself as failed.
    await client.fetch(buildObjectUrl(cfg, testKey), { method: "DELETE" }).catch(() => {});
}
