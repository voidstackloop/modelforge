import { ipcMain, IpcMainInvokeEvent } from "electron";
import { logger } from "../logger";
import * as agentTools from "../agent-tools";
import * as mcpClient from "../mcp-client";
import type { ChatMessage, ChatChunk, ChatOptions, ProviderId } from "../providers/types";
import { activeChatRequests } from "../app-state";
import { dispatchChat } from "../chat-dispatch";

export function registerChatIpc(): void {
    ipcMain.handle(
        "chat:send",
        async (
            event: IpcMainInvokeEvent,
            {
                requestId,
                provider,
                model,
                messages,
                options,
                agentMode,
                conversationId,
            }: {
                requestId: string;
                provider: ProviderId;
                model: string;
                messages: ChatMessage[];
                options?: ChatOptions;
                agentMode?: boolean;
                conversationId?: string;
            }
        ) => {
            const channel = `chat:chunk:${requestId}`;
            const onToken = (chunk: ChatChunk) => event.sender.send(channel, chunk);
            const controller = new AbortController();
            activeChatRequests.set(requestId, controller);
            const tools = agentMode ? [...agentTools.AGENT_TOOLS, ...mcpClient.getConnectedTools()] : undefined;
            try {
                await dispatchChat(provider, model, messages, options, onToken, controller.signal, tools, "active-inference", requestId, conversationId);
                return { done: true };
            } catch (err) {
                const error = err as Error;
                if (error.name === "AbortError") {
                    return { done: true, aborted: true };
                }
                logger.error(`Chat request failed (provider=${provider}, model=${model}): ${error.message}`);
                return { done: true, error: error.message };
            } finally {
                activeChatRequests.delete(requestId);
            }
        }
    );

    ipcMain.handle("chat:cancel", (_event: IpcMainInvokeEvent, requestId: string) => {
        activeChatRequests.get(requestId)?.abort();
    });
}
