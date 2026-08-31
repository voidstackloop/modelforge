import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal fake ipcMain — just enough surface for installIpcSenderValidation
// to wrap (.handle/.on) and this test to drive (capturing what got
// registered, so a test can invoke it directly with a synthetic event).
// Deliberately local to this test file rather than added to the shared
// test/electron-mock.ts: nothing else in this codebase unit-tests against a
// real ipcMain today (see ipc-validation.test.ts's own doc comment on why
// those four handlers are tested by replicating their body instead of
// building "a second Electron mock") — this file's whole point is testing
// the ipcMain.handle/.on wrapping itself, which can't be done any other way.
type FakeListener = (event: { senderFrame: unknown }, ...args: unknown[]) => unknown;

// vi.hoisted (not a plain top-level const) — vi.mock factories below are
// hoisted above ordinary module-level code, so a plain `const fake = ...`
// here would still be in its temporal dead zone when those factories run.
const fake = vi.hoisted(() => {
    const handlers = new Map<string, FakeListener>();
    const listeners = new Map<string, FakeListener>();
    return {
        ipcMain: {
            handle: (channel: string, listener: FakeListener) => handlers.set(channel, listener),
            on: (channel: string, listener: FakeListener) => listeners.set(channel, listener),
        },
        handlers,
        listeners,
    };
});

vi.mock("electron", () => ({ ipcMain: fake.ipcMain }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let currentMainWindow: { isDestroyed: () => boolean; webContents: { mainFrame: unknown } } | null = null;
vi.mock("../app-state", () => ({ getMainWindow: () => currentMainWindow }));

// Plain static imports — vitest hoists every vi.mock(...) call above all
// imports in this file regardless of source order, so trusted-sender.ts
// still sees the mocked "electron"/"../logger"/"../app-state" when it
// itself imports them.
import { installIpcSenderValidation, _resetForTests } from "./trusted-sender";
import { logger } from "../logger";

const MAIN_FRAME = { name: "main-frame-sentinel" };
const OTHER_FRAME = { name: "some-other-frame-sentinel" };

describe("installIpcSenderValidation", () => {
    beforeEach(() => {
        fake.handlers.clear();
        fake.listeners.clear();
        currentMainWindow = { isDestroyed: () => false, webContents: { mainFrame: MAIN_FRAME } };
        _resetForTests();
        vi.clearAllMocks();
    });

    it("wraps ipcMain.handle: a call from the main window's own main frame reaches the real listener and its return value passes through", async () => {
        installIpcSenderValidation();
        const realListener = vi.fn().mockResolvedValue("real-result");
        fake.ipcMain.handle("test:channel", realListener as unknown as FakeListener);

        const wrapped = fake.handlers.get("test:channel")!;
        const result = await wrapped({ senderFrame: MAIN_FRAME }, "arg1", 2);

        expect(result).toBe("real-result");
        expect(realListener).toHaveBeenCalledWith({ senderFrame: MAIN_FRAME }, "arg1", 2);
    });

    it("wraps ipcMain.handle: a call from a different frame is rejected before the real listener runs", async () => {
        installIpcSenderValidation();
        const realListener = vi.fn().mockResolvedValue("should-never-be-returned");
        fake.ipcMain.handle("test:channel", realListener as unknown as FakeListener);

        const wrapped = fake.handlers.get("test:channel")!;
        await expect(wrapped({ senderFrame: OTHER_FRAME })).rejects.toThrow(/trusted/i);

        expect(realListener).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("test:channel"));
    });

    it("wraps ipcMain.handle: a null senderFrame is rejected", async () => {
        installIpcSenderValidation();
        const realListener = vi.fn();
        fake.ipcMain.handle("test:channel", realListener as unknown as FakeListener);

        const wrapped = fake.handlers.get("test:channel")!;
        await expect(wrapped({ senderFrame: null })).rejects.toThrow();
        expect(realListener).not.toHaveBeenCalled();
    });

    it("wraps ipcMain.handle: rejected when there is no main window yet (e.g. a stray call before createWindow())", async () => {
        currentMainWindow = null;
        installIpcSenderValidation();
        const realListener = vi.fn();
        fake.ipcMain.handle("test:channel", realListener as unknown as FakeListener);

        const wrapped = fake.handlers.get("test:channel")!;
        await expect(wrapped({ senderFrame: MAIN_FRAME })).rejects.toThrow();
        expect(realListener).not.toHaveBeenCalled();
    });

    it("wraps ipcMain.handle: rejected once the main window is destroyed", async () => {
        installIpcSenderValidation();
        const realListener = vi.fn();
        fake.ipcMain.handle("test:channel", realListener as unknown as FakeListener);
        currentMainWindow!.isDestroyed = () => true;

        const wrapped = fake.handlers.get("test:channel")!;
        await expect(wrapped({ senderFrame: MAIN_FRAME })).rejects.toThrow();
        expect(realListener).not.toHaveBeenCalled();
    });

    it("wraps ipcMain.on: a call from the main frame reaches the real listener", () => {
        installIpcSenderValidation();
        const realListener = vi.fn();
        fake.ipcMain.on("test:event", realListener as unknown as FakeListener);

        const wrapped = fake.listeners.get("test:event")!;
        wrapped({ senderFrame: MAIN_FRAME }, "payload");

        expect(realListener).toHaveBeenCalledWith({ senderFrame: MAIN_FRAME }, "payload");
    });

    it("wraps ipcMain.on: a call from an untrusted frame is silently dropped, not thrown (ipcMain.on has no caller awaiting a rejection)", () => {
        installIpcSenderValidation();
        const realListener = vi.fn();
        fake.ipcMain.on("test:event", realListener as unknown as FakeListener);

        const wrapped = fake.listeners.get("test:event")!;
        expect(() => wrapped({ senderFrame: OTHER_FRAME }, "payload")).not.toThrow();

        expect(realListener).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("test:event"));
    });

    it("only installs once — calling it twice does not double-wrap (which would otherwise still work, but would double the sender check and any future per-call overhead/logging)", async () => {
        installIpcSenderValidation();
        installIpcSenderValidation();
        const realListener = vi.fn().mockResolvedValue("ok");
        fake.ipcMain.handle("test:channel", realListener as unknown as FakeListener);

        const errorSpy = vi.mocked(logger.error);
        const wrapped = fake.handlers.get("test:channel")!;
        try {
            await wrapped({ senderFrame: OTHER_FRAME });
        } catch {
            // expected — untrusted sender
        }

        // A double-wrapped handler would log the rejection twice for one call.
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });
});
