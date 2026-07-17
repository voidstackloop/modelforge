import * as fs from "node:fs";
import * as path from "node:path";
import { app, safeStorage } from "electron";

function filePath(): string {
    return path.join(app.getPath("userData"), "secrets.json");
}

function readAll(): Record<string, string> {
    try {
        return JSON.parse(fs.readFileSync(filePath(), "utf-8"));
    } catch {
        return {};
    }
}

function writeAll(data: Record<string, string>): void {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(data, null, 2));
}

export function setSecret(key: string, value: string): void {
    const all = readAll();
    if (!value) {
        delete all[key];
    } else if (safeStorage.isEncryptionAvailable()) {
        all[key] = safeStorage.encryptString(value).toString("base64");
    } else {
        // Fallback for environments without an OS credential store (e.g. some
        // Linux setups with no keyring). Better to work than to silently drop the key.
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
