import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { launchApp, stubOpenDialog, type LaunchedApp } from "../fixtures/electron-app";
import { startFakeOllama, type FakeOllamaServer } from "../fixtures/fake-ollama";

// Agent mode's Allow/Deny card (docs/AGENT_MODE.md's tool-approval model) is
// the most security-relevant UI surface in the app: every tool call the
// model makes is supposed to be gated behind an explicit click, with no path
// that lets a tool run unattended. This exercises both outcomes end to end —
// through the real IPC bridge and a real (sandboxed, harmless) command
// execution on Allow, not a mocked approval handler.

// The Allow/Deny wait below alone can take 30s on a slow CI runner; the
// config's default 60s per-test budget leaves too little room for the setup
// and follow-up assertions around it.
test.setTimeout(90_000);

let fakeOllama: FakeOllamaServer;
let instance: LaunchedApp;
let workspaceDir: string;

test.beforeAll(async () => {
    fakeOllama = await startFakeOllama();
});

test.afterAll(async () => {
    await fakeOllama.close();
});

test.beforeEach(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-workspace-"));
    instance = await launchApp({ settings: { onboardingComplete: true, ollamaHost: fakeOllama.url } });
    await stubOpenDialog(instance.app, workspaceDir);

    // Both agent-tool-approval tests have failed on CI (never locally) with
    // no other signal than "Allow never appeared" — surface renderer
    // console/errors directly in the CI step's own stdout (no artifact
    // download needed) so a future failure actually says why.
    instance.window.on("console", (m) => console.log(`[renderer:${m.type()}] ${m.text()}`));
    instance.window.on("pageerror", (e) => console.log(`[renderer:pageerror] ${e.stack ?? e.message}`));
});

test.afterEach(async () => {
    await instance.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
});

async function enableAgentModeAndSendToolCallingMessage(instance_: LaunchedApp): Promise<void> {
    const { window } = instance_;
    // toggleAgentMode() in frontend/src/pages/Chat.tsx calls
    // agent.pickWorkspace() (a native dialog stubbed above) the first time
    // agent mode turns on for a session.
    await window.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(window.getByRole("button", { name: /Agent/ })).toHaveAttribute("aria-pressed", "true");

    // Enabling agent mode kicks off its own IPC round trips in the
    // background (sessions:update, agentTools.detectProjectScripts() via the
    // agentWorkspace effect) — sending the chat message immediately risks
    // its single-chunk tool-call response's webContents.send() landing in
    // the same event-loop tick as one of those, which Electron can coalesce
    // away silently (this is the same class of bug worked around in
    // fake-ollama.ts's DEFAULT_DELAY_MS, just triggered by a different
    // neighbor now that agent mode is in play). Letting things settle first
    // is cheaper and more direct than only padding the response delay.
    await window.waitForTimeout(300);

    fakeOllama.setNextChatTurn({
        toolCall: { name: "run_command", arguments: { command: "echo hello-from-agent" } },
        // Wider than the fixture's own default — this response is a single
        // chunk carrying the *entire* tool call, so if Electron drops it,
        // there's no partial content left behind to recover; CI has shown
        // this needs more headroom than plain streaming does.
        delayMs: 250,
    });

    const input = window.getByPlaceholder("Send a message...");
    await input.fill("run a command for me");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 20_000 });
    await sendButton.click();

    // Narrows "the request never reached the fake server" from "it reached
    // it but the response never rendered" — cheap, and the only thing that
    // can actually tell those two apart from the CI log alone.
    await instance_.window.waitForTimeout(500);
    console.log(`[diagnostic] fakeOllama chat request count after send: ${fakeOllama.getChatRequestCount()}`);
}

test("Deny stops the tool from running and the card clears", async () => {
    const { window } = instance;
    await enableAgentModeAndSendToolCallingMessage(instance);

    // "run_command" appears twice once the card is up (the tool-call summary
    // line and the pending-call header) — anchor on the Allow/Deny buttons
    // themselves, which is what actually defines "the approval card showed".
    // Generous on top of the config's own CI-aware expect timeout: this
    // specific wait spans agent-workspace setup (a real IPC round trip plus
    // agentTools.detectProjectScripts()) and a full chat request/response
    // round trip through the fake Ollama server — the longest chain of
    // async work in this suite, and the one most exposed to a slower/shared
    // CI runner.
    await expect(window.getByRole("button", { name: "Allow" })).toBeVisible({ timeout: 30_000 });
    await window.getByRole("button", { name: "Deny" }).click();

    await expect(window.getByRole("button", { name: "Deny" })).toBeHidden();
    // The agent loop still completes (with the model told it was denied) —
    // the whole turn doesn't hang after a denial.
    await expect(window.getByText("Hello from the fake model.")).toBeVisible({ timeout: 20_000 });

    // Nothing the denied command would have produced actually happened.
    expect(fs.readdirSync(workspaceDir)).toEqual([]);
});

test("Allow runs the tool for real and the card clears", async () => {
    const { window } = instance;
    await enableAgentModeAndSendToolCallingMessage(instance);

    // Generous on top of the config's own CI-aware expect timeout: this
    // specific wait spans agent-workspace setup (a real IPC round trip plus
    // agentTools.detectProjectScripts()) and a full chat request/response
    // round trip through the fake Ollama server — the longest chain of
    // async work in this suite, and the one most exposed to a slower/shared
    // CI runner.
    await expect(window.getByRole("button", { name: "Allow" })).toBeVisible({ timeout: 30_000 });
    await window.getByRole("button", { name: "Allow" }).click();

    await expect(window.getByRole("button", { name: "Allow" })).toBeHidden();
    // The tool result card (not the earlier pending-call summary line, which
    // also still mentions the command) — proof the command actually ran.
    await expect(window.locator("pre", { hasText: "hello-from-agent" })).toBeVisible({ timeout: 20_000 });
    await expect(window.getByText("Hello from the fake model.")).toBeVisible({ timeout: 20_000 });
});
