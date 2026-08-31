import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TelemetrySink } from "./sink";

let dir: string;
let basePath: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-telemetry-test-"));
    basePath = path.join(dir, "telemetry.jsonl");
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("TelemetrySink", () => {
    it("writes an event as one JSON line and reads it back", () => {
        const sink = new TelemetrySink({ basePath });
        sink.write({ a: 1 });
        expect(sink.readAll()).toEqual([{ a: 1 }]);
    });

    it("appends multiple events in order across the live file", () => {
        const sink = new TelemetrySink({ basePath });
        sink.write({ n: 1 });
        sink.write({ n: 2 });
        sink.write({ n: 3 });
        expect(sink.readAll()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    it("creates the log file with private (0600) permissions on non-Windows", () => {
        if (process.platform === "win32") return; // mode bits aren't meaningful on Windows — see json-store.ts's own guard
        const sink = new TelemetrySink({ basePath });
        sink.write({ a: 1 });
        const mode = fs.statSync(basePath).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it("re-tightens permissions on an existing file whose mode has drifted", () => {
        if (process.platform === "win32") return;
        fs.writeFileSync(basePath, "");
        fs.chmodSync(basePath, 0o644);
        const sink = new TelemetrySink({ basePath });
        sink.write({ a: 1 });
        expect(fs.statSync(basePath).mode & 0o777).toBe(0o600);
    });

    it("rotates to .1 once the live file exceeds maxFileBytes, and the live file starts fresh", () => {
        const sink = new TelemetrySink({ basePath, maxFileBytes: 50 });
        sink.write({ big: "x".repeat(60) }); // pushes the live file over the 50-byte threshold
        sink.write({ n: 2 }); // this write's own rotation check now sees the oversized file and rotates it out first

        expect(fs.existsSync(`${basePath}.1`)).toBe(true);
        const liveContent = fs.readFileSync(basePath, "utf-8").trim().split("\n");
        expect(liveContent).toHaveLength(1);
        expect(JSON.parse(liveContent[0])).toEqual({ n: 2 });
    });

    it("cascades rotation across multiple generations and drops the oldest beyond maxGenerations", () => {
        const sink = new TelemetrySink({ basePath, maxFileBytes: 10, maxGenerations: 2 });
        for (let i = 0; i < 5; i++) sink.write({ i, pad: "x".repeat(20) }); // each write exceeds 10 bytes, forcing a rotation before the next write

        expect(fs.existsSync(basePath)).toBe(true);
        expect(fs.existsSync(`${basePath}.1`)).toBe(true);
        expect(fs.existsSync(`${basePath}.2`)).toBe(true);
        expect(fs.existsSync(`${basePath}.3`)).toBe(false); // beyond maxGenerations — never created
    });

    it("prunes a rotated generation older than maxAgeMs", () => {
        // Sets up an already-rotated generation directly, rather than via
        // real rotation, so a small maxFileBytes elsewhere in this test
        // doesn't also re-rotate (and so overwrite) it during the write()
        // call below — pruneOldGenerations() runs on every write() regardless
        // of whether that write happened to trigger rotation.
        const sink = new TelemetrySink({ basePath, maxAgeMs: 60_000 });
        const oldGenPath = `${basePath}.1`;
        fs.writeFileSync(oldGenPath, '{"old":true}\n');
        const past = new Date(Date.now() - 10 * 60_000); // 10 minutes ago — well past the 1-minute maxAgeMs
        fs.utimesSync(oldGenPath, past, past);

        sink.write({ triggers: "pruning pass" });
        expect(fs.existsSync(oldGenPath)).toBe(false);
    });

    it("enforces a total-disk-cap by dropping the oldest rotated generation first, never the live file", () => {
        const sink = new TelemetrySink({ basePath, maxFileBytes: 1, maxGenerations: 5, maxTotalBytes: 40 });
        for (let i = 0; i < 6; i++) sink.write({ i, pad: "x".repeat(15) });

        expect(fs.existsSync(basePath)).toBe(true); // live file is never dropped by the disk cap
        const totalSize = [0, 1, 2, 3, 4, 5]
            .map((n) => (n === 0 ? basePath : `${basePath}.${n}`))
            .filter((p) => fs.existsSync(p))
            .reduce((sum, p) => sum + fs.statSync(p).size, 0);
        expect(totalSize).toBeLessThanOrEqual(40 + 200); // some slack: the cap is enforced *before* the write that would exceed it starts, not mid-write
    });

    it("recovers from a corrupted/truncated trailing line, keeping the well-formed lines around it", () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(basePath, '{"n":1}\n{"n":2}\n{"n":3, "trunc', "utf-8"); // simulates a write interrupted mid-line
        const sink = new TelemetrySink({ basePath });
        expect(sink.readAll()).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("recovers from a corrupted line in the middle of the file, not just a truncated tail", () => {
        fs.writeFileSync(basePath, '{"n":1}\nnot json at all\n{"n":3}\n', "utf-8");
        const sink = new TelemetrySink({ basePath });
        expect(sink.readAll()).toEqual([{ n: 1 }, { n: 3 }]);
    });

    it("readAll returns an empty array when no log file exists yet", () => {
        const sink = new TelemetrySink({ basePath });
        expect(sink.readAll()).toEqual([]);
    });

    it("readAll orders oldest generation first, then the live file", () => {
        const sink = new TelemetrySink({ basePath, maxFileBytes: 1, maxGenerations: 3 });
        sink.write({ n: 1 }); // rotates to .1 on the next write
        sink.write({ n: 2 }); // rotates .1->.2, this write's own content becomes .1 on the *next* write
        sink.write({ n: 3 });
        expect(sink.readAll()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    it("many synchronous writes in immediate succession never interleave or corrupt a line", () => {
        const sink = new TelemetrySink({ basePath });
        for (let i = 0; i < 200; i++) sink.write({ i });
        const events = sink.readAll() as { i: number }[];
        expect(events).toHaveLength(200);
        expect(events.map((e) => e.i)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    });

    it("a write failure (e.g. the log directory replaced by a file) is swallowed, not thrown", () => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.writeFileSync(dir, "not a directory"); // basePath's parent can no longer be created as a directory
        const sink = new TelemetrySink({ basePath });
        expect(() => sink.write({ a: 1 })).not.toThrow();
        fs.rmSync(dir, { force: true }); // afterEach expects `dir` to be a directory it can recursively remove
        fs.mkdirSync(dir, { recursive: true });
    });
});
