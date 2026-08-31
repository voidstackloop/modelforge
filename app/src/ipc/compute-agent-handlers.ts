import { ipcMain } from "electron";
import { getOrCreateNodeIdentity } from "../compute-node-identity";
import { mainComputeAgent } from "../compute-agent";
import { getSettings } from "../settings-store";

/**
 * Read-only surface for the Settings UI's compute-agent enrollment panel:
 * the certificate fingerprint an organization compute admin needs to
 * register this device under (POST /compute/nodes), and whether the agent
 * is currently running. Enabling/configuring the agent itself goes through
 * the existing generic settings:save channel (computeAgentEnabled/
 * computeNodeId — see settings-handlers.ts, which starts/stops
 * mainComputeAgent as a side effect of saving those two fields), matching
 * how every other opt-in backend selection in this app already works.
 */
export function registerComputeAgentIpc(): void {
    ipcMain.handle("computeAgent:getIdentity", async () => {
        const identity = await getOrCreateNodeIdentity();
        return { fingerprint256: identity.fingerprint256 };
    });
    ipcMain.handle("computeAgent:getStatus", () => {
        const settings = getSettings();
        return {
            enabled: settings.computeAgentEnabled ?? false,
            nodeId: settings.computeNodeId ?? null,
            running: mainComputeAgent.isRunning(),
        };
    });
}
