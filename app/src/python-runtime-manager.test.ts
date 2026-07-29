import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { app } from "electron";
import {
    environmentDestination,
    environmentPython,
    buildPythonEnvironmentOperationSteps,
    ManagedPythonWorker,
    PYTHON_RUNTIME_MANIFESTS,
    type PythonRuntimeFamily,
} from "./python-runtime-manager";

// environmentPython/environmentDestination decide, per (platform, runtime
// family), whether a managed Python venv lives on the WSL side (Windows-only,
// for vllm-cuda/vllm-rocm — those never run natively on Windows) or directly
// on the host, and if on the host, whether its interpreter is at
// Scripts/python.exe (Windows venv layout) or bin/python (POSIX venv layout).
//
// The bug this suite pins down: hardware-recommender is CPU-only and runs
// natively on Windows (no WSL involved at all, unlike the vllm-* families),
// but an earlier version of environmentPython() decided the WSL-vs-native
// split from `platform === "win32" && family !== "mlx"` directly — a check
// that didn't agree with usesWsl()'s own exclusion of hardware-recommender.
// That routed a native Windows hardware-recommender install at a WSL-style
// `bin/python` path that never exists there.
const FAMILIES = Object.keys(PYTHON_RUNTIME_MANIFESTS) as PythonRuntimeFamily[];
const PLATFORMS: NodeJS.Platform[] = ["win32", "linux", "darwin"];

describe("Python environment operation plans", () => {
    it("uses executable argument arrays for native installs", () => {
        const steps = buildPythonEnvironmentOperationSteps("hardware-recommender", "install");
        expect(steps.length).toBe(3);
        expect(steps.every((step) => Array.isArray(step.args))).toBe(true);
        expect(steps.at(-1)?.args).toEqual(expect.arrayContaining(["onnxruntime==1.28.0", "numpy==2.2.6"]));
    });

    it("builds repair as a pinned force-reinstall", () => {
        const [step] = buildPythonEnvironmentOperationSteps("mlx", "repair");
        expect(step.args).toEqual(expect.arrayContaining(["--force-reinstall", "mlx-lm==0.31.3"]));
    });
});

// Whether a given (family, platform) combination is expected to resolve
// through the WSL side (Windows-only path syntax, forward slashes, no
// dependence on the real host path.join separator) vs. the native host venv
// layout for that platform.
function expectedUsesWsl(family: PythonRuntimeFamily, platform: NodeJS.Platform): boolean {
    return platform === "win32" && family !== "mlx" && family !== "hardware-recommender";
}

describe("environmentPython", () => {
    for (const family of FAMILIES) {
        for (const platform of PLATFORMS) {
            const wsl = expectedUsesWsl(family, platform);
            it(`${family} on ${platform} resolves to ${wsl ? "a WSL bin/python path" : platform === "win32" ? "Scripts/python.exe" : "bin/python"}`, () => {
                const python = environmentPython(family, platform);
                const destination = environmentDestination(family, platform);

                if (wsl) {
                    expect(destination.startsWith("~/.local/share/modelforge/python-runtimes/")).toBe(true);
                    expect(python).toBe(`${destination}/bin/python`);
                } else {
                    expect(destination.startsWith("~/")).toBe(false);
                    const expectedSuffix = platform === "win32" ? "Scripts/python.exe" : "bin/python";
                    // path.join always uses the *actual* host OS's separator
                    // regardless of the simulated `platform` argument, so
                    // compare against forward-slash-normalized output rather
                    // than assuming backslashes on a win32 case run under
                    // Linux/WSL CI.
                    expect(python.replace(/\\/g, "/")).toBe(`${destination.replace(/\\/g, "/")}/${expectedSuffix}`);
                }
            });
        }
    }

    it("specifically: hardware-recommender on win32 is native (Scripts/python.exe), not the WSL vllm-style path", () => {
        const python = environmentPython("hardware-recommender", "win32");
        expect(python.replace(/\\/g, "/")).toMatch(/Scripts\/python\.exe$/);
        expect(python).not.toContain("~/.local/share/modelforge");
    });

    it("specifically: vllm-cuda on win32 still goes through WSL (bin/python), unaffected by the hardware-recommender fix", () => {
        const python = environmentPython("vllm-cuda", "win32");
        expect(python).toBe("~/.local/share/modelforge/python-runtimes/vllm-cuda/bin/python");
    });

    it("specifically: vllm-rocm on win32 still goes through WSL (bin/python)", () => {
        const python = environmentPython("vllm-rocm", "win32");
        expect(python).toBe("~/.local/share/modelforge/python-runtimes/vllm-rocm/bin/python");
    });

    it("mlx never uses the WSL path even on win32 (it just isn't compatible there — see compatibilityIssues)", () => {
        const python = environmentPython("mlx", "win32");
        expect(python).not.toContain("~/.local/share/modelforge");
        expect(python.replace(/\\/g, "/")).toMatch(/Scripts\/python\.exe$/);
    });

    it("uses the real userData path (via app.getPath) for non-WSL destinations", () => {
        const destination = environmentDestination("hardware-recommender", "linux");
        expect(destination.startsWith(path.join(app.getPath("userData"), "python-runtimes"))).toBe(true);
    });
});

// A tiny stand-in for runtime_worker.py/recommender_worker.py's JSON-line
// protocol, run via `node -e` instead of a real Python worker — CI can't
// assume a working Python venv with the right packages is present just to exercise request
// plumbing (timeouts, malformed output, crashes, shutdown), and
// ManagedPythonWorker's `command`/`args` overrides exist specifically so
// this substitution is possible without touching production code paths.
// `params.simulate` picks the misbehavior a given request should trigger;
// anything else replies "ok" the way a real worker would to `health`.
const FAKE_WORKER_SCRIPT = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;
    const simulate = (params && params.simulate) || null;
    if (method === "shutdown") {
        console.log(JSON.stringify({ protocol: 1, id, ok: true, result: { shuttingDown: true } }));
        process.exit(0);
    }
    if (simulate === "hang") return; // never respond
    if (simulate === "crash") process.exit(1);
    if (simulate === "malformed") console.log("not-json-garbage-line-from-a-buggy-print");
    console.log(JSON.stringify({ protocol: 1, id, ok: true, result: { status: "ok", method } }));
});
`;

function startFakeWorker(timeoutMs: number): ManagedPythonWorker {
    return new ManagedPythonWorker("mlx", { command: process.execPath, args: ["-e", FAKE_WORKER_SCRIPT], timeoutMs });
}

describe("ManagedPythonWorker", () => {
    const workers: ManagedPythonWorker[] = [];
    function worker(timeoutMs = 5_000): ManagedPythonWorker {
        const w = startFakeWorker(timeoutMs);
        workers.push(w);
        return w;
    }
    afterEach(async () => {
        await Promise.all(workers.splice(0).map((w) => w.shutdown()));
    });

    it("resolves a successful request", async () => {
        const result = await worker().request("health");
        expect(result).toEqual({ status: "ok", method: "health" });
    });

    it("rejects and removes a request that times out, without affecting a later request", async () => {
        const w = worker(150);
        await expect(w.request("health", { simulate: "hang" })).rejects.toThrow(/timed out after 150ms/);
        // A fresh request on the same worker still works — the timed-out
        // entry didn't leave the pending map or the worker in a bad state.
        const result = await w.request("health");
        expect(result).toEqual({ status: "ok", method: "health" });
    });

    it("ignores a malformed output line without crashing and still resolves the real response", async () => {
        const result = await worker().request("health", { simulate: "malformed" });
        expect(result).toEqual({ status: "ok", method: "health" });
    });

    it("rejects a pending request when the worker process exits unexpectedly", async () => {
        const w = worker();
        await expect(w.request("health", { simulate: "crash" })).rejects.toThrow(/exited/);
    });

    it("recovers after a crash — a later request on the same instance restarts the worker", async () => {
        const w = worker();
        await expect(w.request("health", { simulate: "crash" })).rejects.toThrow(/exited/);
        const result = await w.request("health");
        expect(result).toEqual({ status: "ok", method: "health" });
    });

    it("rejects pending requests immediately when shutdown() is called", async () => {
        const w = worker(5_000);
        const pending = w.request("health", { simulate: "hang" });
        const assertion = expect(pending).rejects.toThrow(/shutting down/);
        await w.shutdown();
        await assertion;
    });

    it("shutdown() on a worker that was never started is a harmless no-op", async () => {
        const w = new ManagedPythonWorker("mlx", { command: process.execPath, args: ["-e", FAKE_WORKER_SCRIPT] });
        await expect(w.shutdown()).resolves.toBeUndefined();
    });
});
