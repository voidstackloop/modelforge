import * as path from "node:path";
import { app, safeStorage } from "electron";
import { readJson, writeJson } from "./json-store";
import { logger } from "./logger";

function filePath(): string {
    return path.join(app.getPath("userData"), "secrets.json");
}

function readAll(): Record<string, string> {
    return readJson<Record<string, string>>(filePath(), {});
}

function writeAll(data: Record<string, string>): void {
    writeJson(filePath(), data);
}

// Exposed so callers (and Settings UI) can warn the user before a key ends
// up unencrypted, rather than only finding out after the fact.
export function isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
}

// Environments without an OS credential store (e.g. some Linux setups with no
// keyring) can't use safeStorage at all. We still allow storing the key there
// rather than silently dropping it or hard-blocking the feature, but this is
// no longer a silent fallback: it's logged at warn level (surfaced in Settings
// -> Diagnostics -> Copy diagnostic info) and the Settings UI checks
// isEncryptionAvailable() up front to show a plaintext-storage warning next to
// every API key field instead of the normal "encrypted at rest" note.
export function setSecret(key: string, value: string): void {
    const all = readAll();
    if (!value) {
        delete all[key];
    } else if (safeStorage.isEncryptionAvailable()) {
        all[key] = safeStorage.encryptString(value).toString("base64");
    } else {
        logger.warn(`No OS credential store available; storing secret "${key}" unencrypted in secrets.json`);
        all[key] = value;
    }
    writeAll(all);
}

export function getSecret(key: string): string | null {
    const stored = readAll()[key];
    if (!stored) return null;
    if (safeStorage.isEncryptionAvailable()) {
        try {
            return safeStorage.decryptString(Buffer.from(stored, "base64"));
        } catch {
            // Might be a plaintext fallback value written when encryption was unavailable.
            return stored;
        }
    }
    return stored;
}

export function hasSecret(key: string): boolean {
    return !!readAll()[key];
}
