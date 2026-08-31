const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const net = require("net");

const APP_DIR = path.resolve(__dirname, "../app");
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const MAIN_JS = path.join(APP_DIR, "dist", "main.js");
const MODELS_DIR = "/tmp/modelforge-tour-models";
const SCREENSHOT_DIR = "/tmp/modelforge-full-tour-screenshots";
fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
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

async function shot(window, name) {
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
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

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-tour-userdata-"));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-tour-workspace-"));
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true, llamaCppModelsDir: MODELS_DIR }, null, 2)
  );

  console.log("=== Launching Electron headless ===");
  const app = await electron.launch({
    executablePath: require(path.join(APP_DIR, "node_modules", "electron")),
    args: ["--headless=new", `--user-data-dir=${userDataDir}`, MAIN_JS],
    cwd: APP_DIR,
    env: { ...process.env, DISABLE_GPU: "1" },
    timeout: 30000,
  });

  const consoleErrors = [];
  const pageErrors = [];
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });
  window.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  window.on("pageerror", (e) => pageErrors.push(e.message));

  await window.waitForLoadState("domcontentloaded", { timeout: 15000 });
  await window.waitForTimeout(1200);

  async function goto(hash, label) {
    try {
      await window.evaluate((h) => { window.location.hash = h; }, hash);
      await window.waitForTimeout(700);
      await shot(window, label);
      report(`Navigated to ${hash}`, true);
    } catch (err) {
      report(`Navigated to ${hash}`, false, err.message);
    }
  }

  // --- Chat (home) ---
  await goto("#/", "01-chat");

  // --- Patient Cases: list (empty), create, detail ---
  await goto("#/cases", "02-patient-cases-list");
  try {
    const input = window.getByPlaceholder('e.g. "Synthetic case — chest pain workup"');
    await input.fill("Synthetic screenshot-tour case");
    await window.getByRole("button", { name: /new case/i }).click({ timeout: 5000 });
    await window.waitForTimeout(800);
    report("Created a patient case via UI", true);
    await shot(window, "03-patient-cases-list-with-case");
    await window.getByText("Synthetic screenshot-tour case").click({ timeout: 5000 });
    await window.waitForTimeout(800);
    await shot(window, "04-patient-case-detail");
    report("Opened patient case detail view", true);
  } catch (err) {
    report("Create + open a patient case", false, err.message);
    await shot(window, "04-patient-case-detail-FAIL");
  }

  // --- Evidence Library, Knowledge Graph, Audit & Privacy ---
  await goto("#/evidence", "05-evidence-library");
  await goto("#/knowledge-graph", "06-knowledge-graph");
  await goto("#/audit", "07-audit-privacy");

  // --- Compare, Usage, Downloads ---
  await goto("#/compare", "08-compare-models");
  await goto("#/usage", "09-usage-dashboard");
  await goto("#/downloads", "10-download-center");

  // --- Runtime Manager + all its tabs ---
  await goto("#/runtimes", "11-runtime-manager-overview");
  const runtimeTabs = ["Runtimes", "Workloads", "Models", "Environments", "Resource settings", "Fleet", "Logs & diagnostics"];
  for (const [i, tabName] of runtimeTabs.entries()) {
    try {
      await window.getByRole("tab", { name: tabName }).click({ timeout: 5000 });
      await window.waitForTimeout(600);
      await shot(window, `12-${(i + 1).toString().padStart(2, "0")}-runtime-manager-${tabName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
      report(`Runtime Manager tab "${tabName}" opens without crashing`, true);
    } catch (err) {
      report(`Runtime Manager tab "${tabName}" opens without crashing`, false, err.message);
    }
  }

  // --- Settings + all its tabs ---
  await goto("#/settings", "13-settings-general");
  const settingsTabs = [
    ["General", "general"],
    ["Models", "models"],
    ["Accounts", "accounts"],
    ["Integrations", "integrations"],
    ["Agent & Tools", "chat"],
    ["Voice", "voice"],
    ["Automation", "automation"],
    ["Usage & Diagnostics", "data"],
  ];
  for (const [i, [tabLabel, tabKey]] of settingsTabs.entries()) {
    try {
      await window.getByRole("tab", { name: new RegExp(`^${tabLabel}`, "i") }).click({ timeout: 5000 });
      await window.waitForTimeout(600);
      await shot(window, `14-${(i + 1).toString().padStart(2, "0")}-settings-${tabKey}`);
      report(`Settings tab "${tabLabel}" opens without crashing`, true);
    } catch (err) {
      report(`Settings tab "${tabLabel}" opens without crashing`, false, err.message);
    }
  }

  console.log("\n=== Console errors captured during run ===");
  if (consoleErrors.length === 0) console.log("(none)");
  else consoleErrors.forEach((e) => console.log("[console.error] " + e));

  console.log("\n=== Uncaught page errors captured during run ===");
  if (pageErrors.length === 0) console.log("(none)");
  else pageErrors.forEach((e) => console.log("[pageerror] " + e));

  await app.close();
  preview.kill();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });

  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}${r.detail ? " (" + r.detail + ")" : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nScreenshots written to ${SCREENSHOT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
