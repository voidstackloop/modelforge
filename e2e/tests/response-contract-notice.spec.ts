import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "../fixtures/electron-app";
import { FAKE_LLAMACPP_ENV, controlFakeLlamaCpp, type FakeLlamaCppController } from "../fixtures/fake-llamacpp";

// Exercises ResponseContractNotice (frontend/src/pages/Chat.tsx) end to end:
// a deterministic, non-model check (checkResponseContractCompliance,
// frontend/src/lib/clinical-constants.ts) that flags a response which
// clearly attempted the eight-section clinical contract but silently
// dropped one or more required sections — the system prompt asks for all
// eight, but nothing stops a model from skipping one, and this is what
// catches that rather than leaving it unnoticed in a long answer.

let modelsDir: string;
let instance: LaunchedApp;
let fakeLlamaCpp: FakeLlamaCppController;

const FAKE_MODEL_NAME = "fake-embedding-model.gguf";
const FAKE_MODEL_REF = `llamacpp:${FAKE_MODEL_NAME}`;

test.beforeEach(async () => {
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-contract-models-"));
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

test("flags a response that attempted the contract but dropped a required section", async () => {
    const { window } = instance;
    await fakeLlamaCpp.setNextChatTurn({
        tokens: [
            "1. Summary\nBrief.\n\n2. Known patient facts\nNone given.\n\n3. Assessment or possible interpretations\nUnclear.\n\n",
            "4. Missing information\nVitals.\n\n6. Suggested next clinical steps\nFollow up.\n\n7. Evidence and citations\nNone.\n\n8. Uncertainty and limitations\nHigh.",
        ],
    });

    const input = window.getByPlaceholder("Send a message...");
    await input.fill("What could this be?");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();

    const chatArea = window.getByRole("main");
    await expect(chatArea.getByText(/Missing required section/)).toBeVisible({ timeout: 15_000 });
    await expect(chatArea.getByText(/Red flags and urgent concerns/)).toBeVisible();
});

test("does not flag a response that includes every required section", async () => {
    const { window } = instance;
    await fakeLlamaCpp.setNextChatTurn({
        tokens: [
            "1. Summary\nBrief.\n\n2. Known patient facts\nNone given.\n\n3. Assessment or possible interpretations\nUnclear.\n\n",
            "4. Missing information\nVitals.\n\n5. Red flags and urgent concerns\nNone noted.\n\n6. Suggested next clinical steps\nFollow up.\n\n",
            "7. Evidence and citations\nNone.\n\n8. Uncertainty and limitations\nHigh.",
        ],
    });

    const input = window.getByPlaceholder("Send a message...");
    await input.fill("What could this be?");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();

    // Not a numbered-heading line (those render as markdown ordered-list
    // markers, stripping the literal "N." prefix from the DOM text) — this
    // is section 8's plain-paragraph body, which survives rendering intact.
    const chatArea = window.getByRole("main");
    await expect(chatArea.getByText("High.")).toBeVisible({ timeout: 15_000 });
    await expect(chatArea.getByText(/Missing required section/)).not.toBeVisible();
});

test("does not flag a short, non-clinical reply that never attempted the contract", async () => {
    const { window } = instance;
    await fakeLlamaCpp.setNextChatTurn({ tokens: ["Sure, happy to help with that."] });

    const input = window.getByPlaceholder("Send a message...");
    await input.fill("Thanks!");
    const sendButton = window.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();

    const chatArea = window.getByRole("main");
    await expect(chatArea.getByText("Sure, happy to help with that.")).toBeVisible({ timeout: 15_000 });
    await expect(chatArea.getByText(/Missing required section/)).not.toBeVisible();
});
