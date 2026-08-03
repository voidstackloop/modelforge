import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as auditLogStore from "../audit-log-store";

export function registerAuditIpc(): void {
    ipcMain.handle("audit:list", () => auditLogStore.listEvents());
    ipcMain.handle("audit:clearAll", () => auditLogStore.clearAll());
    ipcMain.handle("audit:verifyIntegrity", () => auditLogStore.verifyChainIntegrity());

    ipcMain.handle(
        "audit:record",
        (
            _event: IpcMainInvokeEvent,
            {
                actionCategory,
                fields,
            }: {
                actionCategory: auditLogStore.AuditActionCategory;
                fields?: {
                    targetType?: auditLogStore.AuditEvent["targetType"];
                    targetId?: string;
                    detail?: string;
                    mcpServerId?: string;
                    mcpServerName?: string;
                    mcpToolName?: string;
                    approvalOutcome?: auditLogStore.AuditEvent["approvalOutcome"];
                    durationMs?: number;
                };
            }
        ) => auditLogStore.recordEvent(actionCategory, fields ?? {})
    );
}
