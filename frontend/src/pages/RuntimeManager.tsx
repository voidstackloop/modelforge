import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Activity, ArrowLeft, CircleStop, Clipboard, Cpu, HardDrive, PackageOpen, Play, RefreshCw, RotateCw, Server, Terminal, TriangleAlert, Wrench, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LocalRuntimeStatus, PythonEnvironmentStatus } from "@/types/electron";

const backendNames = { mlx: "MLX", rocm: "ROCm llama.cpp", vllm: "vLLM" } as const;
const stateStyles = {
  starting: "bg-blue-500/10 text-blue-600", running: "bg-emerald-500/10 text-emerald-600",
  unhealthy: "bg-destructive/10 text-destructive", stopped: "bg-muted text-muted-foreground",
};
function memory(value: number | null): string { return value === null ? "Unavailable" : value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(0)} MB`; }
function uptime(seconds: number): string { const h = Math.floor(seconds / 3600); const m = Math.floor(seconds % 3600 / 60); const s = Math.floor(seconds % 60); return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`; }

export default function RuntimeManager() {
  const navigate = useNavigate();
  const [statuses, setStatuses] = useState<LocalRuntimeStatus[]>([]);
  const [models, setModels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<Record<string, string>>({});
  const [environments, setEnvironments] = useState<PythonEnvironmentStatus[]>([]);
  const [environmentsLoading, setEnvironmentsLoading] = useState(false);
  const hasApi = typeof window !== "undefined" && !!window.api?.localBackends;
  // Process status (PID/port/uptime/logs) is cheap to poll — it just reads
  // already-running child processes. Python environment inspection is not:
  // per family it can spawn nvidia-smi/rocminfo/wsl.exe and a Python
  // interpreter just to check installed package versions, each with its own
  // multi-second timeout. Polling that every 2.5s alongside process status
  // was a subprocess storm for state that only changes on install/repair, so
  // it's fetched once on entry and re-fetched only on those explicit triggers
  // (or a manual refresh) rather than on the same interval as process status.
  const refreshStatuses = useCallback(async () => { if (hasApi) setStatuses(await window.api.localBackends.getStatuses()); }, [hasApi]);
  const refreshEnvironments = useCallback(async () => {
    if (!hasApi) return;
    setEnvironmentsLoading(true);
    try { setEnvironments(await window.api.pythonRuntimes.getStatuses()); }
    finally { setEnvironmentsLoading(false); }
  }, [hasApi]);
  const refreshAll = useCallback(async () => { await Promise.all([refreshStatuses(), refreshEnvironments()]); }, [refreshStatuses, refreshEnvironments]);
  useEffect(() => { void refreshStatuses(); const timer = setInterval(() => void refreshStatuses(), 2500); return () => clearInterval(timer); }, [refreshStatuses]);
  useEffect(() => { void refreshEnvironments(); }, [refreshEnvironments]);
  useEffect(() => { setModels((current) => Object.fromEntries(statuses.map((status) => [status.backend, current[status.backend] ?? status.model ?? ""]))); }, [statuses]);

  async function run(backend: LocalRuntimeStatus["backend"], action: "start" | "stop" | "restart" | "unload") {
    setBusy((value) => ({ ...value, [backend]: true })); setError((value) => ({ ...value, [backend]: "" }));
    try {
      if (action === "start" || action === "restart") {
        const model = models[backend]?.trim(); if (!model) throw new Error("Enter a Hugging Face model ID or local model path first.");
        await window.api.localBackends[action](backend, model);
      } else await window.api.localBackends[action](backend);
    } catch (reason) { setError((value) => ({ ...value, [backend]: (reason as Error).message })); }
    finally { setBusy((value) => ({ ...value, [backend]: false })); await refreshStatuses(); }
  }

  return <main className="min-h-full bg-background p-5 md:p-8"><div className="mx-auto max-w-6xl space-y-6">
    <header className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ArrowLeft className="size-4" /></Button><span className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Server className="size-5" /></span><div><h1 className="text-2xl font-semibold">Runtime Manager</h1><p className="text-sm text-muted-foreground">Managed MLX, ROCm, and vLLM processes</p></div></div><Button variant="outline" onClick={refreshAll}><RefreshCw className="mr-2 size-4" />Refresh</Button></header>
    <section className="rounded-2xl border bg-card p-5 shadow-sm"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><PackageOpen className="size-5" />Managed Python environments</h2><p className="text-sm text-muted-foreground">Every runtime family has an isolated, pinned virtual environment. Commands are shown for your approval and are never executed silently.</p></div><Button size="sm" variant="ghost" disabled={environmentsLoading} onClick={refreshEnvironments}><RefreshCw className={`mr-1.5 size-3.5 ${environmentsLoading ? "animate-spin" : ""}`} />Recheck environments</Button></div><div className="grid gap-4 lg:grid-cols-3">{environments.map((environment) => <div key={environment.family} className="rounded-xl border bg-background/60 p-4"><div className="flex items-center justify-between gap-2"><h3 className="font-medium">{environment.family}</h3><span className={`rounded-full px-2 py-0.5 text-xs ${environment.state === "healthy" ? "bg-emerald-500/10 text-emerald-600" : environment.state === "incompatible" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-600"}`}>{environment.state}</span></div><p className="mt-2 break-all text-xs text-muted-foreground">{environment.destination}</p><dl className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><dt className="text-muted-foreground">Disk required</dt><dd>{memory(environment.manifest.diskRequirementBytes / 1024 / 1024)}</dd></div><div><dt className="text-muted-foreground">Expected download</dt><dd>{memory(environment.manifest.expectedDownloadBytes / 1024 / 1024)}</dd></div><div><dt className="text-muted-foreground">Python</dt><dd>{environment.pythonVersion ?? environment.manifest.python}</dd></div><div><dt className="text-muted-foreground">Worker protocol</dt><dd>v{environment.manifest.protocolVersion}</dd></div></dl><p className="mt-3 text-xs text-muted-foreground">{Object.entries(environment.manifest.packages).map(([name, version]) => `${name}==${version}`).join(" · ")}</p>{environment.issues.length > 0 && <p className="mt-3 text-xs text-amber-700">{environment.issues.join(" ")}</p>}<div className="mt-4 flex flex-wrap gap-2">{environment.state === "missing" && <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(environment.installCommand)}><Clipboard className="mr-1.5 size-3.5" />Copy install command</Button>}{environment.state === "drifted" && <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(environment.repairCommand)}><Wrench className="mr-1.5 size-3.5" />Copy repair command</Button>}<Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(environment.destination)}>Copy destination</Button></div>{environment.state !== "healthy" && environment.state !== "incompatible" && <details className="mt-3"><summary className="cursor-pointer text-xs font-medium">Review command</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-[11px] text-zinc-200">{environment.state === "drifted" ? environment.repairCommand : environment.installCommand}</pre></details>}</div>)}</div></section>
    <div className="grid gap-5">{statuses.map((status) => {
      const model = models[status.backend] ?? ""; const logsOpen = expandedLogs[status.backend]; const runtimeError = error[status.backend] || status.startupError;
      return <article key={status.backend} className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">{backendNames[status.backend]}</h2><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${stateStyles[status.state]}`}>{status.state}</span><span className={`rounded-full px-2.5 py-1 text-xs ${status.installed ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{status.installed ? "Installed" : "Not installed"}</span><span className={`rounded-full px-2.5 py-1 text-xs ${status.compatible ? "bg-blue-500/10 text-blue-600" : "bg-destructive/10 text-destructive"}`}>{status.compatible ? "Compatible" : "Incompatible"}</span></div><p className="mt-1 text-sm text-muted-foreground">{status.detail}</p></div>
          <div className="flex flex-wrap gap-2">{status.state === "stopped" ? <Button disabled={busy[status.backend] || !status.compatible} onClick={() => run(status.backend, "start")}><Play className="mr-2 size-4" />Start</Button> : <><Button variant="outline" disabled={busy[status.backend]} onClick={() => run(status.backend, "restart")}><RotateCw className="mr-2 size-4" />Restart</Button><Button variant="outline" disabled={busy[status.backend]} onClick={() => run(status.backend, "stop")}><CircleStop className="mr-2 size-4" />Stop</Button><Button variant="ghost" disabled={busy[status.backend]} onClick={() => run(status.backend, "unload")}><XCircle className="mr-2 size-4" />Unload</Button></>}</div></div>
          <label className="mt-5 block text-xs text-muted-foreground">Model ID or local path<Input className="mt-1.5" value={model} disabled={status.state === "running" || status.state === "starting"} onChange={(event) => setModels((value) => ({ ...value, [status.backend]: event.target.value }))} placeholder={status.backend === "rocm" ? "/models/model.gguf" : "organization/model-name"} /></label>
          <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Metric icon={<Cpu />} label="PID" value={status.pid?.toString() ?? "—"} /><Metric icon={<Server />} label="Port" value={status.port?.toString() ?? "Dynamic"} /><Metric icon={<Activity />} label="Uptime" value={status.running ? uptime(status.uptimeSeconds) : "—"} /><Metric icon={<HardDrive />} label="RAM" value={memory(status.ramMB)} /><Metric icon={<HardDrive />} label="VRAM" value={memory(status.vramMB)} /><Metric icon={<Cpu />} label="GPU device" value={status.device ?? "Unavailable"} />
          </div>
          {status.environmentIssues.length > 0 && <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-700"><TriangleAlert className="mr-2 inline size-4" />{status.environmentIssues.join(" · ")}</div>}
          {runtimeError && <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"><TriangleAlert className="mr-2 inline size-4" />{runtimeError}</div>}
          {!status.installed && status.compatible && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/60 p-3"><div><p className="text-sm font-medium">Installation guidance</p><code className="text-xs text-muted-foreground">{status.installCommand}</code></div><Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(status.installCommand)}><Clipboard className="mr-2 size-3.5" />Copy command</Button></div>}
        </div>
        <div className="border-t bg-background/40"><button className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium" onClick={() => setExpandedLogs((value) => ({ ...value, [status.backend]: !logsOpen }))}><span><Terminal className="mr-2 inline size-4" />Runtime logs ({status.logs.length})</span><span className="text-xs text-muted-foreground">{logsOpen ? "Hide" : "Show"}</span></button>{logsOpen && <pre className="max-h-80 overflow-auto border-t bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-200">{status.logs.length ? status.logs.join("\n") : "No runtime output captured yet."}</pre>}</div>
      </article>;
    })}</div>
    {!hasApi && <p className="rounded-xl border p-6 text-center text-muted-foreground">Runtime management is available in the desktop application.</p>}
  </div></main>;
}

function Metric({ icon, label, value }: { icon: ReactElement; label: string; value: string }) {
  return <div className="min-w-0 rounded-xl border bg-background/60 p-3"><div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><span className="[&>svg]:size-3">{icon}</span>{label}</div><p className="mt-1 truncate text-sm font-medium" title={value}>{value}</p></div>;
}
