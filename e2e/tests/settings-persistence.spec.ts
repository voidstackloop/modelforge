import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// "Reduce motion" round-trips through window.api.settings.save -> app/src/
// settings-store.ts -> <userData>/settings.json (json-store.ts), unlike the
// theme toggle which only lives in the renderer's own localStorage — so this
// is the setting that actually proves the main-process persistence path
// works, not just that Chromium remembered its own storage.

let instance: LaunchedApp;

test.afterEach(async () => {
    await instance?.close();
});

test("a changed setting survives an app relaunch against the same profile", async () => {
    const userDataDir = makeUserDataDir();

    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });
    await instance.window.getByRole("button", { name: "Settings" }).click();

    const reduceMotionSwitch = instance.window.getByRole("switch", { name: "Reduce motion" });
    await expect(reduceMotionSwitch).toBeVisible();
    await expect(reduceMotionSwitch).toHaveAttribute("aria-checked", "false");

    await reduceMotionSwitch.click();
    await expect(reduceMotionSwitch).toHaveAttribute("aria-checked", "true");

    await instance.close();

    instance = await launchApp({ userDataDir });
    await instance.window.getByRole("button", { name: "Settings" }).click();

    await expect(instance.window.getByRole("switch", { name: "Reduce motion" })).toHaveAttribute(
        "aria-checked",
        "true",
        { timeout: 15_000 }
    );
});
