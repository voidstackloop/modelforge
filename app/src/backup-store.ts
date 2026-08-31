import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { app } from "electron";
import * as caseEncryption from "./case-encryption";
import type { EncryptedPayload } from "./case-encryption";
import * as sessionsStore from "./sessions-store";
import * as patientCasesStore from "./patient-cases-store";
import * as policyStore from "./policy-store";

// Encrypted, whole-profile backup and verified restore. This is a
// deliberately separate encryption domain from case-encryption.ts: a backup
// uses its own passphrase, independent of whatever case-encryption
// passphrase is (or isn't) active on this install. Reasons this matters,
// not just a style choice:
//  - A backup taken while case encryption is disabled must still be
//    encrypted by default (a backup file is a more likely leak vector than
//    the live install — it gets copied to external drives, cloud-synced
//    folders, etc.).
//  - If backups reused the live case-encryption key, rotating that
//    passphrase later would leave old backups keyed to a passphrase the
//    user might no longer remember, with no separate backup passphrase to
//    fall back on.
// The crypto primitives (scrypt key derivation, AES-256-GCM, HMAC verifier)
// mirror case-encryption.ts's own design exactly — same algorithm choices,
// independent state — reusing its exported encrypt()/decrypt() functions
// directly rather than reimplementing AES-GCM, but deriving and storing an
// entirely separate salt/verifier/key.

const SCRYPT_KEY_LEN = 32; // AES-256
const BACKUP_VERIFIER_MESSAGE = "modelforge-medical-backup-verifier";
const BACKUP_ENVELOPE_MARKER = "modelforge-backup-v1";
// Version 1 stored each file's raw bytes, base64-encoded, with no
// compression. Version 2 gzips each file's raw bytes *before*
// base64-encoding (order matters: gzipping already-base64'd text barely
// compresses, since base64 turns binary into semi-random-looking ASCII —
// compressing the real bytes first, then applying the 1.33x base64
// overhead only to the now-smaller result, is what actually shrinks
// backups). decryptAndValidate() still reads version-1 manifests directly
// (no decompression) so backups made before this change keep restoring.
const BACKUP_FORMAT_VERSION = 2;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return crypto.scryptSync(passphrase, salt, SCRYPT_KEY_LEN);
}

function computeVerifier(key: Buffer): string {
    return crypto.createHmac("sha256", key).update(BACKUP_VERIFIER_MESSAGE).digest("hex");
}

function sha256Hex(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

// --- What gets backed up -----------------------------------------------
//
// Every top-level file this app persists to userData, enumerated by reading
// every *-store.ts module's own file path (not guessed) — see the session
// this was built in for the exact grep. Deliberately excluded:
//  - secrets.json: OS-keychain-encrypted (Electron safeStorage) and tied to
//    this specific device/OS-user account — the ciphertext isn't portable
//    to a different machine, and what it protects (provider API keys) is
//    neither PHI nor hard to re-enter. Including it would create a false
//    expectation that restoring a backup elsewhere restores API access.
//  - logs/, benchmarks/, python-runtimes/, llamacpp-models/: operational
//    caches/logs or re-downloadable runtime assets, not irreplaceable user
//    data — restoring old logs over current ones would also be actively
//    wrong, not just unnecessary.
//
// Entries are "optional" (missing is normal, e.g. patient-cases.json only
// exists once a case is created; the .enc.json counterpart only exists when
// case encryption is enabled) — createBackup skips whatever isn't present
// rather than failing.
const BACKUP_FILES = [
    "settings.json",
    "sessions.json",
    "sessions.enc.json",
    "patient-cases.json",
    "patient-cases.enc.json",
    "case-encryption-config.json",
    "projects.json",
    "model-registry.json",
    "evidence-sources.json",
    "energy-usage.json",
    "scheduled-tasks.json",
    "download-jobs.json",
    "audit-log.json",
    "audit-log.sqlite3",
    "audit-log.sqlite3-wal",
    "audit-log.sqlite3-shm",
    "rag.db",
    "policy-cache.json",
] as const;

// sessions.json/.enc.json and patient-cases.json/.enc.json are mutually
// exclusive in normal operation (case-encryption.ts's stores remove the
// counterpart on every write — see sessions-store.ts's removeIfExists). A
// restore must preserve that invariant: if a backup taken while encryption
// was OFF gets restored onto a device currently running WITH encryption
// enabled (or vice versa), leaving the stale counterpart file behind would
// create exactly the "which file is authoritative" ambiguity that
// removeIfExists exists to prevent during normal writes.
const EXCLUSIVE_PAIRS: readonly (readonly [string, string])[] = [
    ["sessions.json", "sessions.enc.json"],
    ["patient-cases.json", "patient-cases.enc.json"],
];

interface BackupFileEntry {
    name: string;
    sha256Hex: string;
    sizeBytes: number;
    contentBase64: string;
}

interface BackupManifest {
    // 1 = raw base64, no compression (kept readable for backups made before
    // compression existed). 2 = gzip-then-base64 per file (current).
    version: 1 | 2;
    createdAt: string;
    appVersion: string;
    files: BackupFileEntry[];
}

interface BackupEnvelope {
    modelforge: typeof BACKUP_ENVELOPE_MARKER;
    saltHex: string;
    verifierHex: string;
    payload: EncryptedPayload;
}

function isBackupEnvelope(value: unknown): value is BackupEnvelope {
    return !!value && typeof value === "object" && (value as { modelforge?: unknown }).modelforge === BACKUP_ENVELOPE_MARKER;
}

/** Thrown when a backup file can't be read back — wrong passphrase (the
 * verifier catches this before ever attempting decryption) or an envelope
 * that isn't recognized as a ModelForge backup at all. Never collapses into
 * "0 files restored" — that would look identical to "this backup was
 * empty," a very different and far less alarming situation. */
export class BackupUnreadableError extends Error {
    constructor(reason: string) {
        super(`This backup could not be read: ${reason}`);
        this.name = "BackupUnreadableError";
    }
}

/** Thrown when a decrypted backup's structure or checksums don't check out
 * — a truncated write, a corrupted copy, or a tampered file. Distinguished
 * from BackupUnreadableError (wrong passphrase / not a backup at all)
 * because the remediation is different: a wrong passphrase means try again;
 * a corrupt backup means try an older one. */
export class BackupCorruptError extends Error {
    constructor(reason: string) {
        super(`This backup's contents are corrupted: ${reason}`);
        this.name = "BackupCorruptError";
    }
}

function userDataPath(name: string): string {
    return path.join(app.getPath("userData"), name);
}

function readFileIfExists(filePath: string): Buffer | null {
    try {
        return fs.readFileSync(filePath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}

/** Builds the manifest from whatever BACKUP_FILES currently exist on disk —
 * pure, no encryption, exported for the verify/restore paths (and tests) to
 * reuse without duplicating the file-collection logic. sha256Hex/sizeBytes
 * describe the original (uncompressed) content — that's what checksums
 * must protect, since that's what ends up back on disk on restore.
 * contentBase64 holds the gzip-compressed bytes. */
function collectManifest(): BackupManifest {
    const files: BackupFileEntry[] = [];
    for (const name of BACKUP_FILES) {
        const content = readFileIfExists(userDataPath(name));
        if (content === null) continue;
        files.push({
            name,
            sha256Hex: sha256Hex(content),
            sizeBytes: content.length,
            contentBase64: zlib.gzipSync(content).toString("base64"),
        });
    }
    return { version: BACKUP_FORMAT_VERSION, createdAt: new Date().toISOString(), appVersion: app.getVersion(), files };
}

/** Creates an encrypted backup of every currently-present file in
 * BACKUP_FILES, returning the serialized envelope for the caller to write
 * wherever it chooses (the IPC handler drives this through a save dialog,
 * matching data-transfer.ts's existing export pattern). Never touches any
 * live file — purely additive, read-only against the current profile. */
export function createBackup(passphrase: string): string {
    const manifest = collectManifest();
    const salt = crypto.randomBytes(16);
    const key = deriveKey(passphrase, salt);
    const envelope: BackupEnvelope = {
        modelforge: BACKUP_ENVELOPE_MARKER,
        saltHex: salt.toString("hex"),
        verifierHex: computeVerifier(key),
        payload: caseEncryption.encrypt(JSON.stringify(manifest), key),
    };
    return JSON.stringify(envelope);
}

/** Decrypts and validates a backup's structure/checksums without touching
 * any live file — the dry-run path both verifyBackup() and restoreBackup()
 * share, so "check this backup is good" never has a different code path
 * (and therefore different bugs) than the check restore performs on itself
 * before touching anything. */
function decryptAndValidate(passphrase: string, backupJson: string): BackupManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(backupJson);
    } catch {
        throw new BackupUnreadableError("the file is not valid JSON");
    }
    if (!isBackupEnvelope(parsed)) throw new BackupUnreadableError("this file is not a ModelForge backup");

    const key = deriveKey(passphrase, Buffer.from(parsed.saltHex, "hex"));
    if (!crypto.timingSafeEqual(Buffer.from(computeVerifier(key), "hex"), Buffer.from(parsed.verifierHex, "hex"))) {
        throw new BackupUnreadableError("incorrect passphrase");
    }

    let decrypted: string;
    try {
        decrypted = caseEncryption.decrypt(parsed.payload, key);
    } catch {
        // The verifier already confirmed the passphrase is right, so a
        // decrypt failure here means the ciphertext itself is damaged (the
        // GCM auth tag catches tampering/corruption independently of the
        // verifier check above).
        throw new BackupCorruptError("the encrypted contents failed integrity verification");
    }

    let manifest: BackupManifest;
    try {
        manifest = JSON.parse(decrypted) as BackupManifest;
    } catch {
        throw new BackupCorruptError("decrypted contents are not valid JSON");
    }
    if ((manifest.version !== 1 && manifest.version !== 2) || !Array.isArray(manifest.files)) {
        throw new BackupCorruptError(`unrecognized backup format (expected version 1 or 2, got ${(manifest as { version?: unknown }).version})`);
    }
    for (const file of manifest.files) {
        // Defense in depth, not a normal-path concern: createBackup() only
        // ever writes names from the fixed BACKUP_FILES list, so a
        // legitimate backup never contains anything else. This rejects any
        // other name outright — a path-traversal-shaped name ("../../etc"),
        // a name from a newer app version this build doesn't recognize, or
        // a hand-edited file — *before* restoreBackup ever turns `name`
        // into a filesystem path, rather than trusting decrypted content to
        // already be safe just because the passphrase was correct.
        if (!(BACKUP_FILES as readonly string[]).includes(file.name)) {
            throw new BackupCorruptError(`unrecognized file "${file.name}" in backup manifest`);
        }
        const stored = Buffer.from(file.contentBase64, "base64");
        let content: Buffer;
        if (manifest.version === 2) {
            try {
                content = zlib.gunzipSync(stored);
            } catch {
                throw new BackupCorruptError(`"${file.name}" failed to decompress — the backup file may be truncated or damaged`);
            }
        } else {
            content = stored;
        }
        if (content.length !== file.sizeBytes || sha256Hex(content) !== file.sha256Hex) {
            throw new BackupCorruptError(`checksum mismatch for "${file.name}" — the backup file may be truncated or damaged`);
        }
        // Normalize to plain (uncompressed) base64 so every downstream
        // consumer (restoreBackup's staging writes, verifyBackup's summary)
        // works with decoded bytes without needing to know the manifest's
        // version — decompression is fully handled here, once.
        file.contentBase64 = content.toString("base64");
    }
    return manifest;
}

export interface BackupSummary {
    createdAt: string;
    appVersion: string;
    fileNames: string[];
}

/** Read-only check: does this passphrase open this backup, and is its
 * content internally consistent? Used by the UI to preview a backup (name,
 * date, file count) before committing to a restore. */
export function verifyBackup(passphrase: string, backupJson: string): BackupSummary {
    const manifest = decryptAndValidate(passphrase, backupJson);
    return { createdAt: manifest.createdAt, appVersion: manifest.appVersion, fileNames: manifest.files.map((f) => f.name) };
}

export interface RestoreResult {
    filesRestored: string[];
    safetySnapshotPath: string;
}

/**
 * Restores every file in a backup onto this profile, in three phases so a
 * failure at any point leaves either the original state or the fully
 * restored state — never something in between:
 *
 *  1. Decrypt and validate the backup (decryptAndValidate) — nothing on
 *     disk is touched yet, so a wrong passphrase or corrupt backup fails
 *     here with zero side effects.
 *  2. Take an automatic safety snapshot of the *current* live state
 *     (createBackup(), written to a fixed local path) — encrypted with the
 *     same passphrase just used for restore, since the user already holds
 *     it and this isn't a new secret to remember. This is what makes a
 *     restore reversible: if the restored data turns out to be wrong (an
 *     old backup selected by mistake, e.g.), the safety snapshot can be
 *     restored right back.
 *  3. Write every restored file into a staging directory, verify each one
 *     lands correctly, then move them into place one at a time. Encrypted-
 *     vs-plaintext counterpart files (EXCLUSIVE_PAIRS) are removed first so
 *     a restore can never leave both sides of a pair on disk at once.
 *
 * Throws (never partially applies) if decrypt/validate fails. Once phase 3
 * begins, individual file writes use the same rename-based atomic pattern
 * as json-store.ts's writeJson, so an interruption mid-restore leaves
 * whichever files had already been moved into place — not a half-written
 * file for the one in progress.
 */
export function restoreBackup(passphrase: string, backupJson: string): RestoreResult {
    const manifest = decryptAndValidate(passphrase, backupJson);

    // Phase 2: safety snapshot of current state, before anything is touched.
    const safetyDir = path.join(app.getPath("userData"), "backups");
    fs.mkdirSync(safetyDir, { recursive: true });
    const safetySnapshotPath = path.join(safetyDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.mfbackup`);
    fs.writeFileSync(safetySnapshotPath, createBackup(passphrase));

    // Phase 3a: stage every restored file in a temp dir, verifying each
    // write actually round-trips before touching any live file.
    const restoredNames = new Set(manifest.files.map((f) => f.name));
    const stagingDir = fs.mkdtempSync(path.join(app.getPath("userData"), ".restore-staging-"));
    try {
        for (const file of manifest.files) {
            const content = Buffer.from(file.contentBase64, "base64");
            const stagedPath = path.join(stagingDir, file.name);
            fs.writeFileSync(stagedPath, content);
            if (!fs.readFileSync(stagedPath).equals(content)) {
                throw new BackupCorruptError(`staged write for "${file.name}" did not verify — aborting restore, no live file was touched`);
            }
        }

        // Phase 3b: remove stale counterparts, then move staged files into
        // place. Both steps are per-file rename/unlink operations — no
        // single-file failure here can corrupt a file that isn't the one
        // being touched at that instant.
        for (const [a, b] of EXCLUSIVE_PAIRS) {
            if (restoredNames.has(a) || restoredNames.has(b)) {
                fs.rmSync(userDataPath(a), { force: true });
                fs.rmSync(userDataPath(b), { force: true });
            }
        }
        for (const file of manifest.files) {
            fs.renameSync(path.join(stagingDir, file.name), userDataPath(file.name));
        }
    } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    // sessions-store.ts and patient-cases-store.ts each keep an in-process
    // read cache of their decrypted contents (built to avoid redundant
    // reads on every settings/session access — see their own doc comments).
    // Every normal write goes through those stores' own writeAll(), which
    // keeps the cache in sync automatically; restore bypasses writeAll()
    // entirely (it writes sessions.json/patient-cases.json directly), so
    // without this, a store would keep serving pre-restore data from memory
    // until something else happened to invalidate it — the exact "silently
    // stale after restore" failure mode this whole function exists to avoid.
    if (restoredNames.has("case-encryption-config.json")) {
        // The restored config may carry a different salt/verifier than
        // whatever key is currently held in memory (e.g. this backup
        // predates a since-rotated passphrase) — lock() is the correct,
        // safe response: it clears the now-possibly-invalid session key
        // *and* runs case-encryption.ts's onBeforeLock hooks, which already
        // clear both stores' caches for us. The user re-enters whichever
        // passphrase matches the just-restored config to unlock again.
        caseEncryption.lock();
    } else {
        // Encryption config didn't change, but sessions.json/
        // patient-cases.json content may have — clear the caches directly
        // without forcing an unnecessary re-lock.
        sessionsStore.clearCache();
        patientCasesStore.clearCache();
    }
    // policy-cache.json (if restored) may now hold a different last-known-
    // good policy than what was in memory — force the next read to notice.
    policyStore.reloadPolicy();

    return { filesRestored: manifest.files.map((f) => f.name), safetySnapshotPath };
}
