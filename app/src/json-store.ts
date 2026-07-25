import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger";

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

export function readJson<T>(filePath: string, fallback: T): T {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== "ENOENT") {
            logger.error(`Failed to read ${filePath}: ${nodeErr.message}`);
        }
        return fallback;
    }

    restrictExistingPermissions(filePath);

    try {
        return JSON.parse(raw) as T;
    } catch (err) {
        logger.error(`Corrupted JSON in ${filePath}, backing up and resetting: ${(err as Error).message}`);
        try {
            fs.copyFileSync(filePath, `${filePath}.corrupted-${Date.now()}`);
        } catch (backupErr) {
            logger.error(`Failed to back up corrupted file ${filePath}: ${(backupErr as Error).message}`);
        }
        return fallback;
    }
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
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmpPath, filePath);
}
