import { ipcMain } from "electron";
import * as policyStore from "../policy-store";

export function registerPolicyIpc(): void {
    // Every field here is safe to hand to the renderer as-is: a policy
    // payload only ever contains the governance values themselves (retention
    // days, provider ids, booleans) — never key material (the trusted public
    // key isn't exposed at all) and never PHI.
    ipcMain.handle("policy:status", () => policyStore.getPolicyStatus());
    ipcMain.handle("policy:reload", () => policyStore.reloadPolicy());
}
