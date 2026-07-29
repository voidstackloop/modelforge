import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import { killProcessTree } from "./process-tree";
import { getSpecs, type SystemSpecs } from "./system-specs";

const execFileAsync = promisify(execFile);
export const PYTHON_WORKER_PROTOCOL_VERSION = 1;
export type PythonRuntimeFamily = "mlx" | "vllm-cuda" | "vllm-rocm" | "hardware-recommender";
export type PythonEnvironmentState = "missing" | "healthy" | "drifted" | "incompatible";

export interface PythonRuntimeManifest {
    family: PythonRuntimeFamily; version: number; python: string; packages: Record<string, string>;
    diskRequirementBytes: number; expectedDownloadBytes: number; protocolVersion: number;
    compatibility: string; documentationUrl: string;
}
export interface PythonEnvironmentStatus {
    family: PythonRuntimeFamily; state: PythonEnvironmentState; destination: string; pythonPath: string;
    pythonVersion: string | null; installedPackages: Record<string, string>; issues: string[];
    manifest: PythonRuntimeManifest; installCommand: string; repairCommand: string; removeCommand: string;
}

export const PYTHON_RUNTIME_MANIFESTS: Record<PythonRuntimeFamily, PythonRuntimeManifest> = {
    mlx: { family: "mlx", version: 1, python: ">=3.10,<3.14", packages: { "mlx-lm": "0.31.3" }, diskRequirementBytes: 2 * 1024 ** 3, expectedDownloadBytes: 900 * 1024 ** 2, protocolVersion: 1, compatibility: "Apple Silicon and macOS", documentationUrl: "https://github.com/ml-explore/mlx-lm" },
    "vllm-cuda": { family: "vllm-cuda", version: 1, python: ">=3.10,<3.15", packages: { vllm: "0.25.1" }, diskRequirementBytes: 10 * 1024 ** 3, expectedDownloadBytes: 4 * 1024 ** 3, protocolVersion: 1, compatibility: "Linux/WSL with a supported NVIDIA CUDA driver", documentationUrl: "https://docs.vllm.ai/en/latest/getting_started/installation/gpu/" },
    "vllm-rocm": { family: "vllm-rocm", version: 1, python: ">=3.10,<3.15", packages: { vllm: "0.25.1" }, diskRequirementBytes: 14 * 1024 ** 3, expectedDownloadBytes: 6 * 1024 ** 3, protocolVersion: 1, compatibility: "Linux/WSL with a supported AMD ROCm stack; source compilation may be required", documentationUrl: "https://docs.vllm.ai/en/latest/getting_started/installation/gpu/" },
    // CPU-only inference for the trained hardware-recommender model (see
    // ml/hardware-recommender/) — no GPU/accelerator requirement, runs
    // natively on every platform including Windows (unlike vllm-*, which
    // needs WSL there). Runs the model through onnxruntime rather than
    // torch (recommender_worker.py loads the exported .onnx, not a .pt
    // checkpoint) — torch is only needed to train the model, and requiring
    // a ~200MB+ install just to run inference on a ~40KB network was
    // disproportionate. onnxruntime's CPU wheel is a fraction of the size.
    "hardware-recommender": { family: "hardware-recommender", version: 2, python: ">=3.10,<3.14", packages: { onnxruntime: "1.28.0", numpy: "2.2.6" }, diskRequirementBytes: 512 * 1024 ** 2, expectedDownloadBytes: 40 * 1024 ** 2, protocolVersion: 1, compatibility: "Any platform (CPU-only inference)", documentationUrl: "https://github.com/voidstackloop/modelforge/tree/main/ml/hardware-recommender" },
};

function environmentRoot(): string { return path.join(app.getPath("userData"), "python-runtimes"); }
// hardware-recommender is deliberately excluded even though it's win32: it's
// pure-CPU-inference and runs natively on Windows (see the manifest comment
// above), unlike vllm-cuda/vllm-rocm which only ever run through WSL there.
// `platform` is threaded through as a parameter (rather than read from
// process.platform directly) purely so this — and environmentDestination/
// environmentPython below — can be exercised for every platform from a test
// running on any single host OS.
function usesWsl(family: PythonRuntimeFamily, platform: NodeJS.Platform = process.platform): boolean {
    return platform === "win32" && family !== "mlx" && family !== "hardware-recommender";
}
export function environmentDestination(family: PythonRuntimeFamily, platform: NodeJS.Platform = process.platform): string {
    return usesWsl(family, platform) ? `~/.local/share/modelforge/python-runtimes/${family}` : path.join(environmentRoot(), family);
}
// Bug this guards against: an earlier version of this function decided
// bin/python vs Scripts/python.exe from `platform === "win32" && family !==
// "mlx"` directly, which doesn't match usesWsl()'s own exception for
// hardware-recommender — so a native Windows hardware-recommender install
// (no WSL involved at all) was being pointed at a WSL-style `bin/python`
// path that never exists there, instead of the venv's real
// `Scripts/python.exe`. Routing through usesWsl() here keeps the two in sync.
export function environmentPython(family: PythonRuntimeFamily, platform: NodeJS.Platform = process.platform): string {
    if (usesWsl(family, platform)) return `${environmentDestination(family, platform)}/bin/python`;
    return path.join(environmentDestination(family, platform), platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
function quote(value: string): string { return process.platform === "win32" ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, `'"'"'`)}'`; }
function posixQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function packageSpec(manifest: PythonRuntimeManifest): string { return Object.entries(manifest.packages).map(([name, version]) => `${name}==${version}`).join(" "); }
function basePythonCommand(): string { return process.platform === "win32" ? "py -3.12" : "python3.12"; }

export function compatibilityIssues(family: PythonRuntimeFamily, specs: SystemSpecs): string[] {
    if (family === "hardware-recommender") return [];
    if (family === "mlx") return specs.platform === "darwin" && specs.arch === "arm64" ? [] : ["MLX requires macOS on Apple Silicon."];
    if (specs.platform === "darwin") return ["vLLM GPU environments require Linux or Windows through WSL."];
    const vendors = new Set(specs.gpus.map((gpu) => gpu.vendor));
    if (family === "vllm-cuda" && !vendors.has("nvidia")) return ["No NVIDIA GPU was detected for the CUDA environment."];
    if (family === "vllm-rocm" && !vendors.has("amd")) return ["No AMD GPU was detected for the ROCm environment."];
    return [];
}

function pythonVersionSupported(family: PythonRuntimeFamily, version: string): boolean {
    const [major, minor] = version.split(".").map(Number); const upperMinor = family === "mlx" || family === "hardware-recommender" ? 14 : 15;
    return major === 3 && minor >= 10 && minor < upperMinor;
}

async function acceleratorIssues(family: PythonRuntimeFamily): Promise<string[]> {
    if (family === "mlx" || family === "hardware-recommender") return [];
    try {
        if (family === "vllm-cuda") {
            await execFileAsync("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"], { timeout: 5_000, windowsHide: true });
        } else {
            await execFileAsync(process.platform === "win32" ? "wsl.exe" : "rocminfo", process.platform === "win32" ? ["--", "rocminfo"] : [], { timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 });
        }
        return [];
    } catch {
        return [family === "vllm-cuda" ? "NVIDIA driver tooling (nvidia-smi) is unavailable." : "ROCm tooling (rocminfo) is unavailable."];
    }
}

function commands(manifest: PythonRuntimeManifest, destination: string): { installCommand: string; repairCommand: string; removeCommand: string } {
    const python = environmentPython(manifest.family); const packages = packageSpec(manifest);
    if (usesWsl(manifest.family)) {
        const pip = manifest.family === "vllm-rocm" ? `VLLM_TARGET_DEVICE=rocm ${python} -m pip install --no-cache-dir ${packages}` : `${python} -m pip install --only-binary=:all: ${packages}`;
        const body = `python3.12 -m venv ${destination} && ${python} -m pip install --upgrade pip==26.1 && ${pip}`;
        return { installCommand: `wsl.exe -- bash -lc ${posixQuote(body)}`, repairCommand: `wsl.exe -- bash -lc ${posixQuote(pip.replace("pip install", "pip install --force-reinstall"))}`, removeCommand: `wsl.exe -- rm -rf -- ${destination}` };
    }
    // hardware-recommender used to need a CPU-only-wheel index for torch;
    // onnxruntime (see recommender_worker.py/the manifest below) is a normal
    // PyPI wheel, so it goes through the same plain pip install as mlx.
    const target = manifest.family === "vllm-rocm"
        ? `VLLM_TARGET_DEVICE=rocm ${quote(python)} -m pip install --no-cache-dir ${packages}`
        : `${quote(python)} -m pip install --only-binary=:all: ${packages}`;
    const installCommand = `${basePythonCommand()} -m venv ${quote(destination)} && ${quote(python)} -m pip install --upgrade pip==26.1 && ${target}`;
    const repairTarget = manifest.family === "vllm-rocm"
        ? target
        : `${quote(python)} -m pip install --force-reinstall --only-binary=:all: ${packages}`;
    const removeCommand = process.platform === "win32" ? `Remove-Item -LiteralPath ${quote(destination)} -Recurse -Force` : `rm -rf -- ${quote(destination)}`;
    return { installCommand, repairCommand: repairTarget, removeCommand };
}

async function inspectEnvironment(family: PythonRuntimeFamily, specs: SystemSpecs): Promise<PythonEnvironmentStatus> {
    const manifest = PYTHON_RUNTIME_MANIFESTS[family]; const destination = environmentDestination(family); const pythonPath = environmentPython(family);
    const hardwareIssues = [...compatibilityIssues(family, specs), ...await acceleratorIssues(family)]; const plan = commands(manifest, destination);
    if (hardwareIssues.length) return { family, state: "incompatible", destination, pythonPath, pythonVersion: null, installedPackages: {}, issues: hardwareIssues, manifest, ...plan };
    const exists = usesWsl(family)
        ? await execFileAsync("wsl.exe", ["--", "bash", "-lc", `test -x ${pythonPath}`], { timeout: 5_000, windowsHide: true }).then(() => true).catch(() => false)
        : fs.existsSync(pythonPath);
    if (!exists) return { family, state: "missing", destination, pythonPath, pythonVersion: null, installedPackages: {}, issues: ["Managed virtual environment has not been created."], manifest, ...plan };
    try {
        const modules = Object.keys(manifest.packages);
        const script = "import json,sys,importlib.metadata as m; names=" + JSON.stringify(modules) + "; print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'packages':{n:m.version(n) for n in names}}))";
        const invocation = usesWsl(family)
            ? await execFileAsync("wsl.exe", ["--", "bash", "-lc", `${pythonPath} -c ${quote(script)}`], { timeout: 10_000, windowsHide: true })
            : await execFileAsync(pythonPath, ["-c", script], { timeout: 10_000, windowsHide: true });
        const { stdout } = invocation;
        const detected = JSON.parse(stdout) as { python: string; packages: Record<string, string> }; const issues: string[] = [];
        if (!pythonVersionSupported(family, detected.python)) issues.push(`Python ${detected.python} does not satisfy ${manifest.python}.`);
        for (const [name, expected] of Object.entries(manifest.packages)) if (detected.packages[name] !== expected) issues.push(`${name} ${detected.packages[name] ?? "missing"}; expected ${expected}.`);
        return { family, state: issues.length ? "drifted" : "healthy", destination, pythonPath, pythonVersion: detected.python, installedPackages: detected.packages, issues, manifest, ...plan };
    } catch (error) {
        return { family, state: "drifted", destination, pythonPath, pythonVersion: null, installedPackages: {}, issues: [`Environment inspection failed: ${(error as Error).message}`], manifest, ...plan };
    }
}

export async function getPythonEnvironmentStatuses(): Promise<PythonEnvironmentStatus[]> {
    const specs = await getSpecs(); return Promise.all((Object.keys(PYTHON_RUNTIME_MANIFESTS) as PythonRuntimeFamily[]).map((family) => inspectEnvironment(family, specs)));
}

export type PythonEnvironmentOperation = "install" | "repair";
export interface PythonEnvironmentProgress { step: number; totalSteps: number; message: string; stream: "manager" | "stdout" | "stderr" }

export interface PythonEnvironmentProcessStep { command: string; args: string[]; env?: NodeJS.ProcessEnv; label: string }

function requireFamily(value: unknown): PythonRuntimeFamily {
    if (value !== "mlx" && value !== "vllm-cuda" && value !== "vllm-rocm" && value !== "hardware-recommender") throw new Error("Invalid Python runtime family.");
    return value;
}

export function buildPythonEnvironmentOperationSteps(family: PythonRuntimeFamily, operation: PythonEnvironmentOperation): PythonEnvironmentProcessStep[] {
    const manifest = PYTHON_RUNTIME_MANIFESTS[family]; const destination = environmentDestination(family); const python = environmentPython(family);
    const packageArgs = Object.entries(manifest.packages).map(([name, version]) => `${name}==${version}`);
    if (usesWsl(family)) {
        const installPackages = `${python} -m pip install ${operation === "repair" ? "--force-reinstall " : ""}${family === "vllm-rocm" ? "--no-cache-dir" : "--only-binary=:all:"} ${packageArgs.join(" ")}`;
        const body = operation === "install" ? `python3.12 -m venv ${destination} && ${python} -m pip install --upgrade pip==26.1 && ${family === "vllm-rocm" ? "VLLM_TARGET_DEVICE=rocm " : ""}${installPackages}` : `${family === "vllm-rocm" ? "VLLM_TARGET_DEVICE=rocm " : ""}${installPackages}`;
        return [{ command: "wsl.exe", args: ["--", "bash", "-lc", body], label: operation === "install" ? "Create and populate WSL environment" : "Repair WSL packages" }];
    }
    const env = family === "vllm-rocm" ? { ...process.env, VLLM_TARGET_DEVICE: "rocm" } : process.env;
    if (operation === "repair") return [{ command: python, args: ["-m", "pip", "install", "--force-reinstall", ...(family === "vllm-rocm" ? ["--no-cache-dir"] : ["--only-binary=:all:"]), ...packageArgs], env, label: "Repair pinned packages" }];
    const base = process.platform === "win32" ? { command: "py", args: ["-3.12"] } : { command: "python3.12", args: [] as string[] };
    return [
        { command: base.command, args: [...base.args, "-m", "venv", destination], label: "Create isolated environment" },
        { command: python, args: ["-m", "pip", "install", "--upgrade", "pip==26.1"], label: "Install pinned pip" },
        { command: python, args: ["-m", "pip", "install", ...(family === "vllm-rocm" ? ["--no-cache-dir"] : ["--only-binary=:all:"]), ...packageArgs], env, label: "Install pinned packages" },
    ];
}

async function runProcessStep(step: PythonEnvironmentProcessStep, index: number, total: number, onProgress: (progress: PythonEnvironmentProgress) => void, signal?: AbortSignal): Promise<void> {
    onProgress({ step: index + 1, totalSteps: total, message: step.label, stream: "manager" });
    await new Promise<void>((resolve, reject) => {
        let settled = false; const child = spawn(step.command, step.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: step.env });
        const finish = (error?: Error) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
        const abort = () => { if (child.pid) killProcessTree(child.pid, "SIGTERM"); finish(new Error("Environment operation cancelled. The environment may be partially installed; run Repair after reviewing its status.")); };
        signal?.addEventListener("abort", abort, { once: true });
        for (const [stream, output] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
            output?.setEncoding("utf8"); output?.on("data", (chunk: string) => { for (const line of chunk.split(/\r?\n/).filter(Boolean)) onProgress({ step: index + 1, totalSteps: total, message: line.slice(0, 2_000), stream }); });
        }
        child.once("error", (error) => finish(error));
        child.once("exit", (code, exitSignal) => code === 0 ? finish() : finish(new Error(`${step.label} failed (code ${code ?? "unknown"}, signal ${exitSignal ?? "none"}). The environment may be partial; inspect it and run Repair.`)));
        if (signal?.aborted) abort();
    });
}

export async function executePythonEnvironmentOperation(familyInput: unknown, operation: PythonEnvironmentOperation, onProgress: (progress: PythonEnvironmentProgress) => void, signal?: AbortSignal): Promise<PythonEnvironmentStatus> {
    const family = requireFamily(familyInput); if (operation !== "install" && operation !== "repair") throw new Error("Invalid Python environment operation.");
    const specs = await getSpecs(); const initial = await inspectEnvironment(family, specs);
    if (initial.state === "incompatible") throw new Error(initial.issues.join(" "));
    const steps = buildPythonEnvironmentOperationSteps(family, operation);
    for (let index = 0; index < steps.length; index++) await runProcessStep(steps[index], index, steps.length, onProgress, signal);
    onProgress({ step: steps.length, totalSteps: steps.length, message: "Reinspecting environment", stream: "manager" });
    return inspectEnvironment(family, specs);
}

interface WorkerResponse { protocol: number; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
// A request has no inherent deadline otherwise: if the worker process stays
// alive but stops responding (stuck in a long computation, deadlocked, or
// just never writes a line back), the promise in `pending` would never
// settle and would leak forever. Overridable per-instance (see
// ManagedPythonWorkerOptions) so tests aren't stuck waiting out the real
// production default just to exercise the timeout path.
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
// Bounds how much unterminated stdout `consume` will buffer waiting for a
// newline. A worker that never emits one (buggy print, corrupted output)
// would otherwise grow this string without limit for as long as the process
// lives — this caps the damage and fails loudly instead of leaking memory.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface ManagedPythonWorkerOptions {
    // Per-request deadline; defaults to DEFAULT_REQUEST_TIMEOUT_MS.
    timeoutMs?: number;
    // Overrides the spawned command/args — used by tests to substitute a
    // small fake worker (e.g. `node -e "<script>"`) for the real Python
    // interpreter/script, since CI can't assume a working Python venv with the right packages
    // is present just to test request plumbing. Production callers never
    // set these; environmentPython()/the packaged script path are used.
    command?: string;
    args?: string[];
}

export class ManagedPythonWorker {
    private child: ChildProcess | null = null;
    private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    private buffer = "";
    private readonly timeoutMs: number;
    private readonly commandOverride?: string;
    private readonly argsOverride?: string[];

    constructor(private readonly family: PythonRuntimeFamily, options: ManagedPythonWorkerOptions = {}) {
        this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.commandOverride = options.command;
        this.argsOverride = options.args;
    }

    start(): void {
        if (this.child) return;
        const python = this.commandOverride ?? environmentPython(this.family);
        let args: string[];
        if (this.argsOverride) {
            args = this.argsOverride;
        } else {
            const scriptName = this.family === "hardware-recommender" ? "recommender_worker.py" : "runtime_worker.py";
            const packaged = path.join(process.resourcesPath, "python", scriptName);
            const script = fs.existsSync(packaged) ? packaged : path.join(__dirname, "..", "python", scriptName);
            args = [script];
        }
        const child = spawn(python, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
        this.child = child;

        // Every listener below closes over this specific `child` and bails
        // if `this.child` has since moved on to a different instance. Without
        // that guard, a *late* async event from an old, already-replaced
        // child (e.g. the real OS 'exit' for a process this.consume() just
        // SIGKILLed after a buffer overflow, arriving after start() was
        // called again and spawned a new one) would call failAllPending()
        // against the new child's in-flight requests and null out
        // this.child out from under it — silently orphaning the process
        // that's actually still running.
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => { if (this.child === child) this.consume(chunk); });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            for (const line of chunk.split(/\r?\n/).filter(Boolean)) console.info(`[python-worker:${this.family}] ${line}`);
        });
        // Without this, a missing/unset-up venv (spawn ENOENT — the common
        // case for a family the user hasn't installed yet) emits an 'error'
        // event with no listener, which Node treats as an uncaught exception
        // and crashes the whole main process instead of just failing this
        // one request.
        child.once("error", (error: Error) => {
            if (this.child !== child) return;
            this.failAllPending(error);
            this.child = null;
        });
        child.once("exit", () => {
            if (this.child !== child) return;
            this.failAllPending(new Error(`Python worker "${this.family}" exited`));
            this.child = null;
        });
    }

    private failAllPending(error: Error): void {
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
        this.buffer = "";
    }

    private consume(chunk: string): void {
        this.buffer += chunk;
        if (this.buffer.length > MAX_BUFFER_BYTES) {
            // Something is badly wrong (runaway output, no newlines) — treat
            // it as fatal rather than let the process keep growing memory.
            const error = new Error(`Python worker "${this.family}" exceeded the ${MAX_BUFFER_BYTES}-byte output buffer without a complete line`);
            const child = this.child;
            this.failAllPending(error);
            if (child?.pid) killProcessTree(child.pid, "SIGKILL");
            this.child = null;
            return;
        }
        const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line) continue;
            let response: WorkerResponse;
            try {
                response = JSON.parse(line) as WorkerResponse;
            } catch {
                // A worker writing something to stdout that isn't a
                // protocol response (a stray print, partial/corrupted
                // output) must not crash the main process or wedge whatever
                // request is actually pending — log and keep consuming.
                console.error(`[python-worker:${this.family}] Ignoring malformed response line: ${line.slice(0, 200)}`);
                continue;
            }
            if (typeof response?.id !== "string") {
                console.error(`[python-worker:${this.family}] Ignoring response with no request id: ${line.slice(0, 200)}`);
                continue;
            }
            const pending = this.pending.get(response.id);
            if (!pending) continue;
            clearTimeout(pending.timer);
            this.pending.delete(response.id);
            response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error?.message ?? "Worker request failed"));
        }
    }

    request(method: "health" | "metrics" | "recommend", params: Record<string, unknown> = {}): Promise<unknown> {
        this.start();
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Python worker "${this.family}" request "${method}" timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child?.stdin?.write(JSON.stringify({ protocol: PYTHON_WORKER_PROTOCOL_VERSION, id, method, params }) + "\n");
        });
    }

    async shutdown(): Promise<void> {
        const child = this.child;
        if (!child) return;
        const pid = child.pid;
        try {
            const id = crypto.randomUUID();
            child.stdin?.write(JSON.stringify({ protocol: PYTHON_WORKER_PROTOCOL_VERSION, id, method: "shutdown", params: {} }) + "\n");
        } catch {
            /* pipe closed */
        }
        // Reject immediately rather than only relying on the child's async
        // 'exit' event to eventually fire failAllPending() — that event can
        // lag behind (up to the 500ms grace period below, longer if the
        // process ignores SIGTERM until a future SIGKILL), and a caller
        // awaiting a pending request during shutdown shouldn't be left
        // hanging for that long.
        this.failAllPending(new Error(`Python worker "${this.family}" is shutting down`));
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (pid && this.child === child) killProcessTree(pid, "SIGTERM");
        if (this.child === child) this.child = null;
    }
}
