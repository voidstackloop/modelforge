# Agent mode

Agent mode lets the model read/write files and run commands in a folder you explicitly choose
("the workspace"), with every action gated behind your approval. This document is the detailed
reference; see the [README](../README.md#agent-mode) for a shorter overview.

Source of truth for all of this is `app/src/agent-tools.ts` (tool implementations + the
destructive-command blocklist), `app/src/command-sandbox.ts` (OS-level sandboxing), and
`frontend/src/lib/tool-approval.ts` (which tools may be auto-approved).

## Starting a session

Click **Agent** in the chat toolbar and pick a folder. That folder becomes `workspaceRoot` for the
rest of the conversation — every filesystem tool call is resolved and validated against it before
anything touches disk.

## Tool catalog

Every tool below is dispatched through a single `executeTool(workspaceRoot, name, args)` switch in
`agent-tools.ts`, so this table reflects the actual current tool set rather than a curated subset.

**Filesystem (workspace-sandboxed)**

| Tool | What it does |
|---|---|
| `read_file` | Read a text file, optionally by line range |
| `write_file` | Create or overwrite a file (creates parent directories as needed); shows a line-by-line diff before approval |
| `replace_in_file` | Replace an exact text block without rewriting the whole file, optionally all occurrences |
| `find_files` | Discover files by glob pattern |
| `file_info` | Inspect path metadata (size, type, mtime) |
| `list_dir` | List files and subdirectories |
| `search_files` | Search for a text string across the workspace |
| `find_symbol_references` | Search for references to a symbol name (a scoped variant of `search_files`) |
| `make_directory` | Create a directory |
| `move_path` | Move/rename a file or directory |
| `delete_path` | Delete a file or directory (optionally recursive) |
| `apply_patch` | Apply a unified-diff-style patch across one or more files |
| `read_notes` / `write_notes` | Read/write a per-workspace scratch note file the model can use as working memory across a long task |

**Execution**

| Tool | What it does |
|---|---|
| `run_command` | Execute a shell command in the workspace (or a subfolder), with a 60s timeout and network access off by default |
| `run_code` | Run a Python or JavaScript snippet — a convenience over shell-quoting multi-line code through `run_command`, not a new capability |
| `start_background_command` / `get_background_output` / `stop_background_command` / `list_background_commands` | Launch a long-running command (e.g. a dev server) without blocking the agent loop, and poll or stop it later |
| `create_terminal` / `write_to_terminal` / `read_terminal_output` / `close_terminal` | Drive a PTY-backed terminal the model can interact with by polling output rather than streaming; the human-facing terminal panel uses a separate IPC path and is unaffected |

**Git**

| Tool | What it does |
|---|---|
| `git_status`, `git_diff`, `git_log` | Read-only git helpers (auto-approvable) so the model doesn't need to guess flag syntax |
| `git_commit` | Stage everything and commit — requires approval, like `write_file` |

**Network** (see [Network tools and the network toggle](#network-tools-and-the-network-toggle))

| Tool | What it does |
|---|---|
| `fetch_url` | Fetch a URL and return its content |
| `http_request` | A general HTTP request with method/headers/body, for calling APIs |
| `web_search` | Run a web search |
| `capture_page_screenshot` | Render a URL and save a screenshot into the workspace |
| `github_list_repositories` | List repositories accessible to the linked GitHub account |
| `github_repository_tree` | Inspect a repository's complete file structure |
| `github_read_file` | Read a file from a public or private linked-account repository |

## Safety model

**Workspace confinement.** The filesystem tools resolve every path against `workspaceRoot` and
reject anything that would escape it — `../../etc`, an absolute path elsewhere on disk, or a
symlink that resolves outside the workspace. This confinement is real for those tools specifically.

**`run_command` and `run_code` are different.** A shell command (or a script handed to
`python3`/`node`) is opaque text that can reference any path on the system regardless of its
working directory, so neither is confined the way the file tools are. Two layers of mitigation
apply instead:

1. **OS-level sandboxing where available** (`command-sandbox.ts`): on Linux, commands run inside
   [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) when it's installed *and*
   verified to actually work — a plain `which bwrap` isn't trusted, since modern Ubuntu (23.10+)
   restricts unprivileged user namespaces by AppArmor policy and would make `bwrap` fail silently
   at runtime. On macOS, `sandbox-exec` is used (built in, no install needed). **Windows has no
   equivalent lightweight primitive** — there's no OS-level confinement there, only the blocklist
   below plus `resource-monitor.ts` limits. Query current capabilities via `agent:getSandboxCapabilities`.
2. **A destructive-command blocklist**, checked regardless of sandboxing and even against
   already-approved commands: deleting outside the workspace, formatting a drive, shutting down the
   machine, registry deletion, `sudo`/`runas`, or piping a remote script into a shell are **rejected
   outright**. This catches the common catastrophic cases, not everything a shell or script can do —
   only approve a command or snippet you actually understand.

**Explicit approval, every time (with one narrow exception).** Every tool call shows an
Allow/Deny card before it executes. `frontend/src/lib/tool-approval.ts` allows a narrow set of
*strictly read-only, no-network* tools to be marked "always allow this session":

```
read_file, find_files, file_info, list_dir, search_files,
git_status, git_diff, git_log, read_notes,
get_background_output, list_background_commands, read_terminal_output
```

The bar for that list is not "doesn't write to the workspace" — it's "the user has nothing to lose
by never being asked again." That's deliberately narrower than "read-only": `web_search`,
`fetch_url`, `http_request`, and the `github_*` tools all send a request to a destination the model
chooses, which is an unattended outbound channel for whatever the model has already read if
standing-approved — so they always prompt. `capture_page_screenshot` fetches a model-chosen URL
*and* writes into the workspace, so it's excluded for the same reason. Filesystem mutations,
`run_command`, `run_code`, and `git_commit` always require a fresh click, since they have real,
potentially irreversible effects. The trust list is in-memory only — closing and reopening a chat
resets it.

This is a default-deny design: a tool added to the catalog without being explicitly added to
`AUTO_APPROVABLE_TOOLS` requires per-call approval until someone deliberately decides otherwise.

**Untrusted model input.** Agent mode reads file contents and web pages, and instructions embedded
in that content can attempt to steer the model into calling tools it wasn't asked to. The per-call
approval prompt is the actual control against this becoming unattended action — it's why the
auto-approve list above is scoped so conservatively.

**Step limit.** A per-turn cap of 25 tool-result → model-continuation round trips stops a model
from looping indefinitely without producing a final answer.

## Network tools and the network toggle

Settings has a global switch to turn off network-capable tools entirely
(`networkToolsEnabled: false`). When off, any tool in the network set above throws immediately
instead of running, regardless of approval state — useful if you want Agent mode confined to a
fully offline, filesystem-and-shell-only workflow.

## Preview & rollback

- A pending `write_file` call shows a real line-by-line diff against the file's current content
  (or a "new file" badge if it doesn't exist yet), so you see exactly what would change before
  clicking Allow.
- **Undo last edit** reverts the most recent applied `write_file`, restoring the previous content
  or deleting the file if the edit created it. History is per-workspace, capped at the last 20
  writes, and lives only in memory for the running session — not a durable version history.

## Quick actions

If the workspace has `test`/`lint`/`format` scripts in its `package.json`, **Run Tests**, **Lint**,
and **Format** buttons appear in the toolbar. They run the corresponding `npm` script directly
(reusing the same sandboxing as `run_command`) and drop the output into the chat without going
through the model at all — useful for a fast check that doesn't cost a model turn.

## MCP (Model Context Protocol) servers

Add external MCP servers in Settings to give Agent mode extra tools beyond the built-in catalog —
anything from a database query tool to a browser-automation server. Two transports are supported:

- **stdio** — launches a local command (e.g. `npx -y @modelcontextprotocol/server-filesystem
  /some/path`) and speaks JSON-RPC over its stdin/stdout.
- **HTTP** — connects to a remote MCP server's "Streamable HTTP" endpoint.

Enabled servers reconnect automatically on launch. Each server's tools appear in Agent mode's tool
list prefixed with the server's name, and go through the exact same Allow/Deny approval flow as
built-in tools — an MCP server is not a trust escalation. SSE and plain WebSocket transports
aren't implemented: SSE is the legacy MCP HTTP transport, now superseded by Streamable HTTP, and
WebSocket was never part of the MCP spec itself.

## Model choice matters

Agent mode works with whatever model you point it at, but only actually produces tool calls if
that model was trained for function/tool calling — a model without that training will just chat
normally and never call a tool. The Settings model browser flags models with reliable tool-calling
support with a 🔧 **Tool calling** badge (e.g. the Qwen3 family, Llama 3.1+, Mistral Nemo,
Qwen2.5-Coder, Devstral). The llama.cpp backend does not yet wire up tool-calling for Agent mode —
a clear error explains this if you try.
