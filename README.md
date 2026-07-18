# Modelforge

A desktop chat client for [Ollama](https://ollama.com) that also talks to OpenAI and Anthropic — one app for local and cloud models, built with Electron, React, and TypeScript.

![Chat view with a local Ollama model](docs/screenshots/chat.png)

## Features

- **Multi-provider chat** — local Ollama models plus OpenAI and Anthropic, with streaming responses, in one interface.
- **Projects** — group related chats under shared instructions and default model parameters.
- **Per-session and per-project overrides** — pin a specific prompt, model, context length, or temperature to a single chat or an entire project.
- **Prompt library** — save and reuse system prompts across chats.
- **File, image, video, and PDF attachments** — vision-capable models can see images and extracted video frames; PDFs and folders are parsed and, for large folders, retrieved via an in-app RAG pipeline (embeddings via Ollama).
- **Usage and cost tracking** — token counts and estimated cost per message and per session (Ollama usage is free/local).
- **Command palette** — `Ctrl/Cmd+K` to jump between chats, projects, and settings.
- **English and Turkish** UI localization.
- **Configurable Ollama host** — point at a remote Ollama server instead of localhost.
- **Data export/import** — back up or move your chat history.
- **Auto-updates** — packaged builds check GitHub Releases for new versions.

## Screenshots

<details>
<summary>Server, system info, and model catalog</summary>

![Ollama server settings, system specs, and available models](docs/screenshots/settings-server.png)

</details>

<details>
<summary>Browsing and pulling models</summary>

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

- **Windows** — `Modelforge Setup *.exe`
- **macOS** — `Modelforge-*.dmg`
- **Linux** — `Modelforge-*.AppImage`

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

## Building from source

Requires [Node.js](https://nodejs.org) 22+.

```sh
git clone https://github.com/SysTechSalihY/modelforge.git
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

- `frontend/` — React + Vite renderer (the UI), built to a single inlined HTML file so Electron can load it via `file://`.
- `app/` — Electron main process: window management, IPC handlers, provider integrations (Ollama/OpenAI/Anthropic), settings/session/project persistence, file and media processing, and packaging config.

## Contributing

Issues and pull requests are welcome. Please run `npm run lint` (frontend) and make sure both `frontend` and `app` build cleanly before opening a PR.

## License

[MIT](LICENSE)
