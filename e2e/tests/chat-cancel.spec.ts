import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "../fixtures/electron-app";
import { FAKE_LLAMACPP_ENV, controlFakeLlamaCpp, type FakeLlamaCppController } from "../fixtures/fake-llamacpp";

let modelsDir: string;
let instance: LaunchedApp;
let fakeLlamaCpp: FakeLlamaCppController;

const FAKE_MODEL_NAME = "fake-embedding-model.gguf";
const FAKE_MODEL_REF = `llamacpp:${FAKE_MODEL_NAME}`;

test.beforeEach(async () => {
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-cancel-models-"));
    fs.writeFileSync(path.join(modelsDir, FAKE_MODEL_NAME), Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.from([3, 0, 0, 0])]));

    instance = await launchApp({
        settings: { onboardingComplete: true, llamaCppModelsDir: modelsDir, defaultModel: FAKE_MODEL_REF },
        env: FAKE_LLAMACPP_ENV,
    });
    fakeLlamaCpp = controlFakeLlamaCpp(instance.app);
});

test.afterEach(async () => {
    await instance.close();
    fs.rmSync(modelsDir, { recursive: true, force: true });
});

test("cancelling an in-flight message returns the UI to a ready state", async () => {
    const { window } = instance;
    // A slow token stream gives the test a wide window to click Stop before
    // the fake response finishes on its own.
    await fakeLlamaCpp.setNextChatTurn({ tokens: ["one", "two", "three", "four", "five"], delayMs: 1000 });

    const input = window.getByPlaceholder("Send a message...");
    await input.fill("count slowly");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();

    const stopButton = window.getByRole("button", { name: "Stop generating" });
    await expect(stopButton).toBeVisible();
    await expect(input).toBeDisabled();

    await stopButton.click();

    // Ready state: input re-enabled, Send button back (not Stop), and the
    // partial response that did arrive is left in place rather than the UI
    // hanging on a spinner.
    await expect(window.getByRole("button", { name: "Stop generating" })).toBeHidden();
    await expect(sendButton).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("");
});
