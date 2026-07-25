import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import pidusage from "pidusage";
import { logger } from "./logger";
import { killProcessTree } from "./process-tree";
import { environmentPython } from "./python-runtime-manager";

const execFileAsync = promisify(execFile);
export type LocalBackendId = "mlx" | "rocm" | "vllm";
export type RuntimeLifecycleState = "starting" | "running" | "unhealthy" | "stopped";

export interface LocalBackendConfig { rocmServerPath?: string; mlxPythonPath?: string; vllmCommand?: string }
export interface RuntimeProbe { compatible: boolean; command: string; args: string[]; detail: string }
export interface LocalRuntimeStatus {
    backend: LocalBackendId; compatible: boolean; installed: boolean; running: boolean; state: RuntimeLifecycleState;
    model?: string; detail: string; device?: string; pid: number | null; port: number | null; startedAt: string | null;
    uptimeSeconds: number; ramMB: number | null; vramMB: number | null; logs: string[]; startupError?: string;
    installCommand: string; environmentIssues: string[];
}

interface RunningServer {
    process: ChildProcess; model: string; baseUrl: string; port: number; state: RuntimeLifecycleState; exited: boolean;
    startedAt: number; activeRequests: number; idleTimer: NodeJS.Timeout | null; logs: string[]; logRemainder: string;
    startupError?: string;
}

const STARTUP_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 750;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_CHARS = 4_000;
const configuredIdleMinutes = Number(process.env.OLLAMA_CUSTOM_UI_LOCAL_BACKEND_IDLE_MINUTES ?? 10);
const IDLE_TIMEOUT_MS = Number.isFinite(configuredIdleMinutes) ? Math.max(0, configuredIdleMinutes) * 60_000 : 600_000;
const servers = new Map<LocalBackendId, RunningServer>();
const serverStarts = new Map<LocalBackendId, { model: string; promise: Promise<string> }>();
const stoppedSnapshots = new Map<LocalBackendId, Pick<LocalRuntimeStatus, "logs" | "startupError" | "model">>();
const probeCache = new Map<string, { installed: boolean; expiresAt: number }>();

export function buildRuntimeProbe(backend: LocalBackendId, config: LocalBackendConfig, platform: NodeJS.Platform = process.platform, arch = process.arch): RuntimeProbe {
    if (backend === "mlx") {
        const compatible = platform === "darwin" && arch === "arm64";
        const managedPython = environmentPython("mlx", platform);
        return { compatible, command: config.mlxPythonPath?.trim() || (fs.existsSync(managedPython) ? managedPython : "python3"), args: ["-c", "import mlx_lm"], detail: compatible ? "Apple Silicon accelerated runtime" : "Requires an Apple Silicon Mac" };
    }
    if (backend === "vllm") {
        const compatible = platform === "linux" || platform === "win32";
        if (!config.vllmCommand?.trim() && platform === "win32") return { compatible, command: "wsl.exe", args: ["--", "vllm", "--version"], detail: "CUDA or ROCm runtime through WSL" };
        return { compatible, command: config.vllmCommand?.trim() || "vllm", args: ["--version"], detail: compatible ? "High-throughput CUDA or ROCm runtime" : "Requires Linux or Windows with WSL" };
    }
    const compatible = platform === "linux" || !!config.rocmServerPath?.trim();
    return { compatible, command: config.rocmServerPath?.trim() || "llama-server", args: ["--version"], detail: compatible ? "AMD GPU runtime for local GGUF models" : "Requires Linux and a ROCm-capable AMD GPU" };
}

export function installCommand(backend: LocalBackendId): string {
    if (backend === "mlx") return "python3 -m pip install mlx-lm";
    if (backend === "vllm") return "python3 -m pip install vllm";
    return "Install a ROCm/HIP llama-server build, then configure its executable in Settings";
}

export function describeSpawnFailure(backend: LocalBackendId): string {
    if (backend === "mlx") return "Couldn't launch MLX. Install mlx-lm on an Apple Silicon Mac and verify the configured Python interpreter.";
    if (backend === "vllm") return "Couldn't launch vLLM. Install vLLM in Linux/WSL and verify that its CUDA or ROCm requirements match the GPU driver.";
    return "Couldn't launch ROCm llama-server. Configure a working ROCm/HIP llama-server executable and verify ROCm device access.";
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false; let child: ChildProcess;
        const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
        try { child = spawn(command, args, { stdio: "ignore", windowsHide: true }); } catch { resolve(false); return; }
        const timer = setTimeout(() => { child.kill(); finish(false); }, 5_000); timer.unref();
        child.once("error", () => finish(false)); child.once("exit", (code) => finish(code === 0));
    });
}

async function cachedCommandSucceeds(command: string, args: string[]): Promise<boolean> {
    const key = JSON.stringify([command, args]); const cached = probeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.installed;
    const installed = await commandSucceeds(command, args);
    probeCache.set(key, { installed, expiresAt: Date.now() + 30_000 });
    return installed;
}

export async function allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = createServer();
        socket.unref(); socket.once("error", reject);
        socket.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
            const address = socket.address();
            if (!address || typeof address === "string") { socket.close(); reject(new Error("Could not allocate a local runtime port")); return; }
            const port = address.port; socket.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

export function buildServerCommand(backend: LocalBackendId, model: string, config: LocalBackendConfig, platform: NodeJS.Platform = process.platform, port = 0): { command: string; args: string[] } {
    if (!port) throw new Error("A dynamically allocated runtime port is required");
    if (backend === "mlx") { const managed = environmentPython("mlx", platform); return { command: config.mlxPythonPath?.trim() || (fs.existsSync(managed) ? managed : "python3"), args: ["-m", "mlx_lm.server", "--model", model, "--port", String(port), "--host", "127.0.0.1"] }; }
    if (backend === "vllm") {
        const args = ["serve", model, "--port", String(port), "--host", "127.0.0.1"];
        const cudaExecutable = path.join(path.dirname(environmentPython("vllm-cuda", platform)), platform === "win32" ? "vllm.exe" : "vllm");
        const rocmExecutable = path.join(path.dirname(environmentPython("vllm-rocm", platform)), platform === "win32" ? "vllm.exe" : "vllm");
        const managed = fs.existsSync(cudaExecutable) ? cudaExecutable : fs.existsSync(rocmExecutable) ? rocmExecutable : undefined;
        return !config.vllmCommand?.trim() && !managed && platform === "win32" ? { command: "wsl.exe", args: ["--", "vllm", ...args] } : { command: config.vllmCommand?.trim() || managed || "vllm", args };
    }
    return { command: config.rocmServerPath?.trim() || "llama-server", args: ["-m", model, "--port", String(port), "--host", "127.0.0.1", "--n-gpu-layers", "999"] };
}

function pushLog(entry: RunningServer, source: "stdout" | "stderr" | "manager", text: string): void {
    const combined = entry.logRemainder + text; const lines = combined.split(/\r?\n/); entry.logRemainder = lines.pop() ?? "";
    for (const line of lines) { if (!line) continue; entry.logs.push(`${new Date().toISOString()} [${source}] ${line.slice(0, MAX_LOG_LINE_CHARS)}`); }
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
}

export function identityMatches(payload: unknown, expectedModel: string): boolean {
    if (!payload || typeof payload !== "object") return false;
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return false;
    const ids = data.map((item) => String((item as { id?: unknown })?.id ?? "").toLowerCase()).filter(Boolean);
    if (!ids.length) return false;
    const expected = expectedModel.toLowerCase(); const leaf = expected.split(/[\\/]/).pop() ?? expected;
    return ids.some((id) => id === expected || id.includes(leaf) || expected.includes(id));
}

async function healthCheck(baseUrl: string, expectedModel: string): Promise<boolean> {
    try {
        const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return false;
        return identityMatches(await response.json(), expectedModel);
    } catch { return false; }
}

function clearIdleTimer(server: RunningServer): void { if (server.idleTimer) clearTimeout(server.idleTimer); server.idleTimer = null; }
function scheduleIdleStop(backend: LocalBackendId, server: RunningServer): void {
    clearIdleTimer(server); if (!IDLE_TIMEOUT_MS || server.activeRequests || server.exited) return;
    server.idleTimer = setTimeout(() => { if (servers.get(backend) === server && !server.activeRequests) stopServer(backend); }, IDLE_TIMEOUT_MS); server.idleTimer.unref();
}

async function startOrReuseServer(backend: LocalBackendId, model: string, config: LocalBackendConfig): Promise<string> {
    const existing = servers.get(backend);
    if (existing && !existing.exited && existing.model === model && await healthCheck(existing.baseUrl, model)) return existing.baseUrl;
    if (existing) { if (existing.activeRequests) throw new Error(`The ${backend} runtime is busy.`); stopServer(backend); }
    const port = await allocatePort(); const baseUrl = `http://127.0.0.1:${port}`; const { command, args } = buildServerCommand(backend, model, config, process.platform, port);
    let child: ChildProcess;
    try { child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" }); } catch { throw new Error(describeSpawnFailure(backend)); }
    const entry: RunningServer = { process: child, model, baseUrl, port, state: "starting", exited: false, startedAt: Date.now(), activeRequests: 0, idleTimer: null, logs: [], logRemainder: "" };
    servers.set(backend, entry); pushLog(entry, "manager", `Starting ${command} ${args.join(" ")}`);
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8"); child.stdout?.on("data", (data: string) => pushLog(entry, "stdout", data)); child.stderr?.on("data", (data: string) => pushLog(entry, "stderr", data));
    let spawnError: string | null = null;
    child.on("error", (error: NodeJS.ErrnoException) => { spawnError = error.code === "ENOENT" ? describeSpawnFailure(backend) : error.message; entry.startupError = spawnError; entry.state = "unhealthy"; entry.exited = true; });
    child.on("exit", (code, signal) => { entry.exited = true; entry.state = code === 0 ? "stopped" : "unhealthy"; pushLog(entry, "manager", `Process exited code=${code ?? "null"} signal=${signal ?? "none"}`); if (code) entry.startupError = explainStartupFailure(backend, entry.logs); });
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (spawnError) throw new Error(spawnError);
        if (entry.exited) { const explanation = entry.startupError ?? explainStartupFailure(backend, entry.logs); stoppedSnapshots.set(backend, { logs: [...entry.logs], startupError: explanation, model }); servers.delete(backend); throw new Error(explanation); }
        if (await healthCheck(baseUrl, model)) { entry.state = "running"; pushLog(entry, "manager", `Identity health check passed on port ${port}`); scheduleIdleStop(backend, entry); return baseUrl; }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    entry.state = "unhealthy"; entry.startupError = `Runtime did not identify itself within ${STARTUP_TIMEOUT_MS / 1000}s. ${explainStartupFailure(backend, entry.logs)}`; stopServer(backend); throw new Error(entry.startupError);
}

export function explainStartupFailure(backend: LocalBackendId, logs: string[]): string {
    const text = logs.slice(-80).join("\n");
    if (/out of memory|cuda.*memory|hip.*memory|cannot allocate/i.test(text)) return `${backend} could not load the model because available RAM or VRAM is insufficient.`;
    if (/no module named|module.*not found/i.test(text)) return `${backend} is missing a Python package. ${installCommand(backend)}.`;
    if (/permission denied|eacces/i.test(text)) return `${backend} could not execute or access the model because of filesystem permissions.`;
    if (/not found|enoent|no such file/i.test(text)) return `${backend} could not find its executable or model. Validate the configured paths.`;
    if (/cuda|driver|rocm|hip/i.test(text)) return `${backend} failed GPU initialization. Verify the driver, runtime version, and device compatibility.`;
    return `${backend} exited before becoming healthy. Review the captured runtime logs for the original error.`;
}

export async function ensureServer(backend: LocalBackendId, model: string, config: LocalBackendConfig): Promise<string> {
    const pending = serverStarts.get(backend); if (pending) { if (pending.model === model) return pending.promise; await pending.promise.catch(() => undefined); return ensureServer(backend, model, config); }
    const promise = startOrReuseServer(backend, model, config); serverStarts.set(backend, { model, promise });
    try { return await promise; } finally { if (serverStarts.get(backend)?.promise === promise) serverStarts.delete(backend); }
}
export async function startServer(backend: LocalBackendId, model: string, config: LocalBackendConfig): Promise<string> { return ensureServer(backend, model, config); }
export async function restartServer(backend: LocalBackendId, model: string, config: LocalBackendConfig): Promise<string> { stopServer(backend); return ensureServer(backend, model, config); }

export async function acquireServer(backend: LocalBackendId, model: string, config: LocalBackendConfig): Promise<{ baseUrl: string; release(): void }> {
    const current = servers.get(backend); if (current) clearIdleTimer(current); const baseUrl = await ensureServer(backend, model, config); const server = servers.get(backend);
    if (!server || server.exited || server.model !== model) throw new Error(`The ${backend} runtime stopped before the request could start.`);
    server.activeRequests++; let released = false;
    return { baseUrl, release() { if (released) return; released = true; if (servers.get(backend) !== server) return; server.activeRequests = Math.max(0, server.activeRequests - 1); scheduleIdleStop(backend, server); } };
}

export function stopServer(backend: LocalBackendId): void {
    const entry = servers.get(backend); if (!entry) return; clearIdleTimer(entry); pushLog(entry, "manager", "Stop requested");
    stoppedSnapshots.set(backend, { logs: [...entry.logs], startupError: entry.startupError, model: entry.model });
    const pid = entry.process.pid; entry.process.kill("SIGTERM");
    if (pid) { const timer = setTimeout(() => { if (!entry.exited) killProcessTree(pid, "SIGKILL"); }, 5_000); timer.unref(); }
    servers.delete(backend);
}
export function stopAll(): void { serverStarts.clear(); for (const backend of [...servers.keys()]) stopServer(backend); }
export function getRunningBackends(): { backend: LocalBackendId; model: string }[] { return [...servers].filter(([, server]) => !server.exited).map(([backend, server]) => ({ backend, model: server.model })); }

async function gpuProcessMemory(pid: number): Promise<{ device?: string; vramMB: number | null }> {
    try {
        const { stdout } = await execFileAsync("nvidia-smi", ["--query-compute-apps=pid,gpu_name,used_memory", "--format=csv,noheader,nounits"], { timeout: 2_000, windowsHide: true });
        for (const line of stdout.split(/\r?\n/)) { const [rawPid, device, memory] = line.split(",").map((item) => item.trim()); if (Number(rawPid) === pid) return { device, vramMB: Number(memory) }; }
    } catch { /* unavailable or non-NVIDIA */ }
    return { vramMB: null };
}

export async function getRuntimeStatuses(config: LocalBackendConfig): Promise<LocalRuntimeStatus[]> {
    return Promise.all((["rocm", "mlx", "vllm"] as const).map(async (backend) => {
        const probe = buildRuntimeProbe(backend, config); const server = servers.get(backend); const live = !!server && !server.exited;
        const installed = probe.compatible && (live || await cachedCommandSucceeds(probe.command, probe.args));
        let ramMB: number | null = null; let vramMB: number | null = null; let device: string | undefined;
        if (live && server.process.pid) {
            try { ramMB = (await pidusage(server.process.pid)).memory / 1024 / 1024; } catch { /* exited between reads */ }
            const gpu = await gpuProcessMemory(server.process.pid); vramMB = gpu.vramMB; device = gpu.device;
            if (server.state === "running" && !(await healthCheck(server.baseUrl, server.model))) server.state = "unhealthy";
        }
        const snapshot = stoppedSnapshots.get(backend); const issues: string[] = [];
        if (!probe.compatible) issues.push(probe.detail); if (probe.compatible && !installed) issues.push(`Runtime executable unavailable: ${probe.command}`);
        return { backend, compatible: probe.compatible, installed, running: live && server.state === "running", state: server?.state ?? "stopped", model: server?.model ?? snapshot?.model,
            detail: probe.detail, device, pid: server?.process.pid ?? null, port: server?.port ?? null, startedAt: server ? new Date(server.startedAt).toISOString() : null,
            uptimeSeconds: server ? Math.max(0, (Date.now() - server.startedAt) / 1000) : 0, ramMB: ramMB === null ? null : +ramMB.toFixed(1), vramMB,
            logs: server ? [...server.logs] : snapshot?.logs ?? [], startupError: server?.startupError ?? snapshot?.startupError,
            installCommand: installCommand(backend), environmentIssues: issues };
    }));
}
