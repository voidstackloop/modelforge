# Architecture

Modelforge is an Electron desktop app split into three independently-buildable packages, plus a
standalone Python project used offline to train a small model:

```
frontend/   React 19 + Vite renderer — everything the user sees
app/        Electron main process — window/IPC/OS integration, provider adapters, persistence
lib/        Rust native addon (napi-rs) — the GGUF downloader's parallel-range HTTP engine
ml/         Standalone Python project — trains the hardware/model-fit recommender offline
```

`frontend` and `app` are separate npm workspaces (separate `package.json`, separate
`node_modules`) glued together only by the IPC bridge described below and by the build step that
copies `frontend/dist` into the packaged app as a static asset. `lib` is a separate Cargo crate
compiled to a native Node addon and copied into `app/native`. `ml`'s *training pipeline* is not
built by `npm run build:all` or run in CI — it's a separate, manual, offline step — but its
*output* (a small trained `.pt` file) is bundled as a resource (see `extraResources` /
`python` in `app/package.json`) and consumed at runtime by a managed Python worker; see
[ml/hardware-recommender/](#mlhardware-recommender) below for exactly how.

## Process model

Electron's two-process split is used exactly as intended, with nothing loosened for convenience:

- **Main process** (`app/src/main.ts`) — a normal Node.js process with full OS access. Owns the
  `BrowserWindow`, registers every `ipcMain.handle` channel, and is the only place that talks to
  Ollama, cloud provider APIs, the filesystem, child processes, and the OS keychain.
- **Renderer process** (`frontend/`) — the UI, running with `contextIsolation: true` and
  `nodeIntegration: false`. It has no direct access to Node or Electron APIs.
- **Preload script** (`app/src/preload.ts`) — the only bridge between them. It uses
  `contextBridge.exposeInMainWorld` to expose a fixed, typed `window.electronAPI` surface
  (see `frontend/src/types/electron.d.ts` for the renderer-side type). The renderer can only ever
  call the specific functions this file exposes — there is no generic "run arbitrary IPC channel"
  escape hatch.

This means every capability the UI has — reading a file, starting Ollama, calling a cloud
provider, writing a setting — exists because a corresponding `ipcMain.handle("namespace:action", …)`
was deliberately added in `main.ts` and mirrored in `preload.ts`. Grep for `ipcMain.handle` in
`app/src/main.ts` for the authoritative, current list of every capability the renderer has; the
channel names are namespaced by feature (`ollama:*`, `sessions:*`, `agent:*`, `downloads:*`,
`data:*`, and so on).

Streaming responses (chat tokens, download progress, terminal output) use the complementary
`event.sender.send(...)` / `ipcRenderer.on(...)` push channel rather than `invoke`, since `invoke`
is request/response only.

## Renderer (`frontend/`)

- **Routing / pages** (`src/pages/`): `Chat.tsx` (the main conversation view and Agent mode UI),
  `Settings.tsx` (by far the largest file in the app — every settings tab lives here),
  `Compare.tsx` (side-by-side multi-model prompting), `DownloadCenter.tsx`, `RuntimeManager.tsx`,
  `UsageDashboard.tsx`.
- **Shared components** (`src/components/`): layout chrome, the command palette, Markdown/Mermaid
  rendering, the onboarding wizard, the embedded terminal panel, and `ui/` — generated
  [shadcn](https://ui.shadcn.com/)-style primitives on top of Base UI.
- **`src/lib/`** — logic that isn't a component: i18n (`i18n.tsx`, `translations.ts`), the model
  catalog and pricing tables (`model-catalog.ts`, `pricing.ts`), provider capability metadata
  (`providers.ts`), context-window compaction (`context-compaction.ts`), keybindings, tool-approval
  policy (`tool-approval.ts` — see [Agent mode](AGENT_MODE.md)), and `sessions-context.tsx`, the
  React context that owns in-memory chat/session state and talks to the main process through
  `window.electronAPI`.

The renderer never talks to Ollama, OpenAI, Anthropic, etc. directly — every provider call is
proxied through the main process so API keys never need to reach the renderer's JS context, and so
CSP can block the renderer from making arbitrary network requests at all.

Production builds inline everything (JS, CSS, even encoded assets) into a single `index.html` via
`vite-plugin-singlefile`, so the packaged app can load the UI directly from `file://` without a
local HTTP server — matching how it's actually loaded in production, so `npm run dev` and a
packaged build exercise the same loading path in spirit.

## Main process (`app/src/`)

Roughly grouped by responsibility:

| Area | Files |
|---|---|
| Bootstrap | `main.ts` (window creation, all IPC registration), `menu.ts`, `preload.ts` |
| Provider adapters | `providers/openai.ts`, `providers/anthropic.ts`, `providers/gemini.ts`, `providers/openai-compatible.ts` (shared implementation for every OpenAI-compatible custom endpoint), `providers/sse.ts` (shared streaming parser), `providers/types.ts` |
| Local model runtimes | `ollama-manager.ts` (start/stop/pull/list against a local or remote Ollama daemon), `llamacpp-manager.ts` (GGUF inference via node-llama-cpp, GPU backend detection), `local-server-manager.ts` (custom OpenAI-compatible local backends: vLLM, LocalAI, TGI, etc.) |
| Agent mode | `agent-tools.ts` (every tool implementation, workspace sandboxing, the destructive-command blocklist), `command-sandbox.ts` (OS-level sandboxing via bubblewrap/`sandbox-exec` where available), `terminal-manager.ts` (the embedded PTY-backed terminal panel), `mcp-client.ts` (external MCP server connections) |
| Persistence | `json-store.ts` (shared atomic-write/corruption-recovery helper), `settings-store.ts`, `sessions-store.ts`, `projects-store.ts`, `secrets-store.ts` (OS-keychain-backed via Electron `safeStorage`), `scheduled-tasks-store.ts`, `download-jobs-store.ts`, `energy-usage-store.ts` |
| Retrieval | `rag.ts` / `rag-db.ts` — chunking, Ollama-embedding, and similarity search for large folder/file attachments |
| Models & downloads | `huggingface.ts` (Hub search API), `download-queue.ts` / `download-worker.ts` / `native-downloader.ts` (resumable parallel downloads, using the Rust addon when available), `download-verification.ts` (checksum/size verification) |
| System | `system-specs.ts` (RAM/VRAM detection across all GPUs), `resource-monitor.ts`, `power-monitor.ts`, `process-tree.ts`, `benchmark-runner.ts` |
| Integrations | `figma.ts`, `ocr.ts` (tesseract.js), `accounts.ts` (linked GitHub account), `scheduler.ts` (scheduled chat-completion tasks) |
| Misc | `logger.ts` (rotating file logs surfaced in Settings → Diagnostics), `updater.ts` (GitHub Releases auto-update), `data-transfer.ts` (export/import), `keybindings.ts`, `python-runtime-manager.ts` (manages the bundled Python workers under `app/python/`) |

### Persistence pattern

All app state (settings, sessions, projects, scheduled tasks, download jobs, energy history) is
plain JSON files under Electron's `userData` directory, going through the shared helpers in
`json-store.ts`:

- **Atomic writes** — write to a temp file, then rename over the real one. A rename is atomic on
  both Windows and POSIX filesystems, so a crash or power loss mid-write can never leave a reader
  looking at a half-written file.
- **Corruption recovery** — if an existing file fails to parse as JSON, it's copied aside as
  `<file>.corrupted-<timestamp>` and logged, rather than silently discarded. This means the next
  write can't accidentally overwrite salvageable data with a blank slate.

Secrets (provider API keys) go through `secrets-store.ts` instead, which encrypts values at rest
via Electron's `safeStorage` (backed by the OS credential store — Keychain, DPAPI, or
libsecret/kwallet) rather than writing them out as plain JSON. On a system with no OS credential
store available (`safeStorage.isEncryptionAvailable()` returns `false` — some keyring-less Linux
setups), the store falls back to writing the value unencrypted rather than silently dropping the
key; this fallback is logged at warn level, and `secrets:isEncryptionAvailable` lets the renderer
check the same condition to show a plaintext-storage warning in Settings instead of the normal
"encrypted at rest" note.

## Native addon (`lib/`)

A small Rust crate (`modelforge-native`), compiled with [napi-rs](https://napi.rs/) into a
platform-specific `.node` addon that `app/src` loads like any other Node module (see
`app/native/index.js`). Its only current job is `download_gguf_file`: resuming an interrupted
Hugging Face GGUF download and using parallel HTTP Range-request connections when the server and
file size support it, falling back to a single stream otherwise. It mirrors the signature and
observable behavior of the TypeScript downloader it can replace, so `download-queue.ts` can use
either implementation interchangeably depending on availability.

Build it with `npm run build:native --prefix app` (invokes `napi build` in `lib/`, which requires
a Rust toolchain); `npm run build:all --prefix app` does this as part of a full production build.
The prebuilt `.node` binaries checked into `app/native/` mean a plain `npm run dev` does **not**
require Rust installed — only rebuilding the native layer itself does.

## `ml/hardware-recommender/`

A standalone Python *training* project — see its own [README](../ml/hardware-recommender/README.md)
for details — that trains a small PyTorch multi-task model predicting hardware/model fit from the
public Open LLM Leaderboard catalog plus transparent memory/throughput heuristics (there's no
measured-compatibility dataset publicly available). Its trained output, `artifacts/hardware_recommender.pt`, *is* consumed at runtime — but through a
committed copy, not a live link to this directory: the checkpoint is duplicated to
`app/python/artifacts/hardware_recommender.pt`, and `app/python/recommender_worker.py` is a
trimmed, inference-only, self-contained reimplementation of this project's model architecture and
feature encoding (deliberately *not* importing `ml/hardware-recommender/recommend.py`, so the
packaged `app/python/` directory doesn't need this project's pandas/pyarrow training dependencies
just to run inference). `app/src/system-specs.ts` spawns that worker as a long-lived JSON-line
process via `app/src/python-runtime-manager.ts`'s `ManagedPythonWorker`, and calls
`recommendModelsWithML(...)` to enhance the plain-heuristic recommendation for each catalog model
with the trained model's prediction. If the worker isn't available (Python not installed, or the
worker is briefly unhealthy), `recommendModelsWithML` falls back to the pure heuristic per model
rather than blocking the recommendation — the ML path is a strict enhancement, never a dependency.
Retraining here and re-copying the updated `.pt`/worker logic into `app/python/` is a manual,
offline step — it is **not** part of `npm run build:all` or CI, so the two copies can drift if a
model change here isn't manually ported over.

## Data flow: sending a chat message

1. Renderer (`Chat.tsx` via `sessions-context.tsx`) calls `window.electronAPI.chat.send(...)`.
2. Preload forwards this to the `chat:send` IPC channel.
3. `main.ts` resolves the active provider (`ollama` / `llamacpp` / `openai` / `anthropic` /
   `gemini` / a custom OpenAI-compatible endpoint), decrypts its API key from `secrets-store` if
   needed, and calls the matching adapter in `providers/`.
4. The adapter opens a streaming HTTP request to the provider and, for each chunk, calls back into
   `main.ts`, which forwards it to the renderer over a per-request push channel
   (`chat:chunk:${requestId}`).
5. `sessions-context.tsx` appends chunks to the in-progress assistant message as they arrive and
   persists the finished message to `sessions-store.ts` once the stream ends.
6. If Agent mode is active and the model requests a tool call, the same request/response cycle
   happens per tool call via `agent:executeTool` (gated behind the Allow/Deny UI — see
   [Agent mode](AGENT_MODE.md)) before the conversation continues.

Cancellation works the same way in reverse: `chat:cancel` looks up the request's `AbortController`
in `main.ts`'s `activeChatRequests` map and aborts the in-flight HTTP request.

## See also

- [Agent mode](AGENT_MODE.md) — full tool list, sandboxing model, and approval flow
- [Development](DEVELOPMENT.md) — setup, running, testing, building, and releasing
