import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

const APP_DIR = path.resolve(__dirname, "../../app");
const MAIN_JS = path.join(APP_DIR, "dist", "main.js");

// electron's package.json "main" export is the path to the platform's
// electron binary (a string), not a module — this is the documented way to
// find it without depending on electron being installed under e2e/ itself.
const ELECTRON_EXECUTABLE = require(path.join(APP_DIR, "node_modules", "electron")) as unknown as string;

export interface LaunchedApp {
    app: ElectronApplication;
    window: Page;
    userDataDir: string;
    close(): Promise<void>;
}

export interface LaunchOptions {
    // Partial app/src/settings-store.ts AppSettings written to
    // <userDataDir>/settings.json before launch, so a test can start from a
    // known state (e.g. onboarding already complete, llamaCppModelsDir
    // pointed at a fixture directory) instead of clicking through setup
    // every time.
    settings?: Record<string, unknown>;
    // Reuse an existing userData directory (e.g. to relaunch the app and
    // verify settings persisted across restarts) instead of creating a fresh
    // one.
    userDataDir?: string;
    // Extra environment variables for the launched Electron process, merged
    // over process.env/DISABLE_GPU below — e.g. fake-llamacpp.ts's
    // MODELFORGE_E2E_FAKE_LLAMACPP=1.
    env?: Record<string, string>;
}

export function makeUserDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-"));
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
    if (!fs.existsSync(MAIN_JS)) {
        throw new Error(`${MAIN_JS} does not exist — run "npm run build:app" (or "npm run build" from e2e/) before the e2e suite.`);
    }

    const userDataDir = options.userDataDir ?? makeUserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });

    if (options.settings) {
        fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify(options.settings, null, 2));
    }

    const app = await electron.launch({
        executablePath: ELECTRON_EXECUTABLE,
        // Chromium switches must precede Electron's app entry point. When
        // --user-data-dir came after MAIN_JS Electron exposed it only as an
        // application argument, silently reusing the real/default profile
        // and leaking sessions/navigation between otherwise isolated tests.
        args: [`--user-data-dir=${userDataDir}`, MAIN_JS],
        cwd: APP_DIR,
        env: {
            ...process.env,
            // Avoids Chromium GPU-process crashes on headless/software-
            // rendered CI runners — main.ts already wires this flag up for
            // exactly this scenario (see its DISABLE_GPU check).
            DISABLE_GPU: "1",
            ...options.env,
        },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    return {
        app,
        window,
        userDataDir,
        async close() {
            await app.close();
        },
    };
}

// Launches a second Electron process against a userDataDir another instance
// already holds open, to exercise main.ts's app.requestSingleInstanceLock().
// Deliberately bypasses Playwright's `_electron.launch()` (used by launchApp
// above) and spawns the binary directly: Playwright's helper requires the
// process to survive long enough to open a CDP-automatable window, but the
// entire point of this lock is that the losing process exits immediately —
// before ever reaching that point — which makes `_electron.launch()` itself
// reject with "Process failed to launch!" rather than reporting what we
// actually want to observe here.
export function spawnSecondInstance(userDataDir: string): { exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
    if (!fs.existsSync(MAIN_JS)) {
        throw new Error(`${MAIN_JS} does not exist — run "npm run build:app" (or "npm run build" from e2e/) before the e2e suite.`);
    }
    const child = spawn(ELECTRON_EXECUTABLE, ["--no-sandbox", `--user-data-dir=${userDataDir}`, MAIN_JS], {
        cwd: APP_DIR,
        env: {
            ...process.env,
            DISABLE_GPU: "1",
        },
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return { exited };
}

// Monkey-patches the main process's `dialog` module so agent:pickWorkspace /
// files:openAndRead / etc. resolve to a fixed path instead of opening a real,
// unautomatable native OS file picker. Electron's `dialog` import is a live
// reference to one shared module object, so overwriting a method on it here
// affects every file in the main process that imported it.
export async function stubOpenDialog(app: ElectronApplication, folderPath: string): Promise<void> {
    await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, folderPath);
}

// Same idea as stubOpenDialog, for the save-dialog half (backup:create,
// data:exportSession, etc.) — resolves to a fixed destination path instead
// of opening a real native save picker.
export async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
    await app.evaluate(({ dialog }, dest) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: dest })) as typeof dialog.showSaveDialog;
    }, filePath);
}
