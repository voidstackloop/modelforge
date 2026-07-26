import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as terminalManager from "../terminal-manager";
import { requireString } from "../app-state";

export function registerTerminalIpc(): void {
    ipcMain.handle(
        "terminal:create",
        (
            event: IpcMainInvokeEvent,
            { workspaceRoot, opts }: { workspaceRoot: string; opts?: { cwd?: string; name?: string } }
        ) => {
            requireString(workspaceRoot, "workspace root");
            // `id` is referenced inside these callbacks before it's assigned
            // below, but that's safe: node-pty never calls onData/onExit
            // synchronously during createTerminal() itself, only later once
            // its own async event loop runs — by which point `id` is set.
            const { id, name } = terminalManager.createTerminal(
                workspaceRoot,
                opts ?? {},
                (chunk) => event.sender.send(`terminal:data:${id}`, chunk),
                (exitCode) => event.sender.send(`terminal:exit:${id}`, exitCode)
            );
            return { id, name };
        }
    );

    ipcMain.handle("terminal:write", (_event: IpcMainInvokeEvent, { id, data }: { id: string; data: string }) => {
        requireString(id, "terminal id");
        terminalManager.writeToTerminal(id, typeof data === "string" ? data : "");
    });

    ipcMain.handle("terminal:resize", (_event: IpcMainInvokeEvent, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
        requireString(id, "terminal id");
        terminalManager.resizeTerminal(id, Number(cols) || 80, Number(rows) || 24);
    });

    ipcMain.handle("terminal:close", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "terminal id");
        terminalManager.closeTerminal(id);
    });

    ipcMain.handle("terminal:list", (_event: IpcMainInvokeEvent, workspaceRoot?: string) => terminalManager.listTerminals(workspaceRoot));
}
