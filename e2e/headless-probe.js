const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

(async () => {
  const APP_DIR = path.resolve(__dirname, "../app");
  const MAIN_JS = path.join(APP_DIR, "dist", "main.js");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-headless-probe-"));
  try {
    const app = await electron.launch({
      executablePath: require(path.join(APP_DIR, "node_modules", "electron")),
      args: [
        "--headless=new",
        "--disable-gpu",
        `--user-data-dir=${userDataDir}`,
        MAIN_JS,
      ],
      cwd: APP_DIR,
      env: { ...process.env, DISABLE_GPU: "1" },
      timeout: 20000,
    });
    console.log("LAUNCH_SUCCESS");
    const window = await app.firstWindow();
    window.on("console", (m) => console.log("[console]", m.type(), m.text()));
    window.on("pageerror", (e) => console.log("[pageerror]", e.message));
    console.log("waiting for load state...");
    await window.waitForLoadState("domcontentloaded", { timeout: 15000 });
    console.log("URL:", window.url());
    await window.waitForTimeout(2000);
    const text = await window.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : "NO_BODY");
    console.log("BODY_TEXT:", JSON.stringify(text));
    const html = await window.evaluate(() => document.documentElement.outerHTML.slice(0, 500));
    console.log("HTML_HEAD:", html);
    await app.close();
  } catch (err) {
    console.log("LAUNCH_FAILED:", err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})();
