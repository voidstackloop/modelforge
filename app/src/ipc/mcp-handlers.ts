import { ipcMain, IpcMainInvokeEvent, dialog } from "electron";
import { logger } from "../logger";
import * as mcpClient from "../mcp-client";
import * as mcpOAuth from "../mcp-oauth";
import { mcpServerConfigSchema, parseOrThrow } from "../schemas";
import { requireString, getMainWindow, activeMcpToolRequests } from "../app-state";
import { buildMastervaultServerConfig, isMastervaultBuiltinAvailable } from "../mastervault-builtin";

export function registerMcpIpc(): void {
    ipcMain.handle("mcp:isMastervaultBuiltinAvailable", () => isMastervaultBuiltinAvailable());

    // Convenience one-click add for the built-in MasterVault server: prompts
    // for the vault folder (the one piece of per-user config it needs) and
    // hands back a ready-to-use McpServerConfig. The renderer still owns
    // adding it to settings.mcpServers and connecting — same as any other
    // MCP server — so it's removable through the exact same "Remove" button,
    // nothing about it is special-cased as undeletable.
    ipcMain.handle("mcp:pickMastervaultVault", async () => {
        const mainWindow = getMainWindow();
        const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
            : await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || result.filePaths.length === 0) return null;
        return buildMastervaultServerConfig(result.filePaths[0]);
    });

    ipcMain.handle("mcp:connect", async (_event: IpcMainInvokeEvent, input: unknown) => {
        try {
            const config = parseOrThrow(mcpServerConfigSchema, input, "MCP server config");
            const { tools } = await mcpClient.connectServer(config);
            return { tools };
        } catch (err) {
            const error = err as Error;
            const name = typeof (input as { name?: unknown })?.name === "string" ? (input as { name: string }).name : "?";
            logger.error(`MCP connect failed (server=${name}): ${error.message}`);
            return { error: error.message };
        }
    });

    ipcMain.handle("mcp:disconnect", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "server id");
        mcpClient.disconnectServer(id);
    });

    ipcMain.handle("mcp:status", () => mcpClient.getServerStatuses());

    ipcMain.handle("mcp:cancelTool", (_event: IpcMainInvokeEvent, requestId: string) => {
        requireString(requestId, "request id");
        activeMcpToolRequests.get(requestId)?.abort();
    });

    ipcMain.handle("mcp:startOAuthFlow", async (_event: IpcMainInvokeEvent, input: unknown) => {
        try {
            const config = parseOrThrow(mcpServerConfigSchema, input, "MCP server config");
            await mcpOAuth.startOAuthFlow(config);
            return { authorized: true };
        } catch (err) {
            const error = err as Error;
            logger.error(`MCP OAuth flow failed: ${error.message}`);
            return { authorized: false, error: error.message };
        }
    });

    ipcMain.handle("mcp:hasOAuthTokens", (_event: IpcMainInvokeEvent, serverId: string) => {
        requireString(serverId, "server id");
        return mcpOAuth.hasStoredOAuthTokens(serverId);
    });

    ipcMain.handle("mcp:clearOAuthCredentials", (_event: IpcMainInvokeEvent, serverId: string) => {
        requireString(serverId, "server id");
        mcpOAuth.clearOAuthCredentials(serverId);
    });
}
