import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";
import { logger } from "./logger";
import * as settingsStore from "./settings-store";
import * as agentTools from "./agent-tools";
import * as terminalManager from "./terminal-manager";
import * as mcpClient from "./mcp-client";
import * as downloadQueue from "./download-queue";
import * as llamacpp from "./llamacpp-manager";
import * as llamacppBackendHealth from "./llamacpp-backend-health";
import * as electronShellHealth from "./electron-shell-health";
import * as scheduler from "./scheduler";
import * as backupScheduler from "./backup-scheduler";
import * as localServers from "./local-server-manager";
import * as powerMonitor from "./power-monitor";
import { setGpuMonitoringPaused } from "./gpu-telemetry";
import { shutdownInferenceResourceScheduler } from "./inference-resource-scheduler";
import { setupMenu } from "./menu";
import { setupAutoUpdater, checkForUpdatesManually } from "./updater";
import type { ProviderId } from "./providers/types";
import { getMainWindow, setMainWindow, getIsBusy, setIsBusy, getForceClose, setForceClose } from "./app-state";
import { completePrompt } from "./chat-dispatch";
import { registerLocalRuntimeIpc } from "./ipc/local-runtime-handlers";
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
import { registerGpuIpc } from "./ipc/gpu-handlers";
import { registerResourceIpc } from "./ipc/resource-handlers";
import { registerComputeAgentIpc } from "./ipc/compute-agent-handlers";
import { mainComputeAgent } from "./compute-agent";
import { registerPatientCasesIpc } from "./ipc/patient-cases-handlers";
import { registerAuditIpc } from "./ipc/audit-handlers";
import { registerEvidenceIpc } from "./ipc/evidence-handlers";
import { registerMedicalSafetyIpc } from "./ipc/medical-safety-handlers";
import { registerEncryptionIpc } from "./ipc/encryption-handlers";
import { registerModelRegistryIpc } from "./ipc/model-registry-handlers";
import { registerPolicyIpc } from "./ipc/policy-handlers";
import { registerBackupIpc } from "./ipc/backup-handlers";
import { registerSharedBackendIpc } from "./ipc/shared-backend-handlers";
import { installOhifProtocols, registerOhifSchemes } from "./ohif-viewer";
import { installIpcSenderValidation } from "./ipc/trusted-sender";
import { installContentSecurityPolicy } from "./csp";
import { selectMedicationSafetyProvider } from "./medical-safety";
import { registerPatientCasesBackend, selectPatientCasesBackend } from "./patient-cases-store";
import { createSharedPatientCasesBackend } from "./shared-patient-cases-backend";
import { wrapWithOfflineCache } from "./case-offline-cache";
import { registerSessionsBackend, selectSessionsBackend } from "./sessions-store";
import { createSharedSessionsBackend } from "./shared-sessions-backend";

// Without these, an unexpected error anywhere in the main process (a bad file
// parse, a network hiccup, a third-party library throwing) would crash the
// entire app instead of just failing the one operation that triggered it.
process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception in main process: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection in main process: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

// Two OS processes of this app pointed at the same userData directory (a
// double launch, a stray shortcut, a dev build and a packaged build sharing
// a profile) would otherwise both hold this store in memory independently
// and write to the same on-disk files — audit-log.json/.sqlite3 among
// them — with no coordination between them. Every store in this codebase
// (audit-log-store.ts's backend-switch bookkeeping in particular — see
// syncOnBackendTransition()) assumes it's the only process touching its
// files; requestSingleInstanceLock() is what actually keeps that true,
// rather than each store having to defend against cross-process races on
// its own. The second process to launch loses the race, quits immediately,
// and its "second-instance" event on the *first* process focuses the
// existing window instead of silently doing nothing.
//
// Uses app.exit() rather than app.quit(): quit() only *starts* the normal
// window-closing shutdown sequence, which Electron's own docs warn has
// undefined behavior when called before 'ready' — observed in practice here
// as the losing process sailing straight through into app.whenReady() (and
// its llama.cpp/etc. startup side effects) before quit() eventually
// caught up. exit() terminates synchronously, before any of that can run.
if (!app.requestSingleInstanceLock()) {
    app.exit(0);
} else {
    app.on("second-instance", () => {
        const win = getMainWindow();
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}

// GPU acceleration and the OS sandbox both stay ON by default here, on
// every machine — see electron-shell-health.ts for the full rationale.
// resolveStartupShellSafety() only turns either off automatically when THIS
// machine's own history shows a prior full-protection launch crashed the
// whole process before the window ever opened (Chromium's GPU process or
// sandboxed renderer hitting a broken virtualized/software-rendered driver
// stack — common on WSL/WSLg, some VMs, remote desktops, some CI
// containers — dies with an uncatchable SIGILL/SIGTRAP before any
// application log line is even printed, so there's no way to detect this
// ahead of time short of actually trying). DISABLE_GPU=1 / DISABLE_SANDBOX=1
// remain available as an explicit manual override for debugging.
const shellSafety = electronShellHealth.resolveStartupShellSafety();
electronShellHealth.markShellAttemptStarting(shellSafety);

if (process.env.DISABLE_GPU === "1" || !shellSafety.gpuAccelerationEnabled) {
    app.disableHardwareAcceleration();
}

// Chromium's Linux sandbox needs its `chrome-sandbox` helper binary to be
// owned by root with the setuid bit set (mode 4755) — `npm install` can
// never set that up itself (it would need a manual, one-time `sudo chown
// root:root .../chrome-sandbox && sudo chmod 4755 .../chrome-sandbox`, an
// action this project doesn't take on a developer's behalf). Without it,
// Electron doesn't fail gracefully — it crashes the whole process the
// moment the sandboxed renderer process tries to start. Dev-only in spirit:
// a packaged Linux build should fix chrome-sandbox's permissions (or run
// inside a container that already grants the equivalent capability) rather
// than ship with the sandbox off by default.
if (process.env.DISABLE_SANDBOX === "1" || !shellSafety.sandboxEnabled) {
    app.commandLine.appendSwitch("no-sandbox");
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
        // Reaching this event at all means the renderer (and therefore the
        // GPU/sandbox subsystems configured at startup) came up without
        // crashing the process — see electron-shell-health.ts.
        electronShellHealth.markShellAttemptConfirmed(shellSafety);
    });

    // GPU telemetry polling (nvidia-smi/rocm-smi) is only useful while
    // something can actually see it — pause it while the window is hidden or
    // minimized rather than spawning those tools in the background forever.
    mainWindow.on("hide", () => setGpuMonitoringPaused(true));
    mainWindow.on("minimize", () => setGpuMonitoringPaused(true));
    mainWindow.on("show", () => setGpuMonitoringPaused(false));
    mainWindow.on("restore", () => setGpuMonitoringPaused(false));

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
    // Installed before any handler module registers a single channel — see
    // trusted-sender.ts's own doc comment for why this one call covers
    // every register*Ipc() below instead of touching each individually.
    installIpcSenderValidation();
    registerLocalRuntimeIpc();
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
    registerGpuIpc();
    registerResourceIpc();
    registerComputeAgentIpc();
    registerPatientCasesIpc();
    registerAuditIpc();
    registerEvidenceIpc();
    registerMedicalSafetyIpc();
    registerEncryptionIpc();
    registerModelRegistryIpc();
    registerPolicyIpc();
    registerBackupIpc();
    registerSharedBackendIpc();
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
    installOhifProtocols();
    registerIpcHandlers();
    // Packaged mode only — see csp.ts's own doc comment for why dev mode
    // (the Vite dev server, HMR's 'unsafe-eval'/WebSocket needs) is
    // deliberately out of scope. Registered before createWindow() below so
    // the session-level header hook is in place before that window's first
    // loadURL() request.
    if (app.isPackaged) installContentSecurityPolicy();
    setupMenu(() => getMainWindow(), () => checkForUpdatesManually(() => getMainWindow()), settingsStore.getSettings().keybindings);
    createWindow();
    {
        const configuredMedicationSafetyProviderId = settingsStore.getSettings().medicationSafetyProviderId;
        if (configuredMedicationSafetyProviderId && !selectMedicationSafetyProvider(configuredMedicationSafetyProviderId)) {
            logger.error(`Configured medication safety provider "${configuredMedicationSafetyProviderId}" is not registered — staying on the built-in demonstration list.`);
        }
    }
    // Registered unconditionally (like every other PatientCasesBackend
    // would be) — registering doesn't select it; isAvailable() reports
    // false until Settings has both a shared-backend config and a
    // connected+organization-selected session, so it's safe to have in the
    // registry even for an install that never uses enterprise mode.
    // Wrapped with the encrypted offline cache/outbox (P1 item 5,
    // case-offline-cache.ts) — transparent to every caller above the
    // PatientCasesBackend interface.
    registerPatientCasesBackend(wrapWithOfflineCache(createSharedPatientCasesBackend()));
    {
        const configuredPatientCasesBackendId = settingsStore.getSettings().patientCasesBackendId;
        if (configuredPatientCasesBackendId && !selectPatientCasesBackend(configuredPatientCasesBackendId)) {
            logger.error(`Configured patient cases backend "${configuredPatientCasesBackendId}" is not registered — staying on the local backend.`);
        }
    }
    // Same registration pattern as patient cases above (P1 item 7: shared
    // chat sessions) — registered unconditionally, selected only if
    // Settings already asked for it. Not wrapped with wrapWithOfflineCache:
    // a disclosed gap, see shared-sessions-backend.ts's own doc comment.
    registerSessionsBackend(createSharedSessionsBackend());
    {
        const configuredSessionsBackendId = settingsStore.getSettings().sessionsBackendId;
        if (configuredSessionsBackendId && !selectSessionsBackend(configuredSessionsBackendId)) {
            logger.error(`Configured sessions backend "${configuredSessionsBackendId}" is not registered — staying on the local backend.`);
        }
    }
    const llamaSettings = settingsStore.getSettings();
    llamacpp.setModelCacheLimit(llamaSettings.llamaCppMaxCachedModels ?? 2);
    await llamacpp.setLlamaCppRuntimeConfig({
        maxThreads: llamaSettings.llamaCppMaxThreads,
        vramReserveBytes: llamaSettings.llamaCppVramReserveGB === undefined ? undefined : llamaSettings.llamaCppVramReserveGB * 1024 ** 3,
        ramReserveBytes: llamaSettings.llamaCppRamReserveGB === undefined ? undefined : llamaSettings.llamaCppRamReserveGB * 1024 ** 3,
        numa: llamaSettings.llamaCppNumaPolicy ?? "auto",
    });
    {
        const configuredGpuBackend = llamaSettings.llamaCppGpuBackend ?? "auto";
        const startupGpuBackend = llamacppBackendHealth.resolveStartupGpuBackend(configuredGpuBackend);
        if (startupGpuBackend !== configuredGpuBackend) {
            logger.error(
                `llama.cpp GPU backend "${configuredGpuBackend}" never confirmed a successful initialization last run — ` +
                    "the app most likely crashed while using it. Falling back to CPU for this launch and updating Settings " +
                    "to match; re-select a GPU backend in Settings to try it again."
            );
            settingsStore.saveSettings({ llamaCppGpuBackend: "cpu" });
        }
        await llamacpp.setGpuBackend(startupGpuBackend);
    }
    setupAutoUpdater(() => getMainWindow());
    downloadQueue.init(() => getMainWindow());
    downloadQueue.configure({
        concurrency: settingsStore.getSettings().downloadGlobalConcurrency ?? 2,
        bandwidthMbps: settingsStore.getSettings().downloadBandwidthMbps ?? 0,
    });
    void downloadQueue.resumeInterruptedJobs();
    void connectEnabledMcpServers();
    scheduler.init((provider, model, prompt) => completePrompt(provider as ProviderId, model, prompt));
    backupScheduler.init();
    {
        const computeSettings = settingsStore.getSettings();
        if (computeSettings.computeAgentEnabled && computeSettings.computeNodeId) mainComputeAgent.start();
    }

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    localServers.stopAll();
    agentTools.killAllBackgroundCommands();
    terminalManager.closeAll();
    mcpClient.disconnectAll();
    powerMonitor.stopAll();
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
    downloadQueue.flush();
    shutdownInferenceResourceScheduler();
    localServers.stopAll();
    agentTools.killAllBackgroundCommands();
    terminalManager.closeAll();
    void llamacpp.dispose();
    void mainComputeAgent.stop();
    powerMonitor.stopAll();
});
registerOhifSchemes();
