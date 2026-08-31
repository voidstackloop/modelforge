import { test, expect } from "@playwright/test";
import { launchApp, spawnSecondInstance, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// main.ts calls app.requestSingleInstanceLock() specifically so two OS
// processes never hold the same userData profile open at once — every
// on-disk store in this app (audit-log.json/.sqlite3 in particular; see
// audit-log-store.ts's syncOnBackendTransition()) assumes it's the only
// process writing its files, and this lock is what actually makes that
// true instead of each store having to defend against a cross-process race
// on its own.

let instance: LaunchedApp;

test.afterEach(async () => {
    await instance?.close();
});

test("a second instance against an already-open profile exits immediately, and the first instance is unaffected", async () => {
    const userDataDir = makeUserDataDir();
    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });

    const { exited } = spawnSecondInstance(userDataDir);
    const result = await Promise.race([
        exited,
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 15_000)),
    ]);
    // "timed-out" here would mean the second process is still running —
    // i.e. it won the race, or the lock did nothing — rather than having
    // exited via app.exit(0) in the "lost the lock" branch of main.ts.
    expect(result).not.toBe("timed-out");
    expect((result as { code: number | null }).code).toBe(0);

    // The first (real) instance kept running and is still fully usable —
    // proves the lock rejected the second process rather than the first one
    // losing a race and getting torn down instead.
    await expect(instance.window.getByRole("button", { name: "Patient Cases" })).toBeVisible();
    await instance.window.getByRole("button", { name: "Patient Cases" }).click();
    await instance.window.getByLabel("New case").fill("Post single-instance-lock case");
    await instance.window.getByRole("button", { name: "New case" }).click();
    await expect(instance.window.getByText("Post single-instance-lock case")).toBeVisible();
});
