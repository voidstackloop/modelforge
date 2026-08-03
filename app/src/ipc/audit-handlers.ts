import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as auditLogStore from "../audit-log-store";
import { getSqliteStoreCapabilityReport } from "../native-sqlite-store";

export function registerAuditIpc(): void {
    ipcMain.handle("audit:list", () => auditLogStore.listEvents());
    ipcMain.handle("audit:clearAll", () => auditLogStore.clearAll());
    ipcMain.handle("audit:verifyIntegrity", () => auditLogStore.verifyChainIntegrity());
    // Lets Settings explain *why* the experimental SQLite backend silently
    // stayed on JSON, rather than the toggle just appearing to do nothing.
    ipcMain.handle("audit:sqliteCapability", () => getSqliteStoreCapabilityReport());

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
