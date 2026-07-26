import { ipcMain, IpcMainInvokeEvent, dialog } from "electron";
import { logger } from "../logger";
import * as agentTools from "../agent-tools";
import { detectSandboxCapabilities } from "../command-sandbox";
import * as terminalManager from "../terminal-manager";
import * as mcpClient from "../mcp-client";
import { agentToolArgsSchemas, mcpToolArgsSchema, parseOrThrow } from "../schemas";
import { getMainWindow, requireString } from "../app-state";

export function registerAgentIpc(): void {
    ipcMain.handle("agent:pickWorkspace", async () => {
        const mainWindow = getMainWindow();
        const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
            : await dialog.showOpenDialog({ properties: ["openDirectory"] });
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    });

    ipcMain.handle(
        "tools:execute",
        async (
            _event: IpcMainInvokeEvent,
            { workspaceRoot, name, args }: { workspaceRoot: string; name: string; args: unknown }
        ) => {
            requireString(workspaceRoot, "workspace root");
            requireString(name, "tool name");
            try {
                const isMcpTool = mcpClient.isMcpTool(name);
                // MCP tool schemas are server-defined and unknown to us ahead of
                // time — just check for a plain object. Built-in tools get a
                // real per-tool schema; a tool name with no entry here (a typo,
                // or a tool the model invented) falls through with args
                // unvalidated and is rejected by executeTool()'s own "Unknown
                // tool" check instead.
                const schema = isMcpTool ? mcpToolArgsSchema : agentToolArgsSchemas[name];
                const validatedArgs = (schema
                    ? parseOrThrow(schema, args ?? {}, `arguments for tool "${name}"`)
                    : (args ?? {})) as Record<string, unknown>;
                const result = isMcpTool
                    ? await mcpClient.callMcpTool(name, validatedArgs)
                    : await agentTools.executeTool(workspaceRoot, name, validatedArgs);
                return { result };
            } catch (err) {
                const error = err as Error;
                logger.error(`Tool execution failed (tool=${name}): ${error.message}`);
                return { error: error.message };
            }
        }
    );

    ipcMain.handle("agent:rollbackLastWrite", (_event: IpcMainInvokeEvent, workspaceRoot: string) => {
        requireString(workspaceRoot, "workspace root");
        return agentTools.rollbackLastWrite(workspaceRoot);
    });

    ipcMain.handle("agent:detectScripts", (_event: IpcMainInvokeEvent, workspaceRoot: string) => {
        requireString(workspaceRoot, "workspace root");
        return agentTools.detectProjectScripts(workspaceRoot);
    });

    // Called when the renderer is about to stop using a workspace (switching
    // to a different folder, or loading a session that points elsewhere) —
    // without this, background tasks started against the old workspace kept
    // running indefinitely, since killAllBackgroundCommands() only ever ran
    // on app quit.
    ipcMain.handle("agent:closeWorkspace", (_event: IpcMainInvokeEvent, workspaceRoot: string) => {
        requireString(workspaceRoot, "workspace root");
        const killedBackgroundTasks = agentTools.killBackgroundCommandsForWorkspace(workspaceRoot);
        const killedTerminals = terminalManager.closeAllForWorkspace(workspaceRoot);
        return { killedBackgroundTasks, killedTerminals };
    });

    ipcMain.handle("agent:getSandboxCapabilities", () => detectSandboxCapabilities());
}
