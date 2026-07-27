// A minimal stand-in for the parts of the `electron` module this codebase's
// unit-testable logic touches (store modules need `app.getPath`; secrets-store
// needs `safeStorage`). Real Electron can't run inside a plain Node test
// process, so vitest.config.ts aliases all `electron` imports to this file.
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-test-"));

export const app = {
    getPath: (name: string) => {
        if (name === "userData") return tmpUserDataDir;
        return os.tmpdir();
    },
    getVersion: () => "0.0.0-test",
};

// A tagged passthrough "encryption" — good enough to test that secrets-store
// round-trips values through whatever safeStorage provides, without needing
// a real OS credential store in the test environment. The tag matters: real
// safeStorage.decryptString() throws on a buffer it didn't itself produce
// (foreign data, a legacy plaintext value, ciphertext from a different OS
// credential-store identity) — a bare base64 passthrough would happily
// "decrypt" anything, making it impossible to test secrets-store's legacy-
// plaintext-fallback and migration behavior against this mock.
const MOCK_ENCRYPTION_PREFIX = "mock-encrypted:";
export const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(MOCK_ENCRYPTION_PREFIX + value, "utf-8"),
    decryptString: (buf: Buffer) => {
        const text = buf.toString("utf-8");
        if (!text.startsWith(MOCK_ENCRYPTION_PREFIX)) {
            throw new Error("mock safeStorage: buffer wasn't produced by this mock's encryptString");
        }
        return text.slice(MOCK_ENCRYPTION_PREFIX.length);
    },
};
