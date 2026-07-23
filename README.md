# Modelforge

[![CI](https://github.com/voidstackloop/modelforge/actions/workflows/ci.yml/badge.svg)](https://github.com/voidstackloop/modelforge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/voidstackloop/modelforge)](https://github.com/voidstackloop/modelforge/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A cross-platform desktop client that unifies local and cloud AI models in one interface: [Ollama](https://ollama.com) for local inference, plus OpenAI and Anthropic for cloud models. Built with Electron, React, and TypeScript.

Beyond chat, Modelforge includes an **agentic mode** — the model can read/write files and run shell commands in a folder you choose, with every action gated behind your explicit approval.

![Chat view with a local Ollama model](docs/screenshots/chat.png)

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Installation](#installation)
- [Quick start](#quick-start-try-it-in-5-minutes)
- [Agent mode](#agent-mode)
- [Building from source](#building-from-source)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Features

**Chat & providers**
- Local Ollama models, OpenAI, Anthropic, **and llama.cpp** in one interface, with token-by-token streaming.
- **llama.cpp backend** — run GGUF models directly via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) instead of Ollama, with **Vulkan**, CUDA, or Metal GPU acceleration (auto-detected, selectable in Settings). Useful for Vulkan acceleration or models Ollama doesn't package. This is an *additional* backend, not a replacement — Ollama is still fully supported side by side. Agent mode tool-calling isn't wired up for this backend yet (a clear error explains this if you try); everything else (streaming, GPU offload, all the generation parameters) works the same as any other provider. Model weights load once and stay warm across messages, but each turn currently re-evaluates the full conversation from scratch rather than reusing a cache across turns — correct, but slower on long conversations than it could be.
- Vision support — attach images (or extract frames from a video) for models that can see them. When an image is attached, an **"Analyze as..."** menu fills the composer with a ready-made prompt for common diagram/wireframe tasks — describe the UI, convert it to a Mermaid diagram, generate React + Tailwind code from it, list its components, or review it for usability/accessibility issues.
- Live token usage and estimated cost per message and per session (Ollama is free/local; cloud providers show a running estimate).

**Organization**
- **Projects** — group related chats under shared instructions and default model parameters.
- **Per-session and per-project overrides** — pin a specific prompt, model, temperature, seed, top-K/top-P, repeat penalty, context length, GPU offload, or stop sequences to a single chat or an entire project, falling back to sane defaults. Provider-specific parameters (e.g. seed isn't supported by Claude, top-K isn't supported by ChatGPT) are automatically disabled when they don't apply to the selected model.
- **Prompt library** — save and reuse system prompts across chats. Prompts can include `{{variables}}` (e.g. `{{topic}}`) that you fill in each time you apply one, and edits keep version history so a bad change can be restored.
- **Command palette** (`Ctrl/Cmd+K`) — jump between chats, projects, settings, and Compare without touching the mouse.
- **Keyboard shortcuts cheat-sheet** (`Ctrl/Cmd+/`, or the keyboard icon next to Settings) — everything you can do without the mouse, in one place.
- **Compare models** — send one prompt to several models at once (local or cloud) and see every response stream in side by side, with per-model token counts and cost estimates.
- **Full-text search** — the sidebar search box matches message content across every chat, not just titles.
- **Tags** — label chats with freeform tags and filter the sidebar by them; lighter-weight than Projects for ad-hoc organization.
- **Pin messages** — bookmark any message in a chat and jump straight to it from a "Pinned" panel in the toolbar.
- **Fork a conversation** — branch a new chat from any earlier message, keeping everything up to that point and continuing independently from there.

**Files & retrieval**
- Attach files, folders, images, video, and PDFs directly into a conversation.
- Large folders are automatically chunked, embedded (via Ollama), and retrieved by relevance instead of dumped whole into the prompt — so a big project doesn't blow out a small model's context window.
- **Screenshot capture** — pick a screen or window from the Attach menu and it's captured and attached as an image, no separate screenshot tool needed. (macOS may require granting Screen Recording permission the first time.)
- **OCR** — extract plain text from any attached image with one click, dropped straight into the composer. Runs fully offline via [tesseract.js](https://github.com/naptha/tesseract.js) after its first use (which needs network access once, to download the ~2MB English text-recognition model).
- **Figma frame import** — add a personal access token in Settings → Integrations, then paste a "Copy link to selection" URL from Figma to fetch that frame as an image, attached like any other screenshot.
- **Prompt library sharing** — export your saved prompts to a JSON file and import one a teammate sent you (Settings → Chat & Prompts). There's no live sync — it's just a plain file, sent however you like.

**Agent mode** — see the [dedicated section](#agent-mode) below.

**Models & hardware**
- Model recommendations based on your actual hardware — RAM and VRAM are detected and summed **across all GPUs**, not just the first one, so multi-GPU machines get accurate suggestions.
- **GPU offload control** — set how many model layers Ollama offloads to GPU (`num_gpu`) per chat, per project, or as a global default; leave it blank to let Ollama decide automatically.
- **Real Hugging Face search** — typing in the model search box queries the actual Hugging Face Hub API (not just "paste an exact URL"), showing real repos ranked by downloads/likes; expand one to see its actual GGUF files with real file sizes, then either pull it via Ollama or download it directly for the llama.cpp backend. Pasting an exact `hf.co/user/repo` tag or a full URL still works too, for Ollama's own pull mechanism.
- Models with reliable tool/function-calling support are flagged with a 🔧 badge, so picking a good Agent mode model doesn't require guesswork.
- **Custom model storage location** — Settings → General → Ollama Server → "Model storage location" lets you point downloaded models at any folder (e.g. a larger or faster drive) instead of Ollama's default location. If this app started Ollama, it restarts it automatically with the new location; if Ollama is running outside the app, you're told to restart it yourself.

**Customization & control**
- **Settings is organized into tabs** (General, Models, Integrations, Chat & Prompts, Voice, Data) instead of one long scrolling page — it holds up better as more settings get added over time.
- English and Turkish UI localization.
- **Theming** — light/dark/system color mode plus a choice of accent colors (default gray, blue, green, purple, orange, rose), in Settings → General → Appearance.
- Configurable Ollama host — point at a remote server instead of localhost.
- Data export/import, and one-click "copy diagnostic info" for bug reports.
- **Updates** — packaged builds check GitHub Releases for new versions automatically on launch, plus a manual "Check for updates" button in Settings (also available from the app menu).

**Voice**
- **Voice input** — record a question with the mic button; it's transcribed via OpenAI's Whisper API and dropped into the composer (requires an OpenAI API key in Settings, even when chatting with a local Ollama model).
- **Read aloud** — any assistant reply can be played back through your OS's own text-to-speech voices, with a per-message speaker button, an optional "auto-read every response" toggle, and a voice picker with a test button in Settings → Voice tab. Works fully offline, no API key needed.
- Both are start/stop/cancel controllable mid-action — stop a reply from being read, or cancel a recording before it's sent for transcription.
- Not included: fully real-time, bidirectional voice conversation (speaking over the model and having it react instantly, à la OpenAI's Realtime API). That's a different streaming architecture and hasn't been built.

## Screenshots

<details>
<summary>Server, system info, and model catalog</summary>

![Ollama server settings, system specs, and available models](docs/screenshots/settings-server.png)

</details>

<details>
<summary>Browsing and pulling models, with tool-calling badges for Agent mode</summary>

![Model catalog with recommendations based on your hardware](docs/screenshots/settings-models.png)

</details>

<details>
<summary>Chat defaults and prompt library</summary>

![Default model parameters and saved prompt presets](docs/screenshots/settings-chat-defaults.png)

</details>

<details>
<summary>Data management and diagnostics</summary>

![Export/import/clear conversations and copy diagnostic info](docs/screenshots/settings-diagnostics.png)

</details>

## Installation

Download the latest installer for your platform from the [Releases](../../releases) page.

| Platform | File | Notes |
|---|---|---|
| Windows | `Modelforge Setup *.exe` | Unsigned — Windows SmartScreen will warn on first run ("Unknown publisher"); click **More info → Run anyway**. |
| macOS | `Modelforge-*.dmg` (Intel) / `Modelforge-*-arm64.dmg` (Apple Silicon) | ⚠️ **Not yet verified on real hardware.** Builds for both architectures and should run — Electron is cross-platform and nothing in this codebase is OS-specific — but no one has confirmed it on an actual Mac. Also unsigned/unnotarized, so Gatekeeper will block it until you right-click → **Open**. Please [open an issue](../../issues) if you try it, either way. |
| Linux | `Modelforge-*.AppImage` | Make it executable (`chmod +x`) and run directly, or use your AppImage launcher of choice. |

No installer signing certificate is configured yet, so every platform will show some form of "unknown publisher" warning on first launch — this is expected for an unsigned build, not a sign of a corrupted download.

Modelforge talks to a local [Ollama](https://ollama.com) install by default — no API key required. OpenAI and Anthropic support is optional: add your API key in **Settings** only if you want to use those providers.

## Quick start: try it in 5 minutes

1. **Install [Ollama](https://ollama.com/download)** and pull a small model to test with: `ollama pull llama3.2`.
2. **Install and launch Modelforge.** On first launch it detects your local Ollama install automatically — no setup screen, no account, no API key.
3. **Send a message.** Pick `llama3.2` from the model dropdown and chat — you should see the response stream in token-by-token.
4. **Try an attachment.** Drop in an image (with a vision-capable model like `llama3.2-vision`) or a PDF and ask a question about it.
5. **Create a Project.** Group a couple of chats under one project with a shared system prompt, and confirm new chats in that project inherit it.
6. **Open the command palette** with `Ctrl/Cmd+K` and jump between chats without touching the mouse.
7. **Check Settings** — switch the UI language (English/Turkish), add an OpenAI or Anthropic key if you want to compare a cloud model side-by-side with a local one, or point "Ollama host" at a remote server.

If steps 2–3 work, the core app is functioning correctly — everything else layers on top of that same chat pipeline.

## Agent mode

Click **Agent** in the chat toolbar and pick a folder — that becomes the model's sandboxed workspace for the rest of the conversation. The model can then call:

| Tool | What it does |
|---|---|
| `read_file` | Read a text file in the workspace |
| `write_file` | Create or overwrite a file (creates parent directories as needed) |
| `list_dir` | List files and subdirectories |
| `search_files` | Search for a text string across the workspace |
| `run_command` | Execute a shell command in the workspace (or a subfolder), with a 60s timeout |
| `run_code` | Run a Python or JavaScript snippet — a convenience over shell-quoting multi-line code through `run_command`, not a new capability |
| `git_status`, `git_diff`, `git_log` | Read-only git helpers (auto-approvable, like the file tools) so the model doesn't need to guess flag syntax |
| `git_commit` | Stage everything and commit — requires approval, like `write_file` |

**Safety model:**
- `read_file`, `write_file`, `list_dir`, and `search_files` are genuinely confined to the chosen workspace folder — path-traversal attempts (`../../etc`, absolute paths elsewhere on disk) are rejected before anything runs.
- `run_command` and `run_code` are different: a shell command (or a script `run_code` hands to `python3`/`node`) is opaque text that can reference any path on the system regardless of its working directory, so neither is sandboxed the way the file tools are. As a safety net, commands (and `run_code`'s source text) matching destructive or system-level patterns — deleting outside the workspace, formatting a drive, shutting down the machine, registry deletion, `sudo`/`runas`, piping a remote script into a shell — are **rejected outright**, even if already approved. This blocklist catches the common catastrophic cases, not everything a shell or script can do — only approve a command or snippet you actually understand.
- Every call (including ones the blocklist doesn't catch) shows an **Allow / Deny** card before it executes — nothing runs without an explicit click. Read-only tools (`read_file`, `list_dir`, `search_files`, `git_status`, `git_diff`, `git_log`) can be marked "always allow this session" to cut down on repetitive approvals; `write_file`, `run_command`, `run_code`, and `git_commit` always require a fresh click, since they have real, potentially irreversible effects.
- A per-turn step limit (25 tool-result → model-continuation round trips) stops a model from looping indefinitely without producing a final answer.
- The trust list for "always allow" is in-memory only — closing and reopening a chat resets it.

**Preview & Rollback:**
- A pending `write_file` call shows a real **line-by-line diff** against the file's current content (or a "new file" badge if it doesn't exist yet) instead of a raw argument dump, so you can see exactly what would change before clicking Allow.
- **Undo last edit** reverts the most recent applied `write_file` — restoring the previous content, or deleting the file if the edit created it. Undo history is per-workspace, capped at the last 20 writes, and lives only in memory for the running session (not a durable version history).

**Quick actions:** if the workspace has `test`/`lint`/`format` scripts in its `package.json`, **Run Tests**, **Lint**, and **Format** buttons appear in the toolbar — they run the corresponding `npm` script directly (reusing the same sandboxing as `run_command`) and drop the output into the chat, without going through the model.

**MCP (Model Context Protocol) servers:** add external MCP servers in Settings to give Agent mode extra tools — anything from a database query tool to a browser-automation server. Two transports are supported:
- **stdio** — launches a local command (e.g. `npx -y @modelcontextprotocol/server-filesystem /some/path`) and speaks JSON-RPC over its stdin/stdout.
- **HTTP** — connects to a remote MCP server's "Streamable HTTP" endpoint.

Enabled servers reconnect automatically on launch; each server's tools appear in Agent mode's tool list prefixed with the server's name, going through the exact same Allow/Deny approval flow as built-in tools. (SSE and plain WebSocket transports aren't implemented — SSE is the legacy MCP HTTP transport, now superseded by Streamable HTTP, and WebSocket isn't part of the MCP spec itself.)

**Model choice matters.** Agent mode works with whatever model you point it at, but only actually produces tool calls if that model was trained for function/tool calling — a model without that training will just chat normally and never call a tool. The Settings model browser flags models with reliable tool-calling support with a 🔧 **Tool calling** badge (e.g. the Qwen3 family, Llama 3.1+, Mistral Nemo, Qwen2.5-Coder, Devstral).

## Building from source

Requires [Node.js](https://nodejs.org) 22+.

```sh
git clone https://github.com/voidstackloop/modelforge.git
cd modelforge

# install dependencies
npm install --prefix frontend
npm install --prefix app

# run in development (starts the Vite dev server + Electron)
npm run dev --prefix app

# build a distributable installer for your current platform
npm run package --prefix app
```

Packaged installers are written to `app/release/`.

## Project structure

```
frontend/          React + Vite renderer (the UI)
  src/pages/          Chat and Settings screens
  src/components/     Shared UI (layout, command palette, markdown rendering, shadcn primitives)
  src/lib/            i18n, model catalogs, pricing estimates, provider helpers

app/                Electron main process
  src/main.ts           Window management, IPC handler registration
  src/providers/        Ollama/OpenAI/Anthropic chat + tool-calling adapters
  src/agent-tools.ts     Agent mode's file/shell tool implementations (workspace-sandboxed)
  src/*-store.ts         Settings/sessions/projects/secrets persistence (atomic writes, corruption recovery)
  src/rag.ts             Chunking + embedding + retrieval for large folder attachments
  src/logger.ts          Rotating file logs surfaced via Settings → Data → Diagnostics
```

The frontend builds to a single inlined HTML file (`vite-plugin-singlefile`) so Electron can load it directly via `file://` in production, matching how the packaged app actually runs.

## Testing

```sh
npm test --prefix frontend
npm test --prefix app
```

The `app` suite covers the store layer (atomic writes, corrupted-file recovery), the agent tools (including path-traversal rejection and shell command execution), and the RAG chunking/similarity logic. Both suites run in CI on every push and pull request via [`.github/workflows/ci.yml`](.github/workflows/ci.yml), which also lints, typechecks, and builds both packages.

## Security

- **Process isolation**: `contextIsolation: true`, `nodeIntegration: false` — the renderer only ever talks to the main process through an explicit, typed preload bridge.
- **Content Security Policy** restricting plugins, frames, and form submissions; external links open in your default browser instead of an unmanaged Electron window.
- **API keys** are encrypted at rest via the OS credential store (`safeStorage`) and never leave the device.
- **Agent mode** tool calls are workspace-sandboxed (path-traversal rejected) and require explicit per-call approval — see [Agent mode](#agent-mode) above.
- No telemetry, no analytics, no data sent anywhere except directly to whichever provider (Ollama, OpenAI, Anthropic) you've configured.

## Contributing

Issues and pull requests are welcome. Before opening a PR, please make sure:

```sh
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build --prefix app
npm test --prefix frontend
npm test --prefix app
```

all pass — this is the same set of checks CI runs.

## License

[MIT](LICENSE)
