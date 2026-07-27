import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "../fixtures/electron-app";

let instance: LaunchedApp;

test.beforeEach(async () => {
    instance = await launchApp({ settings: { onboardingComplete: true } });
});

test.afterEach(async () => {
    await instance.close();
});

test("Download Center renders and its concurrency control is interactive", async () => {
    const { window } = instance;

    await window.getByRole("button", { name: "Download Center" }).click();
    await expect(window.getByRole("heading", { name: "Download Center" })).toBeVisible();
    // No queued jobs on a fresh profile — confirms the empty state renders
    // rather than the page crashing on a jobs.map() over undefined/null.
    await expect(window.getByText("No downloads yet")).toBeVisible();

    const concurrencyInput = window.getByLabel("Concurrent jobs");
    await concurrencyInput.fill("3");
    await window.getByRole("button", { name: "Apply" }).click();
    await expect(concurrencyInput).toHaveValue("3");

    await window.getByRole("button", { name: "Back" }).click();
    await expect(window.getByPlaceholder("Send a message...")).toBeVisible();
});
