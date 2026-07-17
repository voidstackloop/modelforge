import { app, BrowserWindow, Menu, MenuItemConstructorOptions, dialog } from "electron";

export function setupMenu(getWindow: () => BrowserWindow | null, checkForUpdates: () => void): void {
    const isMac = process.platform === "darwin";

    function send(channel: string) {
        getWindow()?.webContents.send(channel);
    }

    function showAbout() {
        const win = getWindow();
        dialog.showMessageBox(win ?? ({} as BrowserWindow), {
            type: "info",
            title: "About Modelforge",
            message: "Modelforge",
            detail: [
                `Version ${app.getVersion()}`,
                `Electron ${process.versions.electron}`,
                `Chromium ${process.versions.chrome}`,
                `Node ${process.versions.node}`,
            ].join("\n"),
            buttons: ["OK"],
        });
    }

    const template: MenuItemConstructorOptions[] = [
        ...(isMac
            ? [
                  {
                      label: app.name,
                      submenu: [
                          { label: "About Modelforge", click: showAbout },
                          { label: "Check for Updates...", click: checkForUpdates },
                          { type: "separator" as const },
                          { role: "quit" as const },
                      ],
                  },
              ]
            : []),
        {
            label: "File",
            submenu: [
                { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => send("menu:new-chat") },
                { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => send("menu:open-settings") },
                { type: "separator" },
                isMac ? { role: "close" } : { role: "quit" },
            ],
        },
        {
            label: "Edit",
            submenu: [
                { role: "undo" },
                { role: "redo" },
                { type: "separator" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                { role: "selectAll" },
            ],
        },
        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
            ],
        },
        {
            label: "Window",
            submenu: [{ role: "minimize" }, { role: "close" }],
        },
        ...(isMac
            ? []
            : [
                  {
                      label: "Help",
                      submenu: [
                          { label: "About Modelforge", click: showAbout },
                          { label: "Check for Updates...", click: checkForUpdates },
                      ],
                  },
              ]),
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
