import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Download, Gauge, HardDrive, Pause, Play, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DiskForecast, DownloadControls, DownloadJob, DownloadJobState } from "@/types/electron";

function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function duration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60); const remainder = Math.ceil(seconds % 60);
  return `${minutes}m ${remainder}s`;
}
function stateLabel(job: DownloadJob): string {
  if (job.state === "verifying") return "Verifying checksum";
  if (job.state === "ready") return "Ready";
  if (job.state === "failed") return "Failed";
  if (job.state === "paused") return "Paused (.part preserved)";
  if (job.state === "cancelled") return "Cancelled";
  if (job.shards.some((shard) => shard.receivedBytes > 0)) return `${job.state === "downloading" ? "Downloading" : "Partial"} (.part)`;
  return job.state[0].toUpperCase() + job.state.slice(1);
}
const stateTone: Record<DownloadJobState, string> = {
  queued: "bg-muted text-muted-foreground", resolving: "bg-blue-500/10 text-blue-600", downloading: "bg-blue-500/10 text-blue-600",
  paused: "bg-amber-500/10 text-amber-600", verifying: "bg-violet-500/10 text-violet-600", installing: "bg-violet-500/10 text-violet-600",
  ready: "bg-emerald-500/10 text-emerald-600", failed: "bg-destructive/10 text-destructive", cancelled: "bg-muted text-muted-foreground",
};

function ProgressBar({ value }: { value: number }) {
  return <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

export default function DownloadCenter() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [controls, setControls] = useState<DownloadControls>({ concurrency: 2, bandwidthMbps: 0 });
  const [forecasts, setForecasts] = useState<Record<string, DiskForecast>>({});
  const [recovery, setRecovery] = useState<{ recoveredJobs: number; recoveredAt: string | null }>({ recoveredJobs: 0, recoveredAt: null });
  const hasApi = typeof window !== "undefined" && !!window.api?.downloads;

  useEffect(() => {
    if (!hasApi) return;
    window.api.downloads.list().then(setJobs);
    window.api.downloads.getControls().then(setControls);
    window.api.downloads.recoveryStatus().then(setRecovery);
    return window.api.downloads.onUpdate(setJobs);
  }, [hasApi]);
  useEffect(() => {
    if (!hasApi) return;
    Promise.all(jobs.filter((job) => job.state !== "ready").map(async (job) => [job.id, await window.api.downloads.forecast(job.id)] as const))
      .then((items) => setForecasts(Object.fromEntries(items))).catch(() => undefined);
  }, [hasApi, jobs]);

  const totals = useMemo(() => jobs.reduce((result, job) => {
    result.received += job.shards.reduce((sum, shard) => sum + shard.receivedBytes, 0);
    result.total += job.shards.reduce((sum, shard) => sum + shard.expectedBytes, 0);
    return result;
  }, { received: 0, total: 0 }), [jobs]);
  const overallPercent = totals.total ? totals.received / totals.total * 100 : 0;
  const action = async (name: "pause" | "resume" | "retry" | "cancel" | "delete", id: string) => {
    if (name === "delete" && !window.confirm("Delete this download record and its partial files? Completed model files are kept.")) return;
    await window.api.downloads[name](id);
  };

  return <main className="min-h-full bg-background p-5 md:p-8">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back"><ArrowLeft className="size-4" /></Button>
          <span className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Download className="size-5" /></span>
          <div><h1 className="text-2xl font-semibold tracking-tight">Download Center</h1><p className="text-sm text-muted-foreground">Persistent model transfers, verification, and recovery</p></div>
        </div>
        {recovery.recoveredAt && <div className="rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground"><RefreshCw className="mr-1.5 inline size-3.5" />Startup recovery: {recovery.recoveredJobs} job{recovery.recoveredJobs === 1 ? "" : "s"}</div>}
      </header>

      <section className="grid gap-4 rounded-2xl border bg-card p-5 shadow-sm md:grid-cols-[1fr_auto]">
        <div className="space-y-2"><div className="flex justify-between text-sm"><span className="font-medium">Overall progress</span><span>{bytes(totals.received)} / {bytes(totals.total)} · {overallPercent.toFixed(1)}%</span></div><ProgressBar value={overallPercent} /></div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted-foreground">Concurrent jobs<Input className="mt-1 h-9 w-24" type="number" min={1} max={8} value={controls.concurrency} onChange={(event) => setControls({ ...controls, concurrency: Number(event.target.value) })} /></label>
          <label className="text-xs text-muted-foreground">Bandwidth Mbps (0 = unlimited)<Input className="mt-1 h-9 w-44" type="number" min={0} step={1} value={controls.bandwidthMbps} onChange={(event) => setControls({ ...controls, bandwidthMbps: Number(event.target.value) })} /></label>
          <Button onClick={async () => setControls(await window.api.downloads.setControls(controls))}><Gauge className="mr-2 size-4" />Apply</Button>
        </div>
      </section>

      {jobs.length === 0 ? <section className="rounded-2xl border border-dashed p-12 text-center text-muted-foreground"><Download className="mx-auto mb-3 size-8 opacity-50" /><p className="font-medium">No downloads yet</p><p className="mt-1 text-sm">Model downloads started from Settings will appear here and survive restarts.</p></section> :
        <div className="space-y-4">{jobs.map((job) => {
          const received = job.shards.reduce((sum, shard) => sum + shard.receivedBytes, 0);
          const total = job.shards.reduce((sum, shard) => sum + shard.expectedBytes, 0);
          const percent = total ? received / total * 100 : 0; const forecast = forecasts[job.id];
          return <article key={job.id} className="rounded-2xl border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{job.modelName}</h2><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateTone[job.state]}`}>{stateLabel(job)}</span>{job.recoveredAtStartup && <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600">Recovered</span>}</div><p className="mt-1 text-xs text-muted-foreground">{job.publisher} · {job.backend}{job.quantization ? ` · ${job.quantization}` : ""}</p></div>
              <div className="flex gap-1">
                {["queued", "resolving", "downloading"].includes(job.state) && <Button variant="outline" size="sm" onClick={() => action("pause", job.id)}><Pause className="mr-1.5 size-3.5" />Pause</Button>}
                {job.state === "paused" && <Button variant="outline" size="sm" onClick={() => action("resume", job.id)}><Play className="mr-1.5 size-3.5" />Resume</Button>}
                {job.state === "failed" && <Button variant="outline" size="sm" onClick={() => action("retry", job.id)}><RotateCcw className="mr-1.5 size-3.5" />Retry</Button>}
                {!["ready", "cancelled"].includes(job.state) && <Button variant="ghost" size="sm" onClick={() => action("cancel", job.id)}><X className="mr-1.5 size-3.5" />Cancel</Button>}
                <Button variant="ghost" size="icon" onClick={() => action("delete", job.id)} aria-label="Delete"><Trash2 className="size-4" /></Button>
              </div>
            </div>
            <div className="mt-4 space-y-2"><ProgressBar value={percent} /><div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-4"><span>{bytes(received)} / {bytes(total)} ({percent.toFixed(1)}%)</span><span>Speed: {job.bytesPerSecond ? `${bytes(job.bytesPerSecond)}/s` : "—"}</span><span>ETA: {duration(job.etaSeconds)}</span><span className={forecast?.enough === false ? "text-destructive" : ""}><HardDrive className="mr-1 inline size-3.5" />{forecast?.availableBytes == null ? "Disk unknown" : `${bytes(forecast.availableBytes)} free`}</span></div></div>
            {job.error && <p className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{job.error.message}</p>}
            <details className="mt-4"><summary className="cursor-pointer text-sm font-medium">Shards ({job.shards.length})</summary><div className="mt-3 space-y-3">{job.shards.map((shard) => { const shardPercent = shard.expectedBytes ? shard.receivedBytes / shard.expectedBytes * 100 : 0; return <div key={shard.filename} className="rounded-xl border bg-background/50 p-3"><div className="mb-2 flex justify-between gap-3 text-xs"><span className="truncate font-medium">{shard.filename}</span><span className="shrink-0 text-muted-foreground">{shard.state === "verifying" ? "Verifying" : shard.state === "ready" ? <><CheckCircle2 className="mr-1 inline size-3 text-emerald-600" />Verified</> : shard.receivedBytes > 0 ? ".part" : shard.state} · {bytes(shard.receivedBytes)} / {bytes(shard.expectedBytes)}</span></div><ProgressBar value={shardPercent} /></div>; })}</div></details>
          </article>;
        })}</div>}
    </div>
  </main>;
}
