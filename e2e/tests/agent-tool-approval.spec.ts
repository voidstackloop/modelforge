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

    fakeOllama.setNextChatTurn({ toolCall: { name: "run_command", arguments: { command: "echo hello-from-agent" } } });

    const input = window.getByPlaceholder("Send a message...");
    await input.fill("run a command for me");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();
}

test("Deny stops the tool from running and the card clears", async () => {
    const { window } = instance;
    await enableAgentModeAndSendToolCallingMessage(instance);

    // "run_command" appears twice once the card is up (the tool-call summary
    // line and the pending-call header) — anchor on the Allow/Deny buttons
    // themselves, which is what actually defines "the approval card showed".
    await expect(window.getByRole("button", { name: "Allow" })).toBeVisible({ timeout: 15_000 });
    await window.getByRole("button", { name: "Deny" }).click();

    await expect(window.getByRole("button", { name: "Deny" })).toBeHidden();
    // The agent loop still completes (with the model told it was denied) —
    // the whole turn doesn't hang after a denial.
    await expect(window.getByText("Hello from the fake model.")).toBeVisible({ timeout: 15_000 });

    // Nothing the denied command would have produced actually happened.
    expect(fs.readdirSync(workspaceDir)).toEqual([]);
});

test("Allow runs the tool for real and the card clears", async () => {
    const { window } = instance;
    await enableAgentModeAndSendToolCallingMessage(instance);

    await expect(window.getByRole("button", { name: "Allow" })).toBeVisible({ timeout: 15_000 });
    await window.getByRole("button", { name: "Allow" }).click();

    await expect(window.getByRole("button", { name: "Allow" })).toBeHidden();
    // The tool result card (not the earlier pending-call summary line, which
    // also still mentions the command) — proof the command actually ran.
    await expect(window.locator("pre", { hasText: "hello-from-agent" })).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText("Hello from the fake model.")).toBeVisible({ timeout: 15_000 });
});
