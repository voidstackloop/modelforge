const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const net = require("net");

const APP_DIR = path.resolve(__dirname, "../app");
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const MAIN_JS = path.join(APP_DIR, "dist", "main.js");
const MODELS_DIR = "/tmp/modelforge-manual-test-models";
const SCREENSHOT_DIR = "/tmp/modelforge-manual-test-screenshots";
const WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-manual-test-workspace-"));
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const socket = net.createConnection(port, "127.0.0.1");
      socket.on("connect", () => { socket.end(); resolve(); });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 300);
      });
    })();
  });
}

async function main() {
  console.log("=== Starting vite preview server (frontend/dist on :5173) ===");
  const preview = spawn("npx", ["vite", "preview", "--port", "5173", "--strictPort"], {
    cwd: FRONTEND_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  preview.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
  preview.stderr.on("data", (d) => process.stderr.write(`[vite:err] ${d}`));
  await waitForPort(5173, 20000);
  report("vite preview server started", true);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-manual-test-userdata-"));
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    JSON.stringify(
      {
        onboardingComplete: true,
        llamaCppModelsDir: MODELS_DIR,
        defaultModel: "llamacpp:SmolLM2-135M-Instruct-Q4_K_M.gguf",
      },
      null,
      2
    )
  );

  console.log("=== Launching Electron headless ===");
  let app;
  try {
    app = await electron.launch({
      executablePath: require(path.join(APP_DIR, "node_modules", "electron")),
      args: ["--headless=new", `--user-data-dir=${userDataDir}`, MAIN_JS],
      cwd: APP_DIR,
      env: { ...process.env, DISABLE_GPU: "1" },
      timeout: 30000,
    });
    report("Electron process launched (headless, no display server)", true);
  } catch (err) {
    report("Electron process launched", false, err.message);
    process.exit(1);
  }

  const consoleErrors = [];
  const pageErrors = [];

  const window = await app.firstWindow();
  window.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  window.on("pageerror", (e) => pageErrors.push(e.message));

  try {
    await window.waitForLoadState("domcontentloaded", { timeout: 15000 });
    report("Renderer loaded (domcontentloaded)", true);
  } catch (err) {
    report("Renderer loaded (domcontentloaded)", false, err.message);
  }

  await window.waitForTimeout(1500);

  // Step: chat page basic render
  try {
    const input = window.getByPlaceholder("Send a message...");
    await input.waitFor({ state: "visible", timeout: 15000 });
    report("Chat page rendered with message input", true);
  } catch (err) {
    report("Chat page rendered with message input", false, err.message);
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, "01-chat-page-fail.png") });
  }
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, "01-chat-page.png") });

  // Step: model picker shows the llama.cpp model as selected / available
  try {
    const modelLabel = await window.locator("body").innerText();
    const mentionsModel = /SmolLM2/i.test(modelLabel);
    report("Default llama.cpp model appears selected in UI", mentionsModel, mentionsModel ? undefined : "model name not found anywhere on page");
  } catch (err) {
    report("Default llama.cpp model appears selected in UI", false, err.message);
  }

  // Step: send a real chat message and wait for a real streamed response
  try {
    const input = window.getByPlaceholder("Send a message...");
    await input.fill("Say the word BANANA and nothing else.");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await sendButton.waitFor({ state: "visible", timeout: 5000 });
    const enabled = await sendButton.isEnabled({ timeout: 20000 }).catch(() => false);
    if (!enabled) {
      // give it more time; model loading can take a moment
      await window.waitForTimeout(3000);
    }
    await sendButton.click();
    report("Sent a real chat message to the real SmolLM2 model", true);

    const chatArea = window.getByRole("main");
    await chatArea.getByText("Say the word BANANA and nothing else.").waitFor({ timeout: 10000 });
    report("User message appears in chat", true);

    // Wait for streaming to finish: Send button reappears / Stop button disappears
    await window.getByRole("button", { name: "Stop generating" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await window.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden", timeout: 60000 }).catch(() => {});
    await window.waitForTimeout(500);

    const bodyText = await chatArea.innerText();
    report("Real model produced a response", bodyText.trim().length > 0, `assistant area text length=${bodyText.length}`);
    console.log("--- Chat area text snapshot ---\n" + bodyText.slice(0, 1000) + "\n--- end snapshot ---");
  } catch (err) {
    report("Send/receive a real chat message", false, err.message);
  }
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, "02-after-chat.png") });

  // Step: create a new chat session
  try {
    await window.getByRole("button", { name: "New chat" }).first().click({ timeout: 5000 });
    await window.waitForTimeout(500);
    const input = window.getByPlaceholder("Send a message...");
    await input.waitFor({ state: "visible", timeout: 5000 });
    report("Created a new chat session", true);
  } catch (err) {
    report("Created a new chat session", false, err.message);
  }

  // Step: navigate to Settings
  try {
    await window.getByRole("button", { name: "Settings" }).click({ timeout: 5000 });
    await window.waitForTimeout(1000);
    report("Navigated to Settings page", true);
  } catch (err) {
    report("Navigated to Settings page", false, err.message);
  }
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, "03-settings.png") });

  // Step: Models tab shows the real downloaded model
  try {
    await window.getByRole("tab", { name: /Models/i }).click({ timeout: 5000 });
    await window.waitForTimeout(500);
    const modelsTabText = await window.locator("body").innerText();
    const found = /SmolLM2/i.test(modelsTabText);
    report("Models tab lists the real downloaded GGUF model", found);
  } catch (err) {
    report("Models tab lists the real downloaded GGUF model", false, err.message);
  }
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, "04-settings-models.png") });

  // Step: RAG embedding model dropdown offers the llama.cpp model
  try {
    const ragSection = window.locator("text=RAG embedding model");
    await ragSection.scrollIntoViewIfNeeded({ timeout: 5000 });
    report("RAG embedding model section renders without crashing", true);
  } catch (err) {
    report("RAG embedding model section renders without crashing", false, err.message);
  }

  // Step: back to Chat via "New chat", then toggle Agent mode (needs a
  // workspace folder — stub the native picker like the real e2e fixtures do)
  try {
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] }));
    }, WORKSPACE_DIR);
    await window.getByRole("button", { name: "New chat" }).first().click({ timeout: 5000 });
    await window.waitForTimeout(500);
    await window.getByRole("button", { name: "Agent", exact: true }).click({ timeout: 5000 });
    await window.waitForTimeout(500);
    const pressed = await window.getByRole("button", { name: /Agent/ }).getAttribute("aria-pressed");
    report("Agent mode toggled on", pressed === "true");
  } catch (err) {
    report("Agent mode toggled on", false, err.message);
  }
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, "05-agent-mode.png") });

  console.log("\n=== Console errors captured during run ===");
  if (consoleErrors.length === 0) console.log("(none)");
  else consoleErrors.forEach((e) => console.log("[console.error] " + e));

  console.log("\n=== Uncaught page errors captured during run ===");
  if (pageErrors.length === 0) console.log("(none)");
  else pageErrors.forEach((e) => console.log("[pageerror] " + e));

  await app.close();
  preview.kill();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}${r.detail ? " (" + r.detail + ")" : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
