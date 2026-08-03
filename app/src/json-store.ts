import * as fs from "node:fs";
import * as path from "node:path";
import type { z } from "zod";
import { logger } from "./logger";
import { formatZodError } from "./schemas";
import { readJsonFileNative, writeJsonFileAtomicNative } from "./native-datastore";

// Shared persistence helpers for the small JSON "database" files this app
// keeps in userData (sessions/projects/settings/secrets).
//
// Two failure modes matter here:
//  - A crash or power loss mid-write leaving a half-written file. writeJson
//    guards against this by writing to a temp file and renaming over the
//    real one — a rename is atomic on both Windows and POSIX filesystems,
//    so readers never see a partial write.
//  - A file that's already corrupted (e.g. from before this fix, or from
//    a bug, or from manual editing). readJson used to just swallow the
//    parse error and silently return the fallback — which means the very
//    next write would overwrite the corrupted file with a blank slate,
//    permanently destroying whatever data was still recoverable. Instead
//    we back the bad file up next to itself so the user (or support) can
//    recover it, and log what happened.

// Shared by readJson and readJsonWithSchema for the "this file can't be used
// as-is" path — corrupted JSON and JSON that parses fine but doesn't match
// the expected shape (a hand-edited or bug-written settings/secrets file)
// both get the same treatment: back up next to the original so the content
// isn't silently lost, log what happened, and hand back the fallback so the
// next write doesn't overwrite the backup.
function backUpAndFallBack<T>(filePath: string, reason: string, fallback: T): T {
    logger.error(`${reason} in ${filePath}, backing up and resetting`);
    try {
        fs.copyFileSync(filePath, `${filePath}.corrupted-${Date.now()}`);
    } catch (backupErr) {
        logger.error(`Failed to back up corrupted file ${filePath}: ${(backupErr as Error).message}`);
    }
    return fallback;
}

// Tries the Rust addon first (see native-datastore.ts) — `undefined` means
// it isn't available at all (fall back to plain `fs`), `null` means it ran
// and the file doesn't exist (same as `fs`'s ENOENT), and a thrown error
// means it ran and hit a genuine I/O failure other than "missing", which is
// left to fall through to the `fs` attempt below so the exact same error
// gets logged with the exact same wording as before this addon existed.
function readFileRaw(filePath: string): string | null {
    try {
        const native = readJsonFileNative(filePath);
        if (native !== undefined) return native;
    } catch {
        // Fall through to the fs.readFileSync path below.
    }

    try {
        return fs.readFileSync(filePath, "utf-8");
    } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== "ENOENT") {
            logger.error(`Failed to read ${filePath}: ${nodeErr.message}`);
        }
        return null;
    }
}

export function readJson<T>(filePath: string, fallback: T): T {
    const raw = readFileRaw(filePath);
    if (raw === null) return fallback;

    restrictExistingPermissions(filePath);

    try {
        return JSON.parse(raw) as T;
    } catch (err) {
        return backUpAndFallBack(filePath, `Corrupted JSON (${(err as Error).message})`, fallback);
    }
}

// Same read-and-recover behavior as readJson, plus a runtime shape check —
// TypeScript's `readJson<T>(...)` cast is compile-time only, so a file that
// is valid JSON but not a valid T (hand-edited, corrupted-but-still-parses,
// written by a future/older build with an incompatible shape) would
// otherwise flow straight through as if it were trusted data. Malformed
// input here gets the exact same backup-and-fallback treatment as a parse
// failure, rather than handing the caller something that merely happens to
// satisfy a cast.
export function readJsonWithSchema<T>(filePath: string, fallback: T, schema: z.ZodType<T>): T {
    const raw = readFileRaw(filePath);
    if (raw === null) return fallback;

    restrictExistingPermissions(filePath);

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return backUpAndFallBack(filePath, `Corrupted JSON (${(err as Error).message})`, fallback);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
        return backUpAndFallBack(filePath, `JSON doesn't match the expected shape (${formatZodError(result.error)})`, fallback);
    }
    return result.data;
}

// These files hold provider API keys (secrets.json) and full conversation
// history. Written with the process umask they land as 0644 — or 0664 under
// the umask 002 several distributions ship — leaving their contents readable
// to anything that reaches them: another account on a shared machine, a
// backup or sync tool, an archive unpacked somewhere else. The userData
// directory is usually restrictive enough to cover that on a single-user
// desktop, but a stored credential shouldn't depend on its parent directory's
// mode.
const PRIVATE_FILE_MODE = 0o600;

// Files written before this existed keep the mode they were created with, and
// writeJson alone would never reach them: a key set once and never changed is
// only ever read. So the mode is also tightened on first read, once per path
// per run to keep it off the hot path.
const permissionsChecked = new Set<string>();

function restrictExistingPermissions(filePath: string): void {
    if (process.platform === "win32" || permissionsChecked.has(filePath)) return;
    permissionsChecked.add(filePath);
    try {
        if ((fs.statSync(filePath).mode & 0o777) !== PRIVATE_FILE_MODE) {
            fs.chmodSync(filePath, PRIVATE_FILE_MODE);
        }
    } catch (err) {
        // Best effort — unusual ownership or an exotic filesystem must not
        // stop the app from reading its own data.
        logger.error(`Failed to restrict permissions on ${filePath}: ${(err as Error).message}`);
    }
}

export function writeJson(filePath: string, data: unknown): void {
    const content = JSON.stringify(data, null, 2);

    // Tries the Rust addon first (same temp-file-then-rename, same private
    // file mode — see datastore::write_json_file_atomic). A thrown error
    // here is a genuine I/O failure the addon hit; fall through to the pure
    // Node path below rather than losing the write entirely.
    try {
        if (writeJsonFileAtomicNative(filePath, content)) return;
    } catch (err) {
        logger.error(`Native write to ${filePath} failed, falling back: ${(err as Error).message}`);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    // The mode goes on the temp file, because the rename below replaces the
    // destination inode and takes the temp file's mode with it. Chmod'ing the
    // destination afterwards would leave a window where the contents are
    // readable, and would be undone by the next write.
    //
    // Removed first so writeFileSync always creates the file and so always
    // applies `mode` — it ignores the option for a path that already exists,
    // and an interrupted earlier write can leave one behind under this pid.
    fs.rmSync(tmpPath, { force: true });
    fs.writeFileSync(tmpPath, content, { mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmpPath, filePath);
}
