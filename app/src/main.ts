import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";
import * as ollama from "./ollama-manager";
import { logger } from "./logger";
import * as settingsStore from "./settings-store";
import * as agentTools from "./agent-tools";
import * as terminalManager from "./terminal-manager";
import * as mcpClient from "./mcp-client";
import * as downloadQueue from "./download-queue";
import * as llamacpp from "./llamacpp-manager";
import * as scheduler from "./scheduler";
import * as localServers from "./local-server-manager";
import * as powerMonitor from "./power-monitor";
import { setupMenu } from "./menu";
import { setupAutoUpdater, checkForUpdatesManually } from "./updater";
import type { ProviderId } from "./providers/types";
import { getMainWindow, setMainWindow, getIsBusy, setIsBusy, getForceClose, setForceClose } from "./app-state";
import { completePrompt } from "./chat-dispatch";
import { registerOllamaIpc } from "./ipc/ollama-handlers";
import { registerChatIpc } from "./ipc/chat-handlers";
import { registerSystemIpc } from "./ipc/system-handlers";
import { registerDownloadsIpc } from "./ipc/downloads-handlers";
import { registerSettingsIpc } from "./ipc/settings-handlers";
import { registerSessionsIpc } from "./ipc/sessions-handlers";
import { registerFilesIpc } from "./ipc/files-handlers";
import { registerAppIpc } from "./ipc/app-handlers";
import { registerRagIpc } from "./ipc/rag-handlers";
import { registerMediaIpc } from "./ipc/media-handlers";
import { registerAgentIpc } from "./ipc/agent-handlers";
import { registerTerminalIpc } from "./ipc/terminal-handlers";
import { registerMcpIpc } from "./ipc/mcp-handlers";

// Without these, an unexpected error anywhere in the main process (a bad file
// parse, a network hiccup, a third-party library throwing) would crash the
// entire app instead of just failing the one operation that triggered it.
process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception in main process: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection in main process: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

// Chromium's GPU process crashes on some virtualized/software-rendered setups
// (WSLg, some VMs, remote desktops). Set DISABLE_GPU=1 to work around the
// fatal "GPU process isn't usable" shutdown on those hosts.
if (process.env.DISABLE_GPU === "1") {
    app.disableHardwareAcceleration();
}

function createWindow(): void {
    // Reset so a fresh window (e.g. re-created via macOS "activate" after all
    // windows closed) gets its own busy-quit confirmation instead of
    // inheriting a stale bypass from a previously confirmed close.
    setForceClose(false);
    setIsBusy(false);

    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 820,
        minHeight: 560,
        backgroundColor: "#171717",
        resizable: true,
        show: false,
        title: "Modelforge",
        icon: path.join(__dirname, "../build/icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    setMainWindow(mainWindow);

    // Start maximized (normal windowed maximize, not OS-level fullscreen/kiosk
    // mode) so the app makes good use of the screen by default while still
    // keeping window controls, the taskbar, and free resizing available.
    mainWindow.once("ready-to-show", () => {
        mainWindow?.maximize();
        mainWindow?.show();
    });

    mainWindow.on("close", (event) => {
        if (getIsBusy() && !getForceClose()) {
            event.preventDefault();
            dialog
                .showMessageBox(mainWindow!, {
                    type: "question",
                    buttons: ["Quit", "Cancel"],
                    defaultId: 1,
                    cancelId: 1,
                    title: "Response still generating",
                    message: "A response is still generating. Quit anyway?",
                })
                .then(({ response }) => {
                    if (response === 0) {
                        setForceClose(true);
                        mainWindow?.close();
                    }
                });
        }
    });

    // The app's one legitimate page — loaded via this exact URL below, so
    // will-navigate can tell "the app reloading itself" apart from
    // "something is trying to navigate away" by exact match, rather than by
    // comparing .origin. Comparing .origin doesn't work here:
    // packaged builds load over file:, and *every* file: URL reports
    // origin "null", so two completely unrelated local files would compare
    // as "same origin" and be allowed to navigate straight through.
    const homeUrl = app.isPackaged
        ? pathToFileURL(path.join(process.resourcesPath, "frontend-dist", "index.html")).href
        : "http://localhost:5173/";

    // Only http(s) ever gets handed to the OS — chat content can contain
    // arbitrary links (from the user or from a model's output), and hitting
    // shell.openExternal() with whatever protocol it happens to be would let
    // a crafted file:, custom-scheme, or OS-handler URL launch an unintended
    // local application or open an arbitrary local file.
    function isSafeExternalUrl(url: string): boolean {
        try {
            const protocol = new URL(url).protocol;
            return protocol === "http:" || protocol === "https:";
        } catch {
            return false;
        }
    }

    // Chat content can contain links. Without this, clicking one would
    // either silently do nothing or open an unmanaged Electron window;
    // instead hand safe links to the OS's default browser and keep this
    // window on the app's own content only.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (url === homeUrl) return;
        event.preventDefault();
        if (isSafeExternalUrl(url)) shell.openExternal(url);
    });

    // Loading homeUrl itself here (rather than loadFile(), which builds its
    // own file: URL independently) guarantees this is byte-identical to what
    // will-navigate compares against above — any discrepancy between the two
    // encodings (e.g. a non-ASCII character in the install path) would make
    // the app's own initial load fail the exact-match check and get blocked.
    // extraResources (electron-builder) copies frontend/dist to resources/frontend-dist.
    mainWindow.loadURL(homeUrl);
}

function registerIpcHandlers(): void {
    registerOllamaIpc();
    registerChatIpc();
    registerSystemIpc();
    registerDownloadsIpc();
    registerSettingsIpc();
    registerSessionsIpc();
    registerFilesIpc();
    registerAppIpc();
    registerRagIpc();
    registerMediaIpc();
    registerAgentIpc();
    registerTerminalIpc();
    registerMcpIpc();
}

// Best-effort: connect every enabled MCP server on launch so its tools are
// available in Agent mode without the user having to manually reconnect each
// session. A server that fails to start (bad command, unreachable URL) just
// logs and stays disconnected — it doesn't block app startup.
async function connectEnabledMcpServers(): Promise<void> {
    const servers = settingsStore.getSettings().mcpServers ?? [];
    for (const server of servers.filter((s) => s.enabled)) {
        try {
            await mcpClient.connectServer(server);
        } catch (err) {
            logger.error(`MCP server "${server.name}" failed to connect on launch: ${(err as Error).message}`);
        }
    }
}

app.whenReady().then(async () => {
    registerIpcHandlers();
    setupMenu(() => getMainWindow(), () => checkForUpdatesManually(() => getMainWindow()), settingsStore.getSettings().keybindings);
    createWindow();
    ollama.setHost(settingsStore.getSettings().ollamaHost);
    ollama.setModelsDir(settingsStore.getSettings().modelsDir);
    await ollama.start();
    llamacpp.setModelCacheLimit(settingsStore.getSettings().llamaCppMaxCachedModels ?? 2);
    await llamacpp.setGpuBackend(settingsStore.getSettings().llamaCppGpuBackend ?? "auto");
    setupAutoUpdater(() => getMainWindow());
    downloadQueue.init(() => getMainWindow());
    downloadQueue.configure({
        concurrency: settingsStore.getSettings().downloadGlobalConcurrency ?? 2,
        bandwidthMbps: settingsStore.getSettings().downloadBandwidthMbps ?? 0,
    });
    void downloadQueue.resumeInterruptedJobs();
    void connectEnabledMcpServers();
    scheduler.init((provider, model, prompt) => completePrompt(provider as ProviderId, model, prompt));

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    ollama.stop();
    localServers.stopAll();
    agentTools.killAllBackgroundCommands();
    terminalManager.closeAll();
    mcpClient.disconnectAll();
    powerMonitor.stopAll();
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
    ollama.stop();
    localServers.stopAll();
    agentTools.killAllBackgroundCommands();
    terminalManager.closeAll();
    void llamacpp.dispose();
    powerMonitor.stopAll();
});
