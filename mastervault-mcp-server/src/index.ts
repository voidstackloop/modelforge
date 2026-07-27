#!/usr/bin/env node
/**
 * MasterVault MCP Server
 *
 * A headless, filesystem-backed MCP server that serves ANY MasterVault — its
 * files and its operating protocol — to any MCP client, over stdio. No Obsidian
 * required.
 *
 * Usage:
 *   mastervault-mcp-server /absolute/path/to/vault
 *   MASTERVAULT_ROOT=/path/to/vault mastervault-mcp-server
 *
 * The vault path may be given as the first CLI argument or via the
 * MASTERVAULT_ROOT environment variable. The CLI argument wins if both are set.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { VaultService } from "./services/vault.js";
import { registerProtocolTools } from "./tools/protocol.js";
import { registerFileTools } from "./tools/files.js";
import { registerDeleteTools } from "./tools/delete.js";

const VERSION = "1.1.1";

function usage(): string {
  return [
    "MasterVault MCP Server v" + VERSION,
    "",
    "Serves a MasterVault (files + protocol) to any MCP client over stdio.",
    "",
    "Usage:",
    "  mastervault-mcp-server <vault-path>",
    "  MASTERVAULT_ROOT=<vault-path> mastervault-mcp-server",
    "",
    "The vault path is the root directory of the vault (the folder containing",
    "_orientation.md, if present). It is passed as an argument; nothing is",
    "hardcoded, so the same binary serves any vault.",
  ].join("\n");
}

async function resolveVaultRoot(): Promise<string> {
  const argPath = process.argv[2];
  if (argPath === "--help" || argPath === "-h") {
    // stdout is reserved for the MCP protocol; help goes to stderr.
    console.error(usage());
    process.exit(0);
  }

  const root = argPath || process.env.MASTERVAULT_ROOT;
  if (!root) {
    console.error("ERROR: no vault path provided.\n");
    console.error(usage());
    process.exit(1);
  }

  const abs = path.resolve(root);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    console.error(`ERROR: vault path does not exist: ${abs}`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`ERROR: vault path is not a directory: ${abs}`);
    process.exit(1);
  }
  return abs;
}

async function main(): Promise<void> {
  const vaultRoot = await resolveVaultRoot();
  const vault = new VaultService(vaultRoot);

  const server = new McpServer({
    name: "mastervault-mcp-server",
    version: VERSION,
  });

  registerProtocolTools(server, vault);
  registerFileTools(server, vault);
  registerDeleteTools(server, vault);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdio servers must not log to stdout (it carries the protocol). Use stderr.
  console.error(`mastervault-mcp-server v${VERSION} running on stdio`);
  console.error(`Serving vault: ${vaultRoot}`);
}

main().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
