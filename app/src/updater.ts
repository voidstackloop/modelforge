import { app, dialog, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

let listenersRegistered = false;

function registerListeners(getWindow: () => BrowserWindow | null): void {
    if (listenersRegistered) return;
    listenersRegistered = true;

    autoUpdater.on("update-downloaded", (info) => {
        dialog
            .showMessageBox(getWindow() ?? ({} as BrowserWindow), {
                type: "info",
                title: "Update ready",
                message: `Modelforge ${info.version} has been downloaded.`,
                detail: "Restart now to install it?",
                buttons: ["Restart", "Later"],
                defaultId: 0,
                cancelId: 1,
            })
            .then(({ response }) => {
                if (response === 0) autoUpdater.quitAndInstall();
            });
    });

    autoUpdater.on("error", (err) => {
        console.error("Auto-update error:", err);
    });
}

// Silent background check on launch: only notifies the user if an update was
// actually found and downloaded (via the shared "update-downloaded" listener).
export function setupAutoUpdater(getWindow: () => BrowserWindow | null): void {
    if (!app.isPackaged) return;
    registerListeners(getWindow);
    autoUpdater.checkForUpdates().catch((err) => console.error("Update check failed:", err));
}

// Explicit user-triggered check (Help menu): unlike the silent startup check,
// this gives feedback even when there's nothing new or the check fails.
export function checkForUpdatesManually(getWindow: () => BrowserWindow | null): void {
    const win = getWindow();
    if (!app.isPackaged) {
        dialog.showMessageBox(win ?? ({} as BrowserWindow), {
            type: "info",
            title: "Check for Updates",
            message: "Update checks are only available in packaged builds.",
        });
        return;
    }

    registerListeners(getWindow);

    const onNotAvailable = () => {
        dialog.showMessageBox(win ?? ({} as BrowserWindow), {
            type: "info",
            title: "Check for Updates",
            message: "You're already on the latest version.",
        });
        cleanup();
    };
    const onError = (err: Error) => {
        dialog.showMessageBox(win ?? ({} as BrowserWindow), {
            type: "error",
            title: "Check for Updates",
            message: "Could not check for updates.",
            detail: err.message,
        });
        cleanup();
    };
    function cleanup() {
        autoUpdater.removeListener("update-not-available", onNotAvailable);
        autoUpdater.removeListener("error", onError);
    }

    autoUpdater.once("update-not-available", onNotAvailable);
    autoUpdater.once("error", onError);
    autoUpdater.checkForUpdates().catch((err) => console.error("Update check failed:", err));
}
