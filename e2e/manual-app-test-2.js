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
const WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-manual-test-workspace2-"));
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

async function killPort(port) {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-lc", `fuser -k ${port}/tcp || true`]);
    p.on("close", () => resolve());
  });
}

async function main() {
  await killPort(5173);
  await new Promise((r) => setTimeout(r, 500));

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

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-manual-test2-userdata-"));
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    JSON.stringify(
      {
        onboardingComplete: true,
        llamaCppModelsDir: MODELS_DIR,
        defaultModel: "llamacpp:qwen2.5-1.5b-instruct-q4_k_m.gguf",
      },
      null,
      2
    )
  );

  console.log("=== Launching Electron headless (Qwen2.5-1.5B) ===");
  const app = await electron.launch({
    executablePath: require(path.join(APP_DIR, "node_modules", "electron")),
    args: ["--headless=new", `--user-data-dir=${userDataDir}`, MAIN_JS],
    cwd: APP_DIR,
    env: { ...process.env, DISABLE_GPU: "1" },
    timeout: 30000,
  });
  report("Electron process launched", true);

  const consoleErrors = [];
  const pageErrors = [];
  const window = await app.firstWindow();
  window.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  window.on("pageerror", (e) => pageErrors.push(e.message));

  await window.waitForLoadState("domcontentloaded", { timeout: 15000 });
  await window.waitForTimeout(1500);

  // Stub the native folder picker up front for Agent mode's workspace prompt.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] }));
  }, WORKSPACE_DIR);

  // --- Agent mode + real tool-calling with Qwen ---
  try {
    await window.getByRole("button", { name: "Agent", exact: true }).click({ timeout: 5000 });
    await window.waitForTimeout(500);
    const pressed = await window.getByRole("button", { name: /Agent/ }).getAttribute("aria-pressed");
    report("Agent mode enabled", pressed === "true");

    const input = window.getByPlaceholder("Send a message...");
    await input.fill("Run the shell command: echo hello-from-real-model");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await sendButton.waitFor({ state: "visible", timeout: 5000 });
    await window.waitForTimeout(2000); // let model load settle
    await sendButton.click({ timeout: 20000 });
    report("Sent a tool-use prompt to the real Qwen2.5-1.5B model", true);

    const allowSeen = await window.getByRole("button", { name: "Allow" }).waitFor({ state: "visible", timeout: 45000 }).then(() => true).catch(() => false);
    report("Model produced a real tool call, Allow/Deny approval card appeared", allowSeen);

    if (allowSeen) {
      await window.getByRole("button", { name: "Allow" }).click();
      const ranForReal = await window.locator("pre", { hasText: "hello-from-real-model" }).waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      report("Approved tool call actually executed (real command output visible)", ranForReal);
    }
  } catch (err) {
    report("Agent mode / tool-calling flow", false, err.message);
  }
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, "10-agent-toolcall.png") });

  // --- Sweep every Settings tab, watching for crashes ---
  const tabs = [
    "General",
    "Models & Hardware",
    "Accounts",
    "Integrations & MCP",
    "Agent & Tools",
    "Voice",
    "Automation",
    "Usage & Diagnostics",
  ];
  try {
    await window.getByRole("button", { name: "Settings" }).click({ timeout: 5000 });
    await window.waitForTimeout(500);
  } catch (err) {
    report("Open Settings", false, err.message);
  }
  for (const tabName of tabs) {
    try {
      await window.getByRole("tab", { name: tabName }).click({ timeout: 5000 });
      await window.waitForTimeout(400);
      report(`Settings tab "${tabName}" opens without crashing`, true);
    } catch (err) {
      report(`Settings tab "${tabName}" opens without crashing`, false, err.message);
    }
  }
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, "11-usage-diagnostics.png") });

  // --- Diagnostics copy button (touches the diagnostics shape I edited) ---
  try {
    await window.getByRole("button", { name: /Copy diagnostic info/i }).click({ timeout: 5000 });
    report("Copy diagnostic info button works without crashing", true);
  } catch (err) {
    report("Copy diagnostic info button works without crashing", false, err.message);
  }

  // --- RAG embedding dropdown actually lists the local GGUF models ---
  try {
    await window.getByRole("tab", { name: "General" }).click({ timeout: 5000 });
    await window.waitForTimeout(400);
    await window.getByRole("combobox", { name: /RAG embedding model/i }).click({ timeout: 5000 }).catch(async () => {
      await window.getByText("RAG embedding model", { exact: true }).locator("..").locator("button, [role=combobox]").first().click({ timeout: 5000 });
    });
    await window.waitForTimeout(400);
    const optionsText = await window.locator('[role="listbox"], [role="option"]').first().locator("..").innerText().catch(() => "");
    const listedModel = /qwen2\.5-1\.5b|SmolLM2/i.test(optionsText);
    report("RAG embedding dropdown lists local llama.cpp GGUF models", listedModel, optionsText.slice(0, 200));
  } catch (err) {
    report("RAG embedding dropdown lists local llama.cpp GGUF models", false, err.message);
  }
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, "12-rag-dropdown.png") });

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
