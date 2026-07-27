import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServerConfig } from "./mcp-client";

// The MasterVault MCP server (../mastervault-mcp-server/) ships as a single
// esbuild-bundled CJS-under-ESM file (its own `npm run build:bundled`) with
// no runtime node_modules dependency, packaged via electron-builder's
// extraResources into resources/mcp-servers/mastervault/index.js — mirroring
// how app/src/python-runtime-manager.ts locates its own packaged worker
// scripts (packaged path if it exists, else the repo-relative dev path).
function scriptPath(): string {
    const packaged = path.join(process.resourcesPath, "mcp-servers", "mastervault", "index.js");
    if (fs.existsSync(packaged)) return packaged;
    return path.join(__dirname, "..", "..", "mastervault-mcp-server", "dist-bundled", "index.js");
}

export function isMastervaultBuiltinAvailable(): boolean {
    return fs.existsSync(scriptPath());
}

// Spawning the bundled script through the Electron binary itself (with
// ELECTRON_RUN_AS_NODE) rather than a system `node` means this built-in
// integration works out of the box in a packaged app even on a machine with
// no Node.js installed at all — the same technique Electron's own docs
// recommend for running helper Node scripts from a packaged app.
export function buildMastervaultServerConfig(vaultRoot: string): McpServerConfig {
    return {
        id: "mastervault-builtin",
        name: "MasterVault",
        transport: "stdio",
        enabled: true,
        command: process.execPath,
        args: [scriptPath(), vaultRoot],
        env: { ELECTRON_RUN_AS_NODE: "1" },
    };
}
