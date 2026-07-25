import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import { killProcessTree } from "./process-tree";
import { getSpecs, type SystemSpecs } from "./system-specs";

const execFileAsync = promisify(execFile);
export const PYTHON_WORKER_PROTOCOL_VERSION = 1;
export type PythonRuntimeFamily = "mlx" | "vllm-cuda" | "vllm-rocm";
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
};

function environmentRoot(): string { return path.join(app.getPath("userData"), "python-runtimes"); }
function usesWsl(family: PythonRuntimeFamily): boolean { return process.platform === "win32" && family !== "mlx"; }
export function environmentDestination(family: PythonRuntimeFamily): string { return usesWsl(family) ? `~/.local/share/modelforge/python-runtimes/${family}` : path.join(environmentRoot(), family); }
export function environmentPython(family: PythonRuntimeFamily, platform: NodeJS.Platform = process.platform): string {
    if (platform === "win32" && family !== "mlx") return `${environmentDestination(family)}/bin/python`;
    return path.join(environmentDestination(family), platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
function quote(value: string): string { return process.platform === "win32" ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, `'"'"'`)}'`; }
function posixQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function packageSpec(manifest: PythonRuntimeManifest): string { return Object.entries(manifest.packages).map(([name, version]) => `${name}==${version}`).join(" "); }
function basePythonCommand(): string { return process.platform === "win32" ? "py -3.12" : "python3.12"; }

export function compatibilityIssues(family: PythonRuntimeFamily, specs: SystemSpecs): string[] {
    if (family === "mlx") return specs.platform === "darwin" && specs.arch === "arm64" ? [] : ["MLX requires macOS on Apple Silicon."];
    if (specs.platform === "darwin") return ["vLLM GPU environments require Linux or Windows through WSL."];
    const vendors = new Set(specs.gpus.map((gpu) => gpu.vendor));
    if (family === "vllm-cuda" && !vendors.has("nvidia")) return ["No NVIDIA GPU was detected for the CUDA environment."];
    if (family === "vllm-rocm" && !vendors.has("amd")) return ["No AMD GPU was detected for the ROCm environment."];
    return [];
}

function pythonVersionSupported(family: PythonRuntimeFamily, version: string): boolean {
    const [major, minor] = version.split(".").map(Number); const upperMinor = family === "mlx" ? 14 : 15;
    return major === 3 && minor >= 10 && minor < upperMinor;
}

async function acceleratorIssues(family: PythonRuntimeFamily): Promise<string[]> {
    if (family === "mlx") return [];
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
    const target = manifest.family === "vllm-rocm" ? `VLLM_TARGET_DEVICE=rocm ${quote(python)} -m pip install --no-cache-dir ${packages}` : `${quote(python)} -m pip install --only-binary=:all: ${packages}`;
    const installCommand = `${basePythonCommand()} -m venv ${quote(destination)} && ${quote(python)} -m pip install --upgrade pip==26.1 && ${target}`;
    const repairTarget = manifest.family === "vllm-rocm" ? target : `${quote(python)} -m pip install --force-reinstall --only-binary=:all: ${packages}`;
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

interface WorkerResponse { protocol: number; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
export class ManagedPythonWorker {
    private child: ChildProcess | null = null; private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>(); private buffer = "";
    constructor(private readonly family: PythonRuntimeFamily) {}
    start(): void {
        if (this.child) return; const python = environmentPython(this.family); const packaged = path.join(process.resourcesPath, "python", "runtime_worker.py"); const script = fs.existsSync(packaged) ? packaged : path.join(__dirname, "..", "python", "runtime_worker.py");
        this.child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
        this.child.stdout?.setEncoding("utf8"); this.child.stdout?.on("data", (chunk: string) => this.consume(chunk));
        this.child.stderr?.setEncoding("utf8"); this.child.stderr?.on("data", (chunk: string) => { for (const line of chunk.split(/\r?\n/).filter(Boolean)) console.info(`[python-worker:${this.family}] ${line}`); });
        this.child.once("exit", () => { for (const request of this.pending.values()) request.reject(new Error("Python worker exited")); this.pending.clear(); this.child = null; });
    }
    private consume(chunk: string): void { this.buffer += chunk; const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop() ?? ""; for (const line of lines) { if (!line) continue; const response = JSON.parse(line) as WorkerResponse; const pending = this.pending.get(response.id); if (!pending) continue; this.pending.delete(response.id); response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error?.message ?? "Worker request failed")); } }
    request(method: "health" | "metrics", params: Record<string, unknown> = {}): Promise<unknown> { this.start(); const id = crypto.randomUUID(); return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child?.stdin?.write(JSON.stringify({ protocol: PYTHON_WORKER_PROTOCOL_VERSION, id, method, params }) + "\n"); }); }
    async shutdown(): Promise<void> { const child = this.child; if (!child) return; const pid = child.pid; try { const id = crypto.randomUUID(); child.stdin?.write(JSON.stringify({ protocol: PYTHON_WORKER_PROTOCOL_VERSION, id, method: "shutdown", params: {} }) + "\n"); } catch { /* pipe closed */ } await new Promise((resolve) => setTimeout(resolve, 500)); if (pid && this.child) killProcessTree(pid, "SIGTERM"); this.child = null; }
}
