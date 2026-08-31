import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { launchApp, stubOpenDialog, type LaunchedApp } from "../fixtures/electron-app";
import { FAKE_LLAMACPP_ENV, controlFakeLlamaCpp, type FakeLlamaCppController } from "../fixtures/fake-llamacpp";

// docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2.5: llama.cpp previously had no
// e2e coverage at all — the existing chat-streaming.spec.ts and
// agent-tool-approval.spec.ts only ever exercise Ollama, since llama.cpp has
// no HTTP surface for fake-ollama.ts's approach to intercept. This is the
// first llama.cpp e2e coverage, proving the fake-module seam
// (fixtures/fake-llamacpp.ts) actually drives real chat-dispatch.ts /
// llamacpp-manager.ts logic end to end — model loading, streaming, and (new
// this session) tool-calling and its approval gate — not just unit-level
// mocks. Deliberately narrower than a full 1:1 port of every existing
// Ollama-focused spec: proving the seam works for the two riskiest new
// pieces (streaming, tool-calling) first; onboarding/cancel/response-
// contract llama.cpp variants are a natural, separately-scoped follow-up.
//
// NOT YET RUN in this environment — the WSL sandbox this was written in has
// no display server (no Xvfb/DISPLAY), so a real Electron window can't be
// launched here at all (same constraint already noted in
// reference_modelforge_dev_env for the CSP work). Typechecks cleanly and was
// written by closely mirroring chat-streaming.spec.ts's and
// agent-tool-approval.spec.ts's existing, already-passing patterns line by
// line, but has not been executed — verify on a real CI runner or a
// display-capable machine before trusting it blindly.

let modelsDir: string;
let workspaceDir: string;
let instance: LaunchedApp;
let fakeLlamaCpp: FakeLlamaCppController;

const FAKE_MODEL_NAME = "fake-embedding-model.gguf";
const FAKE_MODEL_REF = `llamacpp:${FAKE_MODEL_NAME}`;

test.beforeEach(async () => {
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-llamacpp-models-"));
    // assertValidGgufFile() (llamacpp-manager.ts, this session's own
    // hardening addition) checks the real GGUF magic header before ever
    // reaching the fake generation logic — this file needs to pass that
    // check like any other file in this models directory would.
    fs.writeFileSync(path.join(modelsDir, FAKE_MODEL_NAME), Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.from([3, 0, 0, 0])]));

    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-llamacpp-workspace-"));

    instance = await launchApp({
        settings: {
            onboardingComplete: true,
            llamaCppModelsDir: modelsDir,
            // Chat.tsx's default-model-selection effect only ever
            // auto-selects an Ollama model from the fetched list — llama.cpp
            // has no equivalent auto-select, so the default must be set
            // explicitly here rather than relying on list-based discovery
            // the way the Ollama specs do.
            defaultModel: FAKE_MODEL_REF,
        },
        env: FAKE_LLAMACPP_ENV,
    });
    fakeLlamaCpp = controlFakeLlamaCpp(instance.app);
    await stubOpenDialog(instance.app, workspaceDir);
});

test.afterEach(async () => {
    await instance.close();
    fs.rmSync(modelsDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test("sending a local llama.cpp chat message streams the response into the UI", async () => {
    const { window } = instance;
    await fakeLlamaCpp.setNextChatTurn({ tokens: ["The answer ", "is ", "42."] });

    const input = window.getByPlaceholder("Send a message...");
    await expect(input).toBeVisible();
    await input.fill("What is the answer?");

    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();

    const chatArea = window.getByRole("main");
    await expect(chatArea.getByText("What is the answer?")).toBeVisible();
    await expect(chatArea.getByText("The answer is 42.")).toBeVisible({ timeout: 15_000 });

    expect(await fakeLlamaCpp.getChatRequestCount()).toBe(1);
});

test("Agent mode: a llama.cpp tool call is gated behind Allow, and running it streams a real result", async () => {
    test.setTimeout(90_000);
    const { window } = instance;

    await window.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(window.getByRole("button", { name: /Agent/ })).toHaveAttribute("aria-pressed", "true");
    // Same coalescing hazard fake-ollama.ts's DEFAULT_DELAY_MS and
    // agent-tool-approval.spec.ts's own settle-before-send wait document —
    // let Agent-mode's own background IPC work land first.
    await window.waitForTimeout(300);

    await fakeLlamaCpp.setNextChatTurn({
        toolCall: { name: "run_command", arguments: { command: "echo hello-from-llamacpp-agent" } },
        delayMs: 250,
    });

    const input = window.getByPlaceholder("Send a message...");
    await input.fill("run a command for me");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 20_000 });
    await sendButton.click();

    await expect(window.getByRole("button", { name: "Allow" })).toBeVisible({ timeout: 30_000 });
    await window.getByRole("button", { name: "Allow" }).click();

    await expect(window.getByRole("button", { name: "Allow" })).toBeHidden();
    await expect(window.locator("pre", { hasText: "hello-from-llamacpp-agent" })).toBeVisible({ timeout: 20_000 });
    // The continuation turn (after the tool result is appended) falls back
    // to the fake module's own default turn, since setNextChatTurn's one-shot
    // value was already consumed by the tool-call turn above — proves the
    // agent loop's second dispatchChat() call actually completes rather than
    // hanging after approval.
    await expect(window.getByText("Hello from the fake llama.cpp backend.")).toBeVisible({ timeout: 20_000 });
});
