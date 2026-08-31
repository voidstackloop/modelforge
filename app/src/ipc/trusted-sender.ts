import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebFrameMain } from "electron";
import { getMainWindow } from "../app-state";
import { logger } from "../logger";

/**
 * Structural IPC sender validation — docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md
 * P0 item 20 / trust boundary 2 ("Renderer to main: treat renderer content
 * as hostile input. Every IPC channel needs a schema, sender/frame checks,
 * capability limits, and response minimization"). Schema validation
 * (schemas.ts's parseOrThrow) and capability limits already exist per
 * handler; sender/frame checks did not — every one of the ~20
 * `register*Ipc()` modules called `ipcMain.handle`/`ipcMain.on` directly,
 * relying only on `contextIsolation`/`nodeIntegration` (app-state.ts's own
 * doc comment above called this out as an assumption, not an enforced
 * boundary).
 *
 * Rather than touch every handler file individually (~20 files, hundreds of
 * channels, a huge and error-prone surface for a repeatable mistake),
 * `installIpcSenderValidation()` wraps `ipcMain.handle`/`ipcMain.on`
 * themselves, once, before any handler module registers a single channel —
 * every existing and future `ipcMain.handle(...)`/`ipcMain.on(...)` call
 * automatically gets the check for free, the same "structural, not
 * developer-discipline" pattern this codebase already uses for tenant-bound
 * repositories server-side.
 *
 * Trusts exactly one frame: `getMainWindow()`'s own `webContents.mainFrame`
 * — deliberately not "any BrowserWindow this process created." This app
 * also creates a second, hidden BrowserWindow for agent tool screenshots
 * (browser-capture.ts) that loads arbitrary caller-supplied http(s) URLs;
 * that window has no preload script today so it cannot reach `ipcRenderer`
 * at all, but trusting "any BrowserWindow" here would have been a latent
 * trap for the day someone adds one — a child `<iframe>`/`<webview>` inside
 * the main window is rejected for the same reason: its `senderFrame` is
 * real but is not the window's *main* frame.
 */
let installed = false;

function isTrustedSender(senderFrame: WebFrameMain | null): boolean {
    if (!senderFrame) return false;
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return senderFrame === mainWindow.webContents.mainFrame;
}

export function installIpcSenderValidation(): void {
    if (installed) return;
    installed = true;

    const originalHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
        // async here (not just a plain arrow function) so a rejected sender
        // always comes back to the renderer's invoke() as a rejected
        // Promise, the same shape as any other handler failure — never a
        // synchronous throw with a different failure contract than the rest
        // of this channel's error handling.
        originalHandle(channel, async (event, ...args) => {
            if (!isTrustedSender(event.senderFrame)) {
                logger.error(`ipc: rejected "${channel}" from an untrusted sender frame.`);
                throw new Error("This request did not come from a trusted ModelForge Medical window.");
            }
            return listener(event, ...args);
        })) as typeof ipcMain.handle;

    const originalOn = ipcMain.on.bind(ipcMain);
    ipcMain.on = ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) =>
        originalOn(channel, (event, ...args) => {
            if (!isTrustedSender(event.senderFrame)) {
                logger.error(`ipc: rejected "${channel}" from an untrusted sender frame.`);
                return;
            }
            listener(event, ...args);
        })) as typeof ipcMain.on;
}

/** Test-only: undoes installIpcSenderValidation() so each test file gets a
 * clean, unwrapped ipcMain to install its own instrumented version against
 * — see trusted-sender.test.ts. Never called from production code. */
export function _resetForTests(): void {
    installed = false;
}
