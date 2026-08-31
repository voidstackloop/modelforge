# Development guide

## Prerequisites

- [Node.js](https://nodejs.org) 22+
- A Rust toolchain (`cargo`) — only needed if you plan to rebuild the native downloader addon in
  `lib/`. Prebuilt binaries are checked into `app/native/`, so a normal `npm run dev` does not
  require Rust.
- A GGUF model for in-process llama.cpp testing, or a compatible CUDA/ROCm
  Linux/WSL environment for vLLM (neither is required to build or run unit tests).

## Getting the code running

```sh
git clone https://github.com/voidstackloop/modelforge.git
cd modelforge

npm install --prefix frontend
npm install --prefix app
```

`frontend` and `app` are independent npm projects — always pass `--prefix` (or `cd` into the
directory) rather than expecting a single top-level `npm install` to cover both.

### Development mode

```sh
npm run dev --prefix app
```

This runs three processes concurrently (`app/package.json`'s `dev` script, via `concurrently`):

1. `dev:renderer` — `vite` dev server for `frontend/`, on port 5173 with hot module reload.
2. `dev:main` — `tsc --watch` compiling `app/src/*.ts` to `app/dist/`.
3. `dev:electron` — waits for both of the above (`wait-on tcp:5173 dist/main.js`), then launches
   Electron pointed at the Vite dev server instead of the built `frontend/dist`.

Editing renderer code hot-reloads via Vite. Editing main-process code (`app/src/*.ts`) recompiles
automatically but requires restarting the Electron process to take effect (`tsc --watch` doesn't
restart Electron for you).

## Testing

```sh
npm test --prefix frontend
npm test --prefix app
```

Both use [Vitest](https://vitest.dev/). Test files sit next to the code they cover
(`foo.ts` → `foo.test.ts`), not in a separate `__tests__` tree.

- **Frontend tests** cover pure logic in `src/lib/` — pricing math, context compaction, keybinding
  parsing, provider capability lookups, tool-approval policy — rather than component rendering.
- **App tests** cover the store layer (atomic writes, corrupted-file recovery — see
  [Architecture: persistence pattern](ARCHITECTURE.md#persistence-pattern)), the agent tools
  (including path-traversal rejection and shell command execution), sandbox capability detection,
  and the RAG chunking/similarity logic.
- The Rust addon has its own test suite: `cd lib && cargo test` (mocks HTTP with `wiremock`).

Both `npm test` suites, plus lint, typecheck, and build for both packages, run in CI on every push
and pull request via [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Run the same
checks locally before opening a PR:

```sh
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build --prefix app
npm test --prefix frontend
npm test --prefix app
```

## Building a full production bundle

```sh
npm run build:all --prefix app
```

Runs, in order: `lib` native build (`napi build --platform --release`, output to `app/native/`) →
`frontend` production build (`tsc -b && vite build`, output to `frontend/dist/`) → `app` TypeScript
build (`tsc -p tsconfig.json`, output to `app/dist/`). This is what CI and `npm run package` both
build on top of.

## Packaging an installer

```sh
npm run package --prefix app
```

Runs `build:all` and then [electron-builder](https://www.electron.build/), producing a
platform-specific installer in `app/release/`:

| Platform | Output | electron-builder target |
|---|---|---|
| Windows | `Modelforge Setup *.exe` | NSIS (default) |
| macOS | `Modelforge-*.dmg` / `Modelforge-*-arm64.dmg` | `dmg`, both Intel and Apple Silicon |
| Linux | `Modelforge-*.AppImage` | `AppImage` |

Cross-compiling installers for another OS generally doesn't work with electron-builder — build on
(or in CI, via) the target platform. [`.github/workflows/release.yml`](../.github/workflows/release.yml)
builds all three in parallel (matrix over `windows-latest` / `macos-latest` / `ubuntu-latest`) when
a `v*.*.*` tag is pushed, and attaches the resulting installers to a GitHub Release — no signing
certificate is configured yet, so every platform's installer shows an "unknown publisher" warning
on first run; see the [README](../README.md#installation) for what that looks like for a user.

Each matrix leg's build step fails outright if its platform's installer doesn't actually show up in
`app/release/` (a `.exe` on Windows, a `.dmg` on macOS, an `.AppImage` on Linux) — electron-builder
can otherwise exit 0 having silently failed to produce one — and `publish-release` re-checks all
three are present in the merged download before creating the GitHub Release, so a build going out
without every platform's asset fails the workflow instead of quietly shipping a partial release.

### Adding signing later (not currently configured)

electron-builder picks up code-signing credentials from environment variables at build time — no
config file changes needed once these are set as repository secrets and threaded into
`release.yml`'s `env:` for the `Build` step on the relevant matrix leg. Nothing below is currently
set; this just documents the exact names so wiring it up later doesn't require re-deriving them
from electron-builder's docs.

**Windows** (Authenticode, applies to the `windows-latest` leg):
- `CSC_LINK` — URL or base64-encoded contents of the `.pfx`/`.p12` code-signing certificate.
- `CSC_KEY_PASSWORD` — the certificate's password.

**macOS signing + notarization** (applies to the `macos-latest` leg):
- `CSC_LINK` / `CSC_KEY_PASSWORD` — the Developer ID Application `.p12` certificate and its
  password (same variable names as Windows; electron-builder picks the right one from `mac`/`win`
  context).
- `APPLE_ID` — the Apple ID email used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD` — an app-specific password for that Apple ID (not the account
  password itself).
- `APPLE_TEAM_ID` — the Developer Team ID notarization submits under.

electron-builder reads all of these itself (via `@electron/notarize` for the Apple ones) — no code
changes to `app/package.json`'s `build` config are needed beyond what's already there, only adding
the secrets to the repo and passing them through as `env:` on the signing platform's job/step.

## Rebuilding the native addon

Only needed if you change `lib/src/*.rs`:

```sh
npm run build:native --prefix app
```

Equivalent to `cd lib && npm install && npm run build`, which invokes
`napi build --platform --release --output-dir ../app/native`. `napi`'s target list
(`lib/package.json`) covers `x86_64-pc-windows-msvc`, `x86_64-apple-darwin`,
`aarch64-apple-darwin`, and `x86_64-unknown-linux-gnu` — building for a target other than your
current host requires the matching Rust cross-compilation target installed.

## Project structure

```
frontend/          React + Vite renderer (the UI)
  src/pages/           Chat and Settings screens, Compare, Download Center, Runtime Manager, Usage Dashboard
  src/components/      Shared UI (layout, command palette, markdown/mermaid rendering, terminal panel, shadcn primitives)
  src/lib/              i18n, model catalogs, pricing estimates, provider helpers, tool-approval policy

app/                Electron main process
  src/main.ts           Window management, IPC handler registration (grep "ipcMain.handle" for the full API surface)
  src/preload.ts         The typed contextBridge surface exposed to the renderer as window.electronAPI
  src/providers/         llama.cpp/vLLM/OpenAI/Anthropic/Gemini/OpenAI-compatible chat + tool-calling adapters
  src/agent-tools.ts      Agent mode's full tool catalog (workspace-sandboxed filesystem/shell/git/network tools)
  src/command-sandbox.ts  OS-level command sandboxing (bubblewrap on Linux, sandbox-exec on macOS)
  src/*-store.ts          Settings/sessions/projects/secrets/scheduled-tasks persistence (atomic writes, corruption recovery)
  src/rag.ts              Chunking + embedding + retrieval for large folder attachments
  src/logger.ts           Rotating file logs surfaced via Settings → Data → Diagnostics

lib/                Rust native addon (napi-rs) — resumable, parallel-range GGUF downloads
  src/lib.rs             napi bindings
  src/manager.rs          Download orchestration
  src/download/           HTTP range-request logic

ml/hardware-recommender/   Standalone offline Python project — see its own README
```

See [Architecture](ARCHITECTURE.md) for how these pieces fit together and communicate, and
[Agent mode](AGENT_MODE.md) for the tool catalog and sandboxing model in detail.
