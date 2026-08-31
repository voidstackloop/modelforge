import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { app } from "electron";
import { logger, getLogPath, getLogTail } from "./logger";

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §5: logger.ts previously had zero
 * test coverage and no age-based pruning of its rotated `.1` generation —
 * unlike telemetry/sink.ts's own 30-day policy two files away. These tests
 * cover both the pre-existing rotation behavior and the new pruning fix.
 */

function rotatedLogPath(): string {
    return `${getLogPath()}.1`;
}

describe("logger", () => {
    beforeEach(() => {
        fs.mkdirSync(path.dirname(getLogPath()), { recursive: true });
        fs.rmSync(getLogPath(), { force: true });
        fs.rmSync(rotatedLogPath(), { force: true });
    });

    it("writes a level-tagged line, readable back via getLogTail", () => {
        logger.info("hello world");
        expect(getLogTail()).toContain("[INFO] hello world");
    });

    it("tags warn and error at their own levels", () => {
        logger.warn("careful");
        logger.error("broken");
        const tail = getLogTail();
        expect(tail).toContain("[WARN] careful");
        expect(tail).toContain("[ERROR] broken");
    });

    it("rotates the live file into .1 once it exceeds the size threshold", () => {
        fs.writeFileSync(getLogPath(), "x".repeat(2 * 1024 * 1024 + 1));
        logger.info("triggers rotation");

        expect(fs.existsSync(rotatedLogPath())).toBe(true);
        expect(fs.statSync(rotatedLogPath()).size).toBeGreaterThan(2 * 1024 * 1024);
        // The live file starts fresh after rotation — just the newly-written
        // line, not the old oversized content that was moved aside first.
        expect(getLogTail()).toContain("triggers rotation");
        expect(getLogTail().length).toBeLessThan(1000);
    });

    it("prunes a rotated generation older than the 30-day age cap", () => {
        fs.writeFileSync(rotatedLogPath(), "stale content");
        const staleMtime = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
        fs.utimesSync(rotatedLogPath(), staleMtime, staleMtime);

        logger.info("triggers prune check");

        expect(fs.existsSync(rotatedLogPath())).toBe(false);
    });

    it("does not prune a rotated generation within the age cap", () => {
        fs.writeFileSync(rotatedLogPath(), "recent content");

        logger.info("should not prune");

        expect(fs.existsSync(rotatedLogPath())).toBe(true);
        expect(fs.readFileSync(rotatedLogPath(), "utf-8")).toBe("recent content");
    });

    it("getLogPath resolves under the app's userData/logs directory", () => {
        expect(getLogPath()).toBe(path.join(app.getPath("userData"), "logs", "app.log"));
    });
});
