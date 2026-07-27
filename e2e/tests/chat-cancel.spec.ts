import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "../fixtures/electron-app";
import { startFakeOllama, type FakeOllamaServer } from "../fixtures/fake-ollama";

let fakeOllama: FakeOllamaServer;
let instance: LaunchedApp;

test.beforeAll(async () => {
    fakeOllama = await startFakeOllama();
});

test.afterAll(async () => {
    await fakeOllama.close();
});

test.beforeEach(async () => {
    instance = await launchApp({ settings: { onboardingComplete: true, ollamaHost: fakeOllama.url } });
});

test.afterEach(async () => {
    await instance.close();
});

test("cancelling an in-flight message returns the UI to a ready state", async () => {
    const { window } = instance;
    // A slow token stream gives the test a wide window to click Stop before
    // the fake response finishes on its own.
    fakeOllama.setNextChatTurn({ tokens: ["one", "two", "three", "four", "five"], delayMs: 1000 });

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
