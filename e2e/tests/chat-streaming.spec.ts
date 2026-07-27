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

test("sending a local chat message streams the response into the UI", async () => {
    const { window } = instance;
    fakeOllama.setNextChatTurn({ tokens: ["The answer ", "is ", "42."] });

    const input = window.getByPlaceholder("Send a message...");
    await expect(input).toBeVisible();
    await input.fill("What is the answer?");

    // The send button stays disabled until frontend/src/pages/Chat.tsx has
    // picked a model — it auto-selects the fake server's one listed model
    // (from app/src/ollama-manager.ts's /api/tags) once that fetch resolves,
    // so wait for it rather than racing it.
    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();

    // Scoped to <main> — the sidebar's session list also shows a truncated
    // copy of the message text as the session title/preview.
    const chatArea = window.getByRole("main");
    await expect(chatArea.getByText("What is the answer?")).toBeVisible();
    await expect(chatArea.getByText("The answer is 42.")).toBeVisible({ timeout: 15_000 });

    expect(fakeOllama.getChatRequestCount()).toBe(1);
});
