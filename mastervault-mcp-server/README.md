# MasterVault MCP Server

A project by [JustMichael-80](https://github.com/JustMichael-80).

A headless, filesystem-backed [Model Context Protocol](https://modelcontextprotocol.io) server that serves **any MasterVault** — its files *and* its operating protocol — to any MCP client, over stdio. No Obsidian required.

Point it at a vault directory; any MCP-capable LLM client (ModelForge, Claude Desktop, AnythingLLM, etc.) can then orient on the vault's protocol, read and search its contents, log decisions, and soft-delete files — all behind the client's own approval flow.

## Why this exists

An Obsidian vault can already be served over MCP via the Local REST API plugin, but that ties it to Obsidian. This server drops the Obsidian dependency: it speaks the same vault semantics against a plain directory, so the MasterVault becomes portable to any client and any model. It also surfaces the vault's *protocol* (orientation, decision-logging, soft-delete), not just its files — so a fresh LLM can run the system, not merely read it.

## Install

```bash
git clone https://github.com/JustMichael-80/mastervault-mcp-server.git
cd mastervault-mcp-server
npm install      # also builds via the prepare script
npm run build    # (if you skipped prepare)
```

Requires Node.js 18+.

## Run

```bash
mastervault-mcp-server /absolute/path/to/vault
# or
MASTERVAULT_ROOT=/absolute/path/to/vault node dist/index.js
```

The vault path is the only configuration. Nothing is hardcoded — the same binary serves any vault.

## Connecting a client

### ModelForge

In **Settings → MCP servers**, add a **stdio** server:

- **Command:** `node`
- **Args:** `/absolute/path/to/mastervault-mcp-server/dist/index.js` `/absolute/path/to/vault`

(or use the `mastervault-mcp-server` bin directly if installed globally). The server's tools then appear in Agent mode's tool list, each behind ModelForge's Allow/Deny approval — exactly like its built-in file tools.

### Any MCP client (generic stdio config)

```json
{
  "mcpServers": {
    "mastervault": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js", "/absolute/path/to/vault"]
    }
  }
}
```

## Tools

| Tool | Tier | Read-only | What it does |
|------|------|:---------:|--------------|
| `mastervault_orient` | protocol | ✅ | Reads the orientation file and the protocol files it points to, in order. **Call this first.** |
| `mastervault_get_confidence_summary` | protocol | ✅ | Returns the calibration dashboard (`_Meta/Confidence Summary.md`). |
| `mastervault_log_decision` | protocol | ✍️ | Appends a consequential decision (proposal + confidence + verdict) to the right category in `_Meta/Decision Log.md`. |
| `mastervault_read` | files | ✅ | Reads a file, optionally by line range; parses markdown frontmatter. |
| `mastervault_list` | files | ✅ | Lists a directory, paginated, directories first. |
| `mastervault_search` | files | ✅ | Case-insensitive full-text search across text files. |
| `mastervault_write` | files | ✍️ | Creates or overwrites a file. |
| `mastervault_patch` | files | ✍️ | Replaces one exact, unique text block in a file. |
| `mastervault_stage_delete` | delete | ✍️ | Moves a file to `_ToDelete/` and logs the proposal. **Never hard-deletes.** |

Every tool supports `response_format: "markdown"` (default) or `"json"`.

## Security model

- **Path confinement is the single security boundary.** Every path is resolved and confined to the vault root before any filesystem call. Lexical `..` traversal, absolute paths, and null bytes are rejected; a leading slash is treated as vault-relative, not filesystem-absolute. Existing paths get a second `realpath` check so a symlink inside the vault can't point out of it.
- **No hard delete.** The server has no tool that destroys data. `stage_delete` only *moves* files into `_ToDelete/`; a human is the sole final actor who empties it. This is why `stage_delete` is marked non-destructive — it's reversible by design.
- **No shell execution.** File operations only. If a client needs shell access it provides that itself (ModelForge does, sandboxed and gated separately).
- **stdio hygiene.** All logging goes to stderr; stdout carries only the MCP protocol.

## The MasterVault protocol layer

This server is more than a file server because of three conventions it understands:

- **`_orientation.md`** — the entry point a fresh LLM reads first (via `mastervault_orient`) to inherit the vault's working rules.
- **`_Meta/Decision Log.md` + `Confidence Summary.md`** — a decision-logging + calibration system: consequential proposals are logged with a pre-verdict confidence estimate, and the gap between estimate and outcome accumulates into a per-category calibration signal.
- **`_ToDelete/`** — the soft-delete staging area; the human is always the final actor on removal.

A vault that lacks these still works as a plain file tree — the protocol tools report what's missing rather than failing.

## Development

```bash
npm run dev     # tsx watch
npm run build   # tsc -> dist/
npm start       # node dist/index.js <vault>
```

## License

MIT
