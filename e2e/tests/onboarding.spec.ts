import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "../fixtures/electron-app";
import { startFakeOllama, type FakeOllamaServer } from "../fixtures/fake-ollama";

// First launch (no settings.json / onboardingComplete flag) must show the
// onboarding wizard from frontend/src/components/onboarding-wizard.tsx and
// let the user finish it — either by picking a local provider or skipping —
// without the wizard or the rest of the app erroring out.

let fakeOllama: FakeOllamaServer;
let instance: LaunchedApp;

test.beforeAll(async () => {
    fakeOllama = await startFakeOllama();
});

test.afterAll(async () => {
    await fakeOllama.close();
});

test.afterEach(async () => {
    await instance?.close();
});

test("completes onboarding by picking Ollama as the local provider", async () => {
    instance = await launchApp({ settings: { ollamaHost: fakeOllama.url } });
    const { window } = instance;
    const pageErrors: Error[] = [];
    window.on("pageerror", (err) => pageErrors.push(err));

    await expect(window.getByText("Welcome to Modelforge")).toBeVisible();

    await window.getByRole("button", { name: "Ollama (local)" }).click();
    await window.getByRole("button", { name: "Continue" }).click();

    await expect(window.getByText("Welcome to Modelforge")).toBeHidden();
    // The chat page (the wizard's onDone route) should be up with no crash.
    await expect(window.getByPlaceholder("Send a message...")).toBeVisible();

    expect(pageErrors).toEqual([]);
});

test("completes onboarding via Skip for now", async () => {
    instance = await launchApp({ settings: { ollamaHost: fakeOllama.url } });
    const { window } = instance;

    await expect(window.getByText("Welcome to Modelforge")).toBeVisible();
    await window.getByRole("button", { name: "Skip for now" }).click();

    await expect(window.getByText("Welcome to Modelforge")).toBeHidden();
    await expect(window.getByPlaceholder("Send a message...")).toBeVisible();
});
