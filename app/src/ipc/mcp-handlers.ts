import { ipcMain, IpcMainInvokeEvent } from "electron";
import { logger } from "../logger";
import * as mcpClient from "../mcp-client";
import { mcpServerConfigSchema, parseOrThrow } from "../schemas";
import { requireString } from "../app-state";

export function registerMcpIpc(): void {
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
}
