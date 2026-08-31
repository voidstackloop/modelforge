import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowLeft, Check, Clipboard, Clock, Cpu, Download, ExternalLink, FileText, Gauge, HardDrive, MemoryStick, Play, RefreshCw, RotateCw, Search, Server, Square, Terminal, Thermometer, Trash2, TriangleAlert, Wrench, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/toast";
import { parseGpuSelectionErrorMessage } from "@/lib/gpu";
import type { GgufAssessment, GpuInfo, GpuSelection, GpuTelemetrySample, LocalGgufModel, LocalRuntimeStatus, PythonEnvironmentProgress, PythonEnvironmentStatus, ResourceTelemetry, RuntimeStartupConfig } from "@/types/electron";

// A GPU-selection error crossing the main->renderer IPC boundary arrives as
// a tagged, JSON-encoded message (see gpu-selection.ts's toIpcMessage() —
// Electron's IPC only carries a plain `.message` string, dropping custom
// error properties otherwise) — decode it back into readable text with its
// recovery action, rather than showing the raw tagged payload to the user.
function describeGpuAwareError(message: string): string {
  const parsed = parseGpuSelectionErrorMessage(message);
  return parsed ? `${parsed.message} ${parsed.recoveryAction}` : message;
}

type Backend = LocalRuntimeStatus["backend"];
type RuntimeDescriptor = {
  id: Backend; name: string; purpose: string; modelHint: string; format: string; supports: { context: boolean; gpuLayers: boolean; threads: boolean; flashAttention: boolean; gpuMemory: boolean; tensorParallel: boolean; gpuSelection: boolean };
};

const RUNTIMES: Record<Backend, RuntimeDescriptor> = {
  rocm: { id: "rocm", name: "ROCm llama-server", purpose: "Local GGUF inference on AMD GPUs", modelHint: "Choose an installed GGUF model", format: "GGUF", supports: { context: true, gpuLayers: false, threads: true, flashAttention: false, gpuMemory: false, tensorParallel: false, gpuSelection: true } },
  mlx: { id: "mlx", name: "MLX", purpose: "Apple Silicon optimized MLX models", modelHint: "publisher/model", format: "MLX", supports: { context: false, gpuLayers: false, threads: false, flashAttention: false, gpuMemory: false, tensorParallel: false, gpuSelection: false } },
  vllm: { id: "vllm", name: "vLLM", purpose: "High-throughput OpenAI-compatible serving", modelHint: "publisher/model", format: "Safetensors", supports: { context: true, gpuLayers: false, threads: false, flashAttention: false, gpuMemory: false, tensorParallel: false, gpuSelection: true } },
};

// Devices a runtime can actually target — vLLM/ROCm llama-server accept
// NVIDIA or AMD; MLX has no device-selection surface (unified memory,
// Apple's own scheduling), so it's never offered a selection control at all.
function selectableGpus(gpus: GpuInfo[], backend: Backend): GpuInfo[] {
  return gpus.filter((gpu) => {
    if (gpu.computeAvailable === false || gpu.displayOnly) return false;
    if (backend === "rocm") return gpu.vendor === "amd" && gpu.capabilities?.rocm === true;
    if (backend === "vllm") {
      return (gpu.vendor === "nvidia" && gpu.capabilities?.cuda === true)
        || (gpu.vendor === "amd" && gpu.capabilities?.rocm === true);
    }
    return false;
  });
}

const tone: Record<string, string> = {
  running: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", starting: "bg-blue-500/10 text-blue-700 dark:text-blue-400", restarting: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  stopping: "bg-amber-500/10 text-amber-700 dark:text-amber-400", unhealthy: "bg-destructive/10 text-destructive", failed: "bg-destructive/10 text-destructive",
  stopped: "bg-muted text-muted-foreground", missing: "bg-amber-500/10 text-amber-700 dark:text-amber-400", incompatible: "bg-muted text-muted-foreground",
  healthy: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", drifted: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

function memory(value: number | null | undefined): string { return value == null ? "—" : value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(0)} MB`; }
function bytes(value: number): string { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(0)} MB`; }
function uptime(seconds: number): string { const h = Math.floor(seconds / 3600); const m = Math.floor(seconds % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m`; }
function displayState(status: LocalRuntimeStatus): string { return !status.compatible ? "incompatible" : !status.installed ? "missing" : status.state; }
function fmtTime(value: string | null): string { return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"; }

export default function RuntimeManager() {
  const navigate = useNavigate(); const { locale } = useI18n(); const toast = useToast(); const tr = locale === "tr";
  const [tab, setTab] = useState("overview"); const [statuses, setStatuses] = useState<LocalRuntimeStatus[]>([]); const [environments, setEnvironments] = useState<PythonEnvironmentStatus[]>([]);
  const [accelerator, setAccelerator] = useState("—");
  const [tensorParallelAvailable, setTensorParallelAvailable] = useState(false);
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [gpuTelemetry, setGpuTelemetry] = useState<GpuTelemetrySample[]>([]);
  const [resourceTelemetry, setResourceTelemetry] = useState<ResourceTelemetry | null>(null);
  const [resourceSettings, setResourceSettings] = useState<{ mode: "balanced" | "performance" | "efficient" | "manual"; maxRamMB?: number; maxVramMB?: number; cpuThreadCeiling?: number }>({ mode: "balanced" });
  const [resourceSettingsSaving, setResourceSettingsSaving] = useState(false);
  const [fleetFingerprint, setFleetFingerprint] = useState<string | null>(null);
  const [fleetStatus, setFleetStatus] = useState<{ enabled: boolean; nodeId: string | null; running: boolean } | null>(null);
  const [fleetSaving, setFleetSaving] = useState(false);
  const [modelAssessments, setModelAssessments] = useState<GgufAssessment[]>([]);
  const [loadedModelPaths, setLoadedModelPaths] = useState<Set<string>>(new Set());
  const [modelAssessmentsLoading, setModelAssessmentsLoading] = useState(false);
  const [hardwareRefreshing, setHardwareRefreshing] = useState(false);
  const [models, setModels] = useState<Record<Backend, string>>({ rocm: "", mlx: "", vllm: "" }); const [ggufModels, setGgufModels] = useState<LocalGgufModel[]>([]);
  const [recentModels, setRecentModels] = useState<Record<"mlx" | "vllm", string[]>>({ mlx: [], vllm: [] });
  const [configs, setConfigs] = useState<Record<Backend, RuntimeStartupConfig>>({ rocm: { contextLength: null, idleTimeoutMinutes: 10, device: "auto", gpuLayerMode: "auto", flashAttention: "auto", vramReserveGB: 1 }, mlx: { idleTimeoutMinutes: 10, device: "auto" }, vllm: { contextLength: null, idleTimeoutMinutes: 10, device: "auto", gpuMemoryUtilization: 0.85, tensorParallelSize: 1 } });
  const [operations, setOperations] = useState<Partial<Record<Backend, string>>>({}); const [errors, setErrors] = useState<Partial<Record<Backend, string>>>({});
  const [environmentLoading, setEnvironmentLoading] = useState(false); const [confirmation, setConfirmation] = useState<{ kind: "force-stop" | "environment" | "clear-logs"; backend?: Backend; environment?: PythonEnvironmentStatus } | null>(null);
  const [environmentOperation, setEnvironmentOperation] = useState<{ family: PythonEnvironmentStatus["family"]; requestId: string; progress: PythonEnvironmentProgress[]; running: boolean; error?: string } | null>(null);
  const [logBackend, setLogBackend] = useState<Backend>("rocm"); const [logSearch, setLogSearch] = useState(""); const [logSource, setLogSource] = useState("all"); const [follow, setFollow] = useState(true);
  const statusInFlight = useRef(false); const logEnd = useRef<HTMLDivElement>(null); const hasApi = typeof window !== "undefined" && !!window.api?.localBackends;
  const completedDownloadSignature = useRef("");

  const refreshStatuses = useCallback(async () => {
    if (!hasApi || statusInFlight.current || document.visibilityState !== "visible") return;
    statusInFlight.current = true;
    try {
      const next = await window.api.localBackends.getStatuses(); setStatuses(next);
      setModels((current) => ({ ...current, ...Object.fromEntries(next.filter((item) => item.model).map((item) => [item.backend, current[item.backend] || item.model])) }));
      const failed = next.find((item) => item.startupError && item.state !== "running"); if (failed && operations[failed.backend]) { setLogBackend(failed.backend); setTab("logs"); }
    } catch (reason) { toast.error((reason as Error).message); } finally { statusInFlight.current = false; }
  }, [hasApi, operations, toast]);
  const refreshEnvironments = useCallback(async () => { if (!hasApi) return; setEnvironmentLoading(true); try { setEnvironments(await window.api.pythonRuntimes.getStatuses()); } catch (reason) { toast.error((reason as Error).message); } finally { setEnvironmentLoading(false); } }, [hasApi, toast]);
  const refreshModels = useCallback(async () => { if (!hasApi) return; const [gguf, settings, specs] = await Promise.all([window.api.llamacpp.listModels(), window.api.settings.get(), window.api.system.getSpecs()]); setGgufModels(gguf); setRecentModels({ mlx: settings.mlxModels ?? [], vllm: settings.vllmModels ?? [] }); setAccelerator(specs.gpus.map((gpu) => gpu.name).join(", ") || (tr ? "Yalnızca CPU" : "CPU only")); setTensorParallelAvailable(specs.tensorParallelSupported && specs.gpus.length > 1); setGpus(specs.gpus); setResourceSettings({ mode: settings.resourceBudgetMode ?? "balanced", maxRamMB: settings.resourceMaxRamMB, maxVramMB: settings.resourceMaxVramMB, cpuThreadCeiling: settings.resourceCpuThreadCeiling }); }, [hasApi, tr]);
  const saveResourceSettings = useCallback(async (next: typeof resourceSettings) => {
    if (!hasApi) return;
    setResourceSettingsSaving(true);
    try {
      await window.api.settings.save({ resourceBudgetMode: next.mode, resourceMaxRamMB: next.maxRamMB, resourceMaxVramMB: next.maxVramMB, resourceCpuThreadCeiling: next.cpuThreadCeiling });
      setResourceSettings(next);
      toast.success(tr ? "Kaynak ayarları kaydedildi." : "Resource settings saved.");
    } catch (reason) {
      toast.error((reason as Error).message);
    } finally {
      setResourceSettingsSaving(false);
    }
  }, [hasApi, tr, toast]);
  const refreshFleet = useCallback(async () => {
    if (!hasApi || !window.api.computeAgent) return;
    try {
      const [identity, status] = await Promise.all([window.api.computeAgent.getIdentity(), window.api.computeAgent.getStatus()]);
      setFleetFingerprint(identity.fingerprint256);
      setFleetStatus(status);
    } catch { /* fleet enrollment is opt-in and best-effort to surface */ }
  }, [hasApi]);
  const saveFleetSettings = useCallback(async (next: { enabled: boolean; nodeId: string }) => {
    if (!hasApi) return;
    setFleetSaving(true);
    try {
      await window.api.settings.save({ computeAgentEnabled: next.enabled, computeNodeId: next.nodeId.trim() || undefined });
      await refreshFleet();
      toast.success(tr ? "Filo ayarları kaydedildi." : "Fleet settings saved.");
    } catch (reason) {
      toast.error((reason as Error).message);
    } finally {
      setFleetSaving(false);
    }
  }, [hasApi, refreshFleet, tr, toast]);
  const refreshGpuTelemetry = useCallback(async () => { if (!hasApi || !window.api.gpu) return; try { setGpuTelemetry(await window.api.gpu.getTelemetry()); } catch { /* telemetry is best-effort */ } }, [hasApi]);
  const refreshResourceTelemetry = useCallback(async () => { if (!hasApi || !window.api.resource) return; try { setResourceTelemetry(await window.api.resource.getTelemetry()); } catch { /* telemetry is best-effort */ } }, [hasApi]);
  // Item 6/7's "Models" panel: per-installed-model compatibility, reusing
  // the same assessGgufFiles() math that already gates admission
  // server-side (model-fit-estimator.ts) — this view is read-only
  // observation of that same estimate, not a second implementation of it.
  const refreshModelAssessments = useCallback(async () => {
    if (!hasApi || !window.api.system.assessGgufFiles) return;
    setModelAssessmentsLoading(true);
    try {
      const [assessments, activity] = await Promise.all([
        window.api.system.assessGgufFiles(ggufModels.map((model) => ({ modelId: model.path, filename: model.label, sizeBytes: model.sizeBytes }))),
        window.api.system.getActivity(),
      ]);
      setModelAssessments(assessments);
      setLoadedModelPaths(new Set(activity.llamacppLoadedModels));
    } catch (reason) {
      toast.error((reason as Error).message);
    } finally {
      setModelAssessmentsLoading(false);
    }
  }, [hasApi, ggufModels, toast]);
  const refreshGpuTopology = useCallback(async () => {
    if (!hasApi || !window.api.gpu) return;
    setHardwareRefreshing(true);
    try {
      const specs = await window.api.gpu.refreshTopology();
      setAccelerator(specs.gpus.map((gpu) => gpu.name).join(", ") || (tr ? "Yalnızca CPU" : "CPU only"));
      setTensorParallelAvailable(specs.tensorParallelSupported && specs.gpus.length > 1);
      setGpus(specs.gpus);
      await refreshGpuTelemetry();
    } catch (reason) {
      toast.error((reason as Error).message);
    } finally {
      setHardwareRefreshing(false);
    }
  }, [hasApi, refreshGpuTelemetry, toast, tr]);

  useEffect(() => { const timer = window.setTimeout(() => { void refreshStatuses(); void refreshEnvironments(); void refreshModels(); void refreshGpuTelemetry(); void refreshFleet(); }, 0); return () => clearTimeout(timer); }, [refreshStatuses, refreshEnvironments, refreshModels, refreshGpuTelemetry, refreshFleet]);
  useEffect(() => { const timer = window.setInterval(() => void refreshStatuses(), 5_000); const visible = () => { if (document.visibilityState === "visible") void refreshStatuses(); }; document.addEventListener("visibilitychange", visible); return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); }; }, [refreshStatuses]);
  // The main process already caches/dedupes/pauses the underlying nvidia-smi
  // / rocm-smi probes (gpu-telemetry.ts) — this just re-reads that shared
  // cache on a UI-friendly cadence, it never spawns a probe itself.
  useEffect(() => {
    let timer: number | undefined;
    const syncPolling = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      void refreshGpuTelemetry();
      timer = window.setInterval(() => void refreshGpuTelemetry(), 3_000);
    };
    syncPolling();
    document.addEventListener("visibilitychange", syncPolling);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncPolling);
    };
  }, [refreshGpuTelemetry]);
  // Same UI-friendly-cadence-over-a-cheap-cache convention as GPU telemetry
  // above — resource-orchestrator.ts's getTelemetry() is a synchronous,
  // already-computed read, not a fresh probe, so 3s polling costs nothing.
  useEffect(() => {
    let timer: number | undefined;
    const syncPolling = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      void refreshResourceTelemetry();
      timer = window.setInterval(() => void refreshResourceTelemetry(), 3_000);
    };
    syncPolling();
    document.addEventListener("visibilitychange", syncPolling);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncPolling);
    };
  }, [refreshResourceTelemetry]);
  // Lazy: only assessed when the Models tab is actually opened, and
  // re-assessed whenever the installed-model list changes while it's open.
  useEffect(() => { if (tab === "models") void refreshModelAssessments(); }, [tab, refreshModelAssessments]);
  useEffect(() => { if (!hasApi) return; return window.api.downloads.onUpdate((jobs) => { const signature = jobs.filter((job) => job.state === "ready").map((job) => `${job.id}:${job.updatedAt}`).sort().join("|"); if (signature !== completedDownloadSignature.current) { completedDownloadSignature.current = signature; void refreshModels(); } }); }, [hasApi, refreshModels]);
  const visibleLogs = useMemo(() => (statuses.find((item) => item.backend === logBackend)?.logs ?? []).filter((line) => (logSource === "all" || line.includes(`[${logSource}]`)) && line.toLowerCase().includes(logSearch.toLowerCase())), [statuses, logBackend, logSearch, logSource]);
  useEffect(() => { if (follow) logEnd.current?.scrollIntoView({ block: "end" }); }, [visibleLogs, follow]);

  async function operate(backend: Backend, action: "start" | "stop" | "restart") {
    if (operations[backend]) return; setOperations((value) => ({ ...value, [backend]: action })); setErrors((value) => ({ ...value, [backend]: "" }));
    try {
      if (action === "stop") { const result = await window.api.localBackends.stop(backend); if (!result.stopped) { setConfirmation({ kind: "force-stop", backend }); return; } }
      else { const model = models[backend].trim(); if (!model) throw new Error(tr ? "Önce bir model seçin." : "Choose a model first."); await window.api.localBackends[action](backend, model, configs[backend]); }
      toast.success(tr ? "Çalışma zamanı güncellendi." : "Runtime updated.");
    } catch (reason) { const message = describeGpuAwareError((reason as Error).message); setErrors((value) => ({ ...value, [backend]: message })); toast.error(message); setLogBackend(backend); setTab("logs"); }
    finally { setOperations((value) => ({ ...value, [backend]: undefined })); await refreshStatuses(); }
  }

  async function confirmAction() {
    const pending = confirmation; setConfirmation(null); if (!pending) return;
    try {
      if (pending.kind === "force-stop" && pending.backend) { setOperations((value) => ({ ...value, [pending.backend!]: "force-stop" })); await window.api.localBackends.stop(pending.backend, true); toast.success(tr ? "Çalışma zamanı zorla durduruldu." : "Runtime force-stopped."); }
      if (pending.kind === "environment" && pending.environment) {
        const operation = pending.environment.state === "drifted" ? "repair" : "install";
        const progress: PythonEnvironmentProgress[] = []; const handle = window.api.pythonRuntimes.execute(pending.environment.family, operation, (event) => { progress.push(event); setEnvironmentOperation((current) => current ? { ...current, progress: [...progress].slice(-300) } : current); });
        setEnvironmentOperation({ family: pending.environment.family, requestId: handle.requestId, progress: [], running: true });
        void handle.promise.then(async (status) => { setEnvironments((items) => items.map((item) => item.family === status.family ? status : item)); setEnvironmentOperation((current) => current ? { ...current, running: false } : current); toast.success(tr ? "Ortam kurulumu tamamlandı ve yeniden denetlendi." : "Environment operation completed and was reinspected."); }).catch((reason: Error) => { setEnvironmentOperation((current) => current ? { ...current, running: false, error: reason.message } : current); toast.error(reason.message); });
      }
      if (pending.kind === "clear-logs" && pending.backend) { await window.api.localBackends.clearLogs(pending.backend); await refreshStatuses(); toast.success(tr ? "Yakalanan günlükler temizlendi." : "Captured logs cleared."); }
    } catch (reason) { toast.error((reason as Error).message); } finally { if (pending.backend) setOperations((value) => ({ ...value, [pending.backend!]: undefined })); await refreshStatuses(); }
  }

  const running = statuses.filter((item) => item.running); const unhealthy = statuses.filter((item) => item.state === "unhealthy" || item.state === "failed"); const repairCount = statuses.filter((item) => !item.installed || !item.compatible).length + environments.filter((item) => item.state !== "healthy" && item.state !== "incompatible").length;
  const activeRequests = statuses.reduce((sum, item) => sum + item.activeRequests, 0); const totalRam = statuses.reduce((sum, item) => sum + (item.ramMB ?? 0), 0); const totalVram = statuses.reduce((sum, item) => sum + (item.vramMB ?? 0), 0);

  return <main className="min-h-full bg-background p-4 md:p-6"><div className="mx-auto max-w-7xl space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label={tr ? "Geri" : "Back"}><ArrowLeft className="size-4" /></Button><div><h1 className="text-2xl font-semibold tracking-tight">{tr ? "Çalışma Zamanı Yöneticisi" : "Runtime Manager"}</h1><p className="text-sm text-muted-foreground">{tr ? "Yerel çıkarım süreçleri, ortamlar ve tanılama" : "Local inference processes, environments, and diagnostics"}</p></div></div><Button variant="outline" disabled={hardwareRefreshing} onClick={() => void Promise.all([refreshStatuses(), refreshEnvironments(), refreshModels(), refreshGpuTopology()])}><RefreshCw className={`mr-2 size-4 ${environmentLoading || hardwareRefreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />{tr ? "Yenile" : "Refresh"}</Button></header>
    <Tabs value={tab} onValueChange={(value) => setTab(String(value))}><TabsList variant="line" className="max-w-full overflow-x-auto"><TabsTrigger value="overview">{tr ? "Genel Bakış" : "Overview"}</TabsTrigger><TabsTrigger value="runtimes">{tr ? "Çalışma Zamanları" : "Runtimes"}</TabsTrigger><TabsTrigger value="workloads">{tr ? "İş yükleri" : "Workloads"}</TabsTrigger><TabsTrigger value="models">{tr ? "Modeller" : "Models"}</TabsTrigger><TabsTrigger value="environments">{tr ? "Ortamlar" : "Environments"}</TabsTrigger><TabsTrigger value="resource-settings">{tr ? "Kaynak ayarları" : "Resource settings"}</TabsTrigger><TabsTrigger value="fleet">{tr ? "Filo" : "Fleet"}</TabsTrigger><TabsTrigger value="logs">{tr ? "Günlükler ve tanılama" : "Logs & diagnostics"}</TabsTrigger></TabsList>
      <TabsContent value="overview" className="space-y-5 pt-4">
        <section className="grid overflow-hidden rounded-xl border bg-card sm:grid-cols-2 lg:grid-cols-4"><Metric label={tr ? "Çalışan" : "Running"} value={`${running.length} / ${statuses.length}`} detail={unhealthy.length ? `${unhealthy.length} ${tr ? "sağlıksız" : "unhealthy"}` : tr ? "Tümü sağlıklı" : "All healthy"} /><Metric label={tr ? "Etkin istekler" : "Active requests"} value={String(activeRequests)} detail={running.map((item) => item.model).filter(Boolean).join(", ") || "—"} /><Metric label="RAM / VRAM" value={`${memory(totalRam)} / ${memory(totalVram)}`} detail={accelerator} /><Metric label={tr ? "İşlem gerekli" : "Needs attention"} value={String(repairCount)} detail={`${tr ? "Son denetim" : "Last check"}: ${fmtTime(statuses.map((item) => item.lastHealthCheckAt).filter(Boolean).sort().at(-1) ?? null)}`} /></section>
        <section className="rounded-xl border bg-card"><div className="border-b px-4 py-3"><h2 className="font-medium">{tr ? "Çalışma zamanı özeti" : "Runtime summary"}</h2></div><div className="divide-y">{statuses.map((status) => <button key={status.backend} className="grid w-full gap-2 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[1.2fr_.8fr_1fr_auto] sm:items-center" onClick={() => { setTab("runtimes"); }}><span><span className="font-medium">{RUNTIMES[status.backend].name}</span><span className="block text-xs text-muted-foreground">{status.model || RUNTIMES[status.backend].purpose}</span></span><StatusBadge state={displayState(status)} /><span className="text-xs text-muted-foreground">{status.activeRequests} {tr ? "istek" : "requests"} · {memory(status.ramMB)} RAM</span><span className="text-xs text-muted-foreground">{fmtTime(status.lastHealthCheckAt)}</span></button>)}</div></section>
        {gpus.length > 0 && <GpuDevicesTable gpus={gpus} telemetry={gpuTelemetry} tr={tr} />}
      </TabsContent>
      <TabsContent value="runtimes" className="space-y-4 pt-4">{statuses.map((status) => <RuntimeCard key={status.backend} status={status} descriptor={RUNTIMES[status.backend]} model={models[status.backend]} setModel={(model) => setModels((value) => ({ ...value, [status.backend]: model }))} config={configs[status.backend]} setConfig={(config) => setConfigs((value) => ({ ...value, [status.backend]: config }))} ggufModels={ggufModels} recentModels={status.backend === "mlx" || status.backend === "vllm" ? recentModels[status.backend] : []} tensorParallelAvailable={tensorParallelAvailable} gpus={gpus} operation={operations[status.backend]} error={errors[status.backend]} tr={tr} onAction={operate} onLogs={() => { setLogBackend(status.backend); setTab("logs"); }} />)}</TabsContent>
      <TabsContent value="workloads" className="space-y-4 pt-4"><WorkloadsPanel telemetry={resourceTelemetry} tr={tr} /></TabsContent>
      <TabsContent value="models" className="space-y-4 pt-4"><ModelsPanel assessments={modelAssessments} loadedPaths={loadedModelPaths} loading={modelAssessmentsLoading} tr={tr} /></TabsContent>
      <TabsContent value="environments" className="space-y-3 pt-4"><div className="rounded-xl border bg-card"><div className="border-b px-4 py-3"><h2 className="font-medium">{tr ? "Yönetilen Python ortamları" : "Managed Python environments"}</h2><p className="text-xs text-muted-foreground">{tr ? "Hiçbir kurulum komutu açık onay olmadan çalıştırılmaz." : "No installation command runs without explicit approval."}</p></div><div className="divide-y">{environments.map((environment) => <EnvironmentRow key={environment.family} environment={environment} tr={tr} onPlan={() => setConfirmation({ kind: "environment", environment })} />)}</div></div></TabsContent>
      <TabsContent value="resource-settings" className="space-y-4 pt-4"><ResourceSettingsPanel settings={resourceSettings} saving={resourceSettingsSaving} onSave={(next) => void saveResourceSettings(next)} tr={tr} /></TabsContent>
      <TabsContent value="fleet" className="space-y-4 pt-4"><FleetAgentPanel fingerprint={fleetFingerprint} status={fleetStatus} saving={fleetSaving} onSave={(next) => void saveFleetSettings(next)} tr={tr} /></TabsContent>
      <TabsContent value="logs" className="space-y-3 pt-4"><section className="overflow-hidden rounded-xl border bg-card"><div className="flex flex-wrap items-center gap-2 border-b p-3"><label className="sr-only" htmlFor="runtime-log-selector">Runtime</label><select id="runtime-log-selector" className="h-8 rounded-lg border bg-background px-2 text-sm" value={logBackend} onChange={(event) => setLogBackend(event.target.value as Backend)}>{Object.values(RUNTIMES).map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.name}</option>)}</select><select aria-label={tr ? "Günlük kaynağı" : "Log source"} className="h-8 rounded-lg border bg-background px-2 text-sm" value={logSource} onChange={(event) => setLogSource(event.target.value)}><option value="all">{tr ? "Tüm kaynaklar" : "All sources"}</option><option value="manager">Manager</option><option value="stdout">stdout</option><option value="stderr">stderr</option></select><div className="relative min-w-48 flex-1"><Search className="absolute left-2.5 top-2 size-4 text-muted-foreground" /><Input className="h-8 pl-8" value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder={tr ? "Günlüklerde ara" : "Search logs"} /></div><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />{tr ? "Çıktıyı izle" : "Follow output"}</label><Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(visibleLogs.join("\n")); toast.success(tr ? "Günlükler kopyalandı." : "Logs copied."); }}><Clipboard className="mr-1.5 size-3.5" />{tr ? "Kopyala" : "Copy"}</Button><Button size="sm" variant="outline" onClick={() => window.api.localBackends.exportLogs(logBackend)}><Download className="mr-1.5 size-3.5" />{tr ? "Dışa aktar" : "Export"}</Button><Button size="sm" variant="ghost" onClick={() => setConfirmation({ kind: "clear-logs", backend: logBackend })}><Trash2 className="mr-1.5 size-3.5" />{tr ? "Temizle" : "Clear"}</Button></div><div className="h-[min(60vh,34rem)] overflow-auto bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-200" role="log" aria-live="polite">{visibleLogs.length ? visibleLogs.map((line, index) => <div key={`${index}-${line.slice(0, 30)}`} className={line.includes("[stderr]") ? "text-amber-300" : ""}>{line}</div>) : <div className="flex h-full items-center justify-center text-zinc-500">{tr ? "Bu filtre için günlük yok." : "No logs match this filter."}</div>}<div ref={logEnd} /></div></section></TabsContent>
    </Tabs>
    {!hasApi && <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">{tr ? "Çalışma zamanı yönetimi masaüstü uygulamasında kullanılabilir." : "Runtime management is available in the desktop application."}</div>}
    <Dialog open={!!confirmation} onOpenChange={(open) => { if (!open) setConfirmation(null); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{confirmation?.kind === "force-stop" ? (tr ? "Çalışma zamanını zorla durdur?" : "Force-stop runtime?") : confirmation?.kind === "clear-logs" ? (tr ? "Yakalanan günlükleri temizle?" : "Clear captured logs?") : (tr ? "Ortam planını onayla" : "Approve environment plan")}</DialogTitle><DialogDescription>{confirmation?.kind === "force-stop" ? `${statuses.find((item) => item.backend === confirmation.backend)?.activeRequests ?? 0} ${tr ? "etkin istek kesilecek. Bu işlem üretimi sonlandırabilir." : "active request(s) will be interrupted. This can terminate generation."}` : confirmation?.kind === "clear-logs" ? (tr ? "Yalnızca uygulamanın bellekte yakaladığı sınırlı günlükler temizlenir." : "Only the bounded logs captured in app memory will be cleared.") : (tr ? "Tam hedef, disk gereksinimi ve komut aşağıda gösterilir. Yalnızca onaydan sonra çalıştırılır." : "The exact destination, disk requirement, and command are shown below. It runs only after approval.")}</DialogDescription></DialogHeader>{confirmation?.environment && <div className="space-y-2 text-xs"><div className="grid grid-cols-2 gap-2 rounded-lg border p-3"><span className="text-muted-foreground">{tr ? "Hedef" : "Destination"}</span><span className="break-all text-right">{confirmation.environment.destination}</span><span className="text-muted-foreground">{tr ? "Disk" : "Disk"}</span><span className="text-right">{bytes(confirmation.environment.manifest.diskRequirementBytes)}</span></div><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-zinc-200">{confirmation.environment.state === "drifted" ? confirmation.environment.repairCommand : confirmation.environment.installCommand}</pre></div>}<DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>{tr ? "İptal" : "Cancel"}</Button><Button variant={confirmation?.kind === "force-stop" ? "destructive" : "default"} onClick={() => void confirmAction()}>{confirmation?.kind === "environment" ? (tr ? "Onayla ve çalıştır" : "Approve & run") : (tr ? "Onayla" : "Confirm")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!environmentOperation} onOpenChange={(open) => { if (!open && !environmentOperation?.running) setEnvironmentOperation(null); }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{environmentOperation?.family} · {tr ? "Ortam ilerlemesi" : "Environment progress"}</DialogTitle><DialogDescription>{environmentOperation?.running ? (tr ? "Paketler yapılandırılıyor. Güvenliyse işlemi iptal edebilirsiniz." : "Packages are being configured. You can cancel the operation when safe.") : environmentOperation?.error ? (tr ? "Ortam kısmen kurulmuş olabilir; yeniden denetleyip Onar'ı çalıştırın." : "The environment may be partial; reinspect it and run Repair.") : (tr ? "Ortam yeniden denetlendi." : "The environment was reinspected.")}</DialogDescription></DialogHeader><div className="h-64 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] text-zinc-200" role="log" aria-live="polite">{environmentOperation?.progress.map((entry, index) => <div key={`${index}-${entry.message.slice(0, 20)}`} className={entry.stream === "stderr" ? "text-amber-300" : ""}>[{entry.step}/{entry.totalSteps}] {entry.message}</div>)}{environmentOperation?.error && <div className="mt-2 text-red-300">{environmentOperation.error}</div>}</div><DialogFooter>{environmentOperation?.running ? <Button variant="destructive" onClick={() => window.api.pythonRuntimes.cancel(environmentOperation.requestId)}>{tr ? "İptal et" : "Cancel operation"}</Button> : <Button onClick={() => setEnvironmentOperation(null)}>{tr ? "Kapat" : "Close"}</Button>}</DialogFooter></DialogContent></Dialog>
  </div></main>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="min-w-0 border-b p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p><p className="mt-1 truncate text-xs text-muted-foreground" title={detail}>{detail}</p></div>; }
function StatusBadge({ state }: { state: string }) { return <span className={`inline-flex w-fit rounded-md px-2 py-0.5 text-xs font-medium ${tone[state] ?? tone.stopped}`}>{state.replace("-", " ")}</span>; }
function Detail({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) { return <div className="min-w-0"><dt className="flex items-center gap-1 text-[11px] text-muted-foreground">{icon}{label}</dt><dd className="mt-0.5 truncate text-sm" title={String(children)}>{children}</dd></div>; }

// Workload kinds are a fixed enum (resource-contracts.ts) — a plain lookup
// table for display labels, no dynamic string formatting to keep in sync.
const WORKLOAD_LABELS: Record<string, { en: string; tr: string }> = {
  "active-inference": { en: "Chat inference", tr: "Sohbet çıkarımı" },
  "scheduled-inference": { en: "Scheduled task", tr: "Zamanlanmış görev" },
  "model-load": { en: "Model load", tr: "Model yükleme" },
  "user-ocr": { en: "OCR", tr: "OCR" },
  "user-rag": { en: "Document search", tr: "Belge arama" },
  "user-media": { en: "Media processing", tr: "Medya işleme" },
  embedding: { en: "Embedding", tr: "Gömme" },
  indexing: { en: "Folder indexing", tr: "Klasör dizinleme" },
  download: { en: "Download", tr: "İndirme" },
  backup: { en: "Backup", tr: "Yedekleme" },
  maintenance: { en: "Maintenance", tr: "Bakım" },
  "python-worker": { en: "Python worker", tr: "Python işçisi" },
  "mcp-tool": { en: "MCP tool server", tr: "MCP araç sunucusu" },
};
function workloadLabel(kind: string, tr: boolean): string { return (tr ? WORKLOAD_LABELS[kind]?.tr : WORKLOAD_LABELS[kind]?.en) ?? kind; }

const PRIORITY_TONE: Record<string, string> = {
  "active-inference": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "user-interactive": "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "explicit-model-load": "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "scheduled-inference": "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  "background-compute": "bg-muted text-muted-foreground",
  transfer: "bg-muted text-muted-foreground",
  maintenance: "bg-muted text-muted-foreground",
};

function agoSeconds(sinceMs: number, nowMs: number): string { const s = Math.max(0, Math.round((nowMs - sinceMs) / 1000)); return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`; }

const PRESSURE_COPY: Record<string, { en: string; tr: string; tone: string }> = {
  normal: { en: "System memory is healthy — no background work is being throttled.", tr: "Sistem belleği sağlıklı — hiçbir arka plan işi kısıtlanmıyor.", tone: "bg-success/10 text-success" },
  warning: { en: "Sustained memory pressure — new background work (indexing, downloads, backups) is queued behind active chat until it clears.", tr: "Sürekli bellek baskısı — yeni arka plan işleri (dizinleme, indirme, yedekleme) etkin sohbetin arkasında bekletiliyor.", tone: "bg-warning/10 text-warning" },
  critical: { en: "Critical memory pressure — new background work is being rejected outright to protect active chat and models. Interactive use is never affected.", tr: "Kritik bellek baskısı — etkin sohbeti ve modelleri korumak için yeni arka plan işleri doğrudan reddediliyor. Etkileşimli kullanım hiçbir zaman etkilenmez.", tone: "bg-destructive/10 text-destructive" },
};

// Item 7/18: a read-only view of the resource orchestrator's own admission
// state — every heavyweight local operation (chat inference, RAG indexing,
// OCR, media processing, Python workers, MCP tool servers, backups) shows
// up here exactly as it was scheduled, nothing renderer-specific layered on
// top. There is intentionally no control here to cancel/reprioritize a
// lease directly — the renderer never gets to override admission, only
// observe it (see ipc/resource-handlers.ts's own doc comment).
function WorkloadsPanel({ telemetry, tr }: { telemetry: ResourceTelemetry | null; tr: boolean }) {
  if (!telemetry) return <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">{tr ? "İş yükü telemetrisi bekleniyor…" : "Waiting for workload telemetry…"}</div>;
  const now = telemetry.capturedAt;
  const pressure = PRESSURE_COPY[telemetry.pressure] ?? PRESSURE_COPY.normal;
  const capacity = telemetry.capacity;

  return <>
    <div className={`flex items-start gap-2 rounded-xl border p-3.5 text-xs ${pressure.tone}`}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{tr ? pressure.tr : pressure.en}</span>
    </div>
    <section className="grid overflow-hidden rounded-xl border bg-card sm:grid-cols-2 lg:grid-cols-4">
      <Metric label={tr ? "Etkin iş yükleri" : "Active workloads"} value={String(telemetry.activeLeases.length)} detail={telemetry.activeLeases.length ? telemetry.activeLeases.map((lease) => workloadLabel(lease.workloadKind, tr)).join(", ") : (tr ? "Boşta" : "Idle")} />
      <Metric label={tr ? "Kuyrukta" : "Queued"} value={String(telemetry.queuedRequests.length)} detail={telemetry.queuedRequests.length ? (tr ? "Sıra pozisyonuna göre sıralı" : "Ordered by queue position") : (tr ? "Bekleyen yok" : "Nothing waiting")} />
      <Metric label={tr ? "CPU iş parçacıkları" : "CPU threads"} value={capacity ? `${capacity.availableCpuThreads} / ${capacity.cpuThreads}` : "—"} detail={tr ? "kullanılabilir / toplam" : "available / total"} />
      <Metric label="RAM" value={capacity ? memory(capacity.availableRamMB) : "—"} detail={capacity ? `${tr ? "toplamın" : "of"} ${memory(capacity.totalRamMB)}` : "—"} />
    </section>
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3"><h2 className="font-medium">{tr ? "Etkin iş yükleri" : "Active workloads"}</h2></div>
      {telemetry.activeLeases.length === 0
        ? <p className="p-4 text-sm text-muted-foreground">{tr ? "Şu anda çalışan bir şey yok." : "Nothing is running right now."}</p>
        : <div className="divide-y">{telemetry.activeLeases.map((lease) => <div key={lease.leaseId} className="grid gap-2 px-4 py-3 sm:grid-cols-[1.3fr_.9fr_1fr_auto] sm:items-center">
          <span><span className="font-medium">{workloadLabel(lease.workloadKind, tr)}</span>{lease.decision === "granted-degraded" && <span className="ml-2 rounded-md bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">{tr ? "düşürülmüş" : "degraded"}</span>}<span className="block text-[11px] text-muted-foreground">{lease.reasons.join(" ") || (tr ? "Normal yürütme" : "Running normally")}</span></span>
          <span className={`inline-flex w-fit rounded-md px-2 py-0.5 text-xs font-medium ${PRIORITY_TONE[lease.priority] ?? "bg-muted text-muted-foreground"}`}>{lease.priority.replace(/-/g, " ")}</span>
          <span className="text-xs text-muted-foreground">{lease.budget.cpuThreads} {tr ? "iş parçacığı" : "threads"}{lease.budget.ramMB > 0 ? ` · ${memory(lease.budget.ramMB)}` : ""}{lease.budget.exclusiveAccelerator ? ` · ${tr ? "GPU (özel)" : "GPU (exclusive)"}` : ""}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="size-3" />{agoSeconds(lease.grantedAt, now)}</span>
        </div>)}</div>}
    </section>
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3"><h2 className="font-medium">{tr ? "Kuyruktaki istekler" : "Queued requests"}</h2></div>
      {telemetry.queuedRequests.length === 0
        ? <p className="p-4 text-sm text-muted-foreground">{tr ? "Bekleyen bir şey yok." : "Nothing is waiting."}</p>
        : <div className="divide-y">{telemetry.queuedRequests.map((request, index) => <div key={`${request.workloadKind}-${request.queuedAt}-${index}`} className="grid gap-2 px-4 py-2.5 sm:grid-cols-[auto_1.3fr_.9fr_auto] sm:items-center">
          <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
          <span>{workloadLabel(request.workloadKind, tr)}</span>
          <span className={`inline-flex w-fit rounded-md px-2 py-0.5 text-xs font-medium ${PRIORITY_TONE[request.priority] ?? "bg-muted text-muted-foreground"}`}>{request.priority.replace(/-/g, " ")}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="size-3" />{tr ? "beklemede" : "waiting"} {agoSeconds(request.queuedAt, now)}</span>
        </div>)}</div>}
    </section>
  </>;
}

const OUTCOME_TONE: Record<string, string> = {
  "Runs fully on GPU": "bg-success/10 text-success",
  "Runs with partial offload": "bg-warning/10 text-warning",
  "CPU-only but usable": "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "Requires tensor parallelism": "bg-muted text-muted-foreground",
  "Likely out of memory": "bg-destructive/10 text-destructive",
  "Unknown size": "bg-muted text-muted-foreground",
};
const OUTCOME_LABEL: Record<string, { en: string; tr: string }> = {
  "Runs fully on GPU": { en: "Comfortable", tr: "Rahat" },
  "Runs with partial offload": { en: "Degraded (partial offload)", tr: "Düşürülmüş (kısmi aktarım)" },
  "CPU-only but usable": { en: "CPU fallback", tr: "CPU'ya düşer" },
  "Requires tensor parallelism": { en: "Cannot run safely", tr: "Güvenle çalışmaz" },
  "Likely out of memory": { en: "Cannot run safely", tr: "Güvenle çalışmaz" },
  "Unknown size": { en: "Unknown", tr: "Bilinmiyor" },
};

// Item 6/7's "Models" panel: "Compatibility score for each installed
// model. Expected RAM/VRAM and speed. Recommended context/offload
// configuration. Loaded/unloaded state. 'Why can't this run?'
// explanation." Reuses assessGgufFiles() (system-specs.ts) — the exact
// same math model-fit-estimator.ts wraps for actual admission decisions —
// so this view can never disagree with what ingestion/loading will
// actually do.
function ModelsPanel({ assessments, loadedPaths, loading, tr }: { assessments: GgufAssessment[]; loadedPaths: Set<string>; loading: boolean; tr: boolean }) {
  if (loading && assessments.length === 0) return <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">{tr ? "Modeller değerlendiriliyor…" : "Assessing models…"}</div>;
  if (assessments.length === 0) return <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">{tr ? "Kurulu GGUF modeli yok." : "No installed GGUF models."}</div>;

  return <section className="overflow-hidden rounded-xl border bg-card">
    <div className="border-b px-4 py-3"><h2 className="font-medium">{tr ? "Model uyumluluğu" : "Model compatibility"}</h2><p className="mt-1 text-xs text-muted-foreground">{tr ? "Bu makine için, bu iş yükü yöneticisinin gerçek yükleme kararlarıyla aynı tahmin." : "The same estimate this workload manager's real load decisions use, for this machine."}</p></div>
    <div className="divide-y">
      {assessments.map((assessment) => {
        const loaded = loadedPaths.has(assessment.modelId);
        const tone = OUTCOME_TONE[assessment.outcome] ?? "bg-muted text-muted-foreground";
        const label = OUTCOME_LABEL[assessment.outcome] ?? { en: assessment.outcome, tr: assessment.outcome };
        return <div key={assessment.modelId} className="grid gap-2 px-4 py-3 sm:grid-cols-[1.3fr_auto_1fr_auto] sm:items-center">
          <span className="min-w-0"><span className="block truncate font-medium" title={assessment.filename}>{assessment.filename}</span><span className="block text-[11px] text-muted-foreground">{assessment.quantization}{assessment.estimatedParametersB != null ? ` · ~${assessment.estimatedParametersB}B` : ""}</span></span>
          <span className="flex flex-col items-start gap-1">
            <span className={`inline-flex w-fit rounded-md px-2 py-0.5 text-xs font-medium ${tone}`}>{tr ? label.tr : label.en}</span>
            {loaded && <span className="inline-flex w-fit rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{tr ? "yüklü" : "loaded"}</span>}
          </span>
          <span className="text-xs text-muted-foreground">{assessment.canAssess
            ? <>{assessment.totalRequiredGB?.toFixed(1)} GB {tr ? "toplam" : "total"} · {assessment.expectedGpuOffloadPercent}% {tr ? "GPU aktarımı" : "GPU offload"} · ~{assessment.estimatedTokensPerSecond} tok/s</>
            : (tr ? "Boyut bilinmiyor" : "Size unknown")}</span>
          <span className="max-w-64 text-[11px] text-muted-foreground" title={assessment.reason}>{assessment.reason}</span>
        </div>;
      })}
    </div>
  </section>;
}

type ResourceBudgetMode = "balanced" | "performance" | "efficient" | "manual";
type ResourceSettingsValue = { mode: ResourceBudgetMode; maxRamMB?: number; maxVramMB?: number; cpuThreadCeiling?: number };

const BUDGET_MODE_COPY: Record<ResourceBudgetMode, { en: string; tr: string; detailEn: string; detailTr: string }> = {
  balanced: { en: "Balanced", tr: "Dengeli", detailEn: "Recommended. Reserves headroom for the OS and other apps.", detailTr: "Önerilen. İşletim sistemi ve diğer uygulamalar için pay bırakır." },
  performance: { en: "Performance", tr: "Performans", detailEn: "Minimal reserve — most memory and CPU go to ModelForge.", detailTr: "Minimum pay — bellek ve CPU'nun çoğu ModelForge'a ayrılır." },
  efficient: { en: "Efficient", tr: "Verimli", detailEn: "Larger reserve — leaves more room for other work on this machine.", detailTr: "Daha büyük pay — bu makinedeki diğer işler için daha fazla yer bırakır." },
  manual: { en: "Manual", tr: "Manuel", detailEn: "Set explicit RAM/VRAM/CPU ceilings yourself.", detailTr: "RAM/VRAM/CPU üst sınırlarını kendiniz belirleyin." },
};

// Item 4/7: "Default to a Balanced mode" plus the Settings section's
// resource-mode control. Deliberately scoped to just the mode + manual
// ceilings — per-model overrides, preferred-GPU/backend defaults, and
// background-work limits (also listed under item 7's Settings section)
// live elsewhere in this page (GPU placement is per-runtime-card,
// preferredRuntime is in the app's own Settings page) rather than being
// duplicated here.
function ResourceSettingsPanel({ settings, saving, onSave, tr }: { settings: ResourceSettingsValue; saving: boolean; onSave(next: ResourceSettingsValue): void; tr: boolean }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  return <section className="max-w-2xl space-y-4 overflow-hidden rounded-xl border bg-card p-4">
    <div><h2 className="font-medium">{tr ? "Kaynak modu" : "Resource mode"}</h2><p className="mt-1 text-xs text-muted-foreground">{tr ? "Yerel çıkarım, dizinleme, OCR ve yedekleme gibi arka plan işleri arasında CPU/RAM nasıl paylaştırılır." : "How CPU/RAM is shared between local inference and background work like indexing, OCR, and backups."}</p></div>
    <div className="grid gap-2 sm:grid-cols-2">
      {(Object.keys(BUDGET_MODE_COPY) as ResourceBudgetMode[]).map((mode) => {
        const copy = BUDGET_MODE_COPY[mode];
        const selected = draft.mode === mode;
        return <button type="button" key={mode} aria-pressed={selected} onClick={() => setDraft({ ...draft, mode })} className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${selected ? "border-primary/40 bg-primary/8" : "bg-background hover:bg-muted/60"}`}>
          <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md ${selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{selected && <Check className="size-3.5" />}</span>
          <span className="min-w-0"><span className="block text-sm font-medium">{tr ? copy.tr : copy.en}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{tr ? copy.detailTr : copy.detailEn}</span></span>
        </button>;
      })}
    </div>
    {draft.mode === "manual" && <div className="grid gap-3 border-t pt-3 sm:grid-cols-3">
      <NumberSetting label={tr ? "Maks. RAM (MB, boş = sınırsız)" : "Max RAM (MB, blank = unlimited)"} value={draft.maxRamMB ?? ""} min={512} onChange={(value) => setDraft({ ...draft, maxRamMB: value === "" ? undefined : Number(value) })} />
      <NumberSetting label={tr ? "Maks. VRAM (MB, boş = sınırsız)" : "Max VRAM (MB, blank = unlimited)"} value={draft.maxVramMB ?? ""} min={256} onChange={(value) => setDraft({ ...draft, maxVramMB: value === "" ? undefined : Number(value) })} />
      <NumberSetting label={tr ? "CPU iş parçacığı üst sınırı (boş = sınırsız)" : "CPU thread ceiling (blank = unlimited)"} value={draft.cpuThreadCeiling ?? ""} min={1} onChange={(value) => setDraft({ ...draft, cpuThreadCeiling: value === "" ? undefined : Number(value) })} />
    </div>}
    <p className="text-[11px] text-muted-foreground">{tr ? "Bu, ModelForge'un kendi işleri arasındaki paylaşımı yönetir; işletim sisteminin veya diğer uygulamaların üst sınırı değildir." : "This governs sharing between ModelForge's own workloads; it is not an OS-level or other-application limit."}</p>
    <div className="flex justify-end gap-2 border-t pt-3">
      <Button variant="outline" disabled={!dirty || saving} onClick={() => setDraft(settings)}>{tr ? "Sıfırla" : "Reset"}</Button>
      <Button disabled={!dirty || saving} onClick={() => onSave(draft)}>{saving ? (tr ? "Kaydediliyor…" : "Saving…") : (tr ? "Kaydet" : "Save")}</Button>
    </div>
  </section>;
}

// Requires an already-connected shared backend (Audit & Privacy's own
// enrollment panel) — enabling this without one configured saves cleanly
// (compute-agent.ts's own runCycle() just no-ops each cycle until then)
// but never actually starts heartbeating, so the copy below says so up
// front rather than let a user wonder why nothing happens.
function FleetAgentPanel({ fingerprint, status, saving, onSave, tr }: { fingerprint: string | null; status: { enabled: boolean; nodeId: string | null; running: boolean } | null; saving: boolean; onSave(next: { enabled: boolean; nodeId: string }): void; tr: boolean }) {
  const [enabled, setEnabled] = useState(status?.enabled ?? false);
  const [nodeId, setNodeId] = useState(status?.nodeId ?? "");
  useEffect(() => { setEnabled(status?.enabled ?? false); setNodeId(status?.nodeId ?? ""); }, [status]);
  const dirty = enabled !== (status?.enabled ?? false) || nodeId !== (status?.nodeId ?? "");
  const [copied, setCopied] = useState(false);

  return <section className="max-w-2xl space-y-4 overflow-hidden rounded-xl border bg-card p-4">
    <div>
      <h2 className="font-medium">{tr ? "Kurumsal işlem filosu" : "Enterprise compute fleet"}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{tr ? "Bu cihazı, kurumun paylaşılan arka ucuna zaten bağlıysa (Denetim ve Gizlilik) bir işlem havuzuna kaydedin. Yalnızca havuzun taahhüt ettiği kapasiteyi korur — burada hiçbir iş çalıştırılmaz." : "Enroll this device into a compute pool, if it's already connected to your organization's shared backend (Audit & Privacy). This only protects the capacity the fleet has committed — no work is dispatched to run here yet."}</p>
    </div>
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{tr ? "Cihaz parmak izi" : "Device fingerprint"}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border bg-background px-3 py-2 font-mono text-[11px]">{fingerprint ?? "…"}</code>
        <Button variant="outline" size="sm" disabled={!fingerprint} onClick={() => { if (fingerprint) { void navigator.clipboard.writeText(fingerprint); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } }}>
          <Clipboard className="mr-1.5 size-3.5" />{copied ? (tr ? "Kopyalandı" : "Copied") : (tr ? "Kopyala" : "Copy")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{tr ? "Bu cihazı bir işlem havuzuna eklemesi için kuruluşunuzun işlem yöneticisine verin." : "Give this to your organization's compute admin to register this device to a pool."}</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {tr ? "Düğüm kimliği (yönetici tarafından verilir)" : "Node ID (given by your admin)"}
        <Input value={nodeId} onChange={(event) => setNodeId(event.target.value)} placeholder={tr ? "kayıttan sonra buraya yapıştırın" : "paste it here after registration"} />
      </label>
      <label className="flex items-end gap-2 pb-0.5 text-sm">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {tr ? "Filo aracısını etkinleştir" : "Enable fleet agent"}
      </label>
    </div>
    {status && <p className="text-[11px] text-muted-foreground">{status.running ? (tr ? "Aracı çalışıyor ve düzenli olarak nabız gönderiyor." : "The agent is running and heartbeating regularly.") : status.enabled ? (tr ? "Etkin ancak henüz çalışmıyor — bir düğüm kimliği gerekiyor olabilir." : "Enabled but not running yet — a node ID may still be needed.") : (tr ? "Şu anda devre dışı." : "Currently disabled.")}</p>}
    <div className="flex justify-end gap-2 border-t pt-3">
      <Button variant="outline" disabled={!dirty || saving} onClick={() => { setEnabled(status?.enabled ?? false); setNodeId(status?.nodeId ?? ""); }}>{tr ? "Sıfırla" : "Reset"}</Button>
      <Button disabled={!dirty || saving} onClick={() => onSave({ enabled, nodeId })}>{saving ? (tr ? "Kaydediliyor…" : "Saving…") : (tr ? "Kaydet" : "Save")}</Button>
    </div>
  </section>;
}

function RuntimeCard({ status, descriptor, model, setModel, config, setConfig, ggufModels, recentModels, tensorParallelAvailable, gpus, operation, error, tr, onAction, onLogs }: { status: LocalRuntimeStatus; descriptor: RuntimeDescriptor; model: string; setModel(value: string): void; config: RuntimeStartupConfig; setConfig(value: RuntimeStartupConfig): void; ggufModels: LocalGgufModel[]; recentModels: string[]; tensorParallelAvailable: boolean; gpus: GpuInfo[]; operation?: string; error?: string; tr: boolean; onAction(backend: Backend, action: "start" | "stop" | "restart"): void; onLogs(): void }) {
  const state = displayState(status); const busy = !!operation || !!status.operation; const primary = !status.compatible || status.startupError ? "error" : !status.installed ? "install" : status.state === "running" || status.state === "unhealthy" ? "stop" : "start";
  const candidates = selectableGpus(gpus, status.backend);
  return <article className="rounded-xl border bg-card"><div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{descriptor.name}</h2><StatusBadge state={state} />{status.activeRequests > 0 && <span className="rounded-md bg-blue-500/10 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">{status.activeRequests} {tr ? "etkin istek" : "active requests"}</span>}</div><p className="mt-1 text-xs text-muted-foreground">{descriptor.purpose}</p></div><div className="flex items-center gap-2">{busy && <span className="text-xs text-muted-foreground" role="status"><RefreshCw className="mr-1 inline size-3 animate-spin motion-reduce:animate-none" />{operation ?? status.operation}</span>}{primary === "stop" && <Button disabled={busy} onClick={() => onAction(status.backend, "stop")}><Square className="mr-2 size-4" />{tr ? "Durdur" : "Stop"}</Button>}{primary === "start" && <Button disabled={busy} onClick={() => onAction(status.backend, "start")}><Play className="mr-2 size-4" />{tr ? "Başlat" : "Start"}</Button>}{primary === "error" && <Button variant="destructive" onClick={onLogs}><TriangleAlert className="mr-2 size-4" />{tr ? "Hatayı görüntüle" : "View error"}</Button>}{primary === "install" && <Button variant="outline" onClick={() => void navigator.clipboard.writeText(status.installCommand)}><Wrench className="mr-2 size-4" />{tr ? "Kurulum planı" : "Install plan"}</Button>}</div></div>
    <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,.8fr)]"><div className="space-y-4"><div><label className="text-xs font-medium">{tr ? "Model" : "Model"} · {descriptor.format}</label>{status.backend === "rocm" ? <select className="mt-1.5 h-9 w-full rounded-lg border bg-background px-3 text-sm" value={model} disabled={status.running || busy} onChange={(event) => setModel(event.target.value)}><option value="">{tr ? "Kurulu GGUF modeli seçin" : "Select an installed GGUF model"}</option>{ggufModels.map((item) => <option key={item.path} value={item.path}>{item.label} · {bytes(item.sizeBytes)}</option>)}</select> : <><Input className="mt-1.5" list={`${status.backend}-recent-models`} value={model} disabled={status.running || busy} onChange={(event) => setModel(event.target.value)} placeholder={descriptor.modelHint} /><datalist id={`${status.backend}-recent-models`}>{recentModels.map((item) => <option key={item} value={item} />)}</datalist></>}<p className="mt-1 text-[11px] text-muted-foreground">{status.backend === "rocm" ? (tr ? "Yalnızca onaylı model klasöründeki dosyalar kabul edilir." : "Only files inside the approved models directory are accepted.") : (tr ? "Hugging Face kimliği publisher/model biçiminde doğrulanır." : "Hugging Face IDs are validated as publisher/model.")}</p></div>
      {descriptor.supports.gpuSelection && candidates.length > 0 && <GpuSelectionControl candidates={candidates} config={config} setConfig={setConfig} backend={status.backend} disabled={status.running || busy} tr={tr} />}
      {descriptor.supports.gpuSelection && candidates.length === 0 && <div className="flex gap-2 rounded-xl border border-warning/25 bg-warning/5 p-3 text-[11px] text-warning"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" /><span><span className="block font-medium">{tr ? "Uyumlu compute GPU'su yok" : "No compatible compute GPU"}</span><span className="mt-0.5 block opacity-90">{status.backend === "rocm" ? (tr ? "Bu çalışma zamanı doğrulanmış ROCm desteği olan bir AMD GPU gerektirir." : "This runtime requires an AMD GPU with verified ROCm support.") : (tr ? "vLLM doğrulanmış CUDA veya ROCm desteği gerektirir." : "vLLM requires verified CUDA or ROCm support.")}</span></span></div>}
      {status.backend === "rocm" && <GpuLayerModeSetting config={config} setConfig={setConfig} disabled={status.running || busy} tr={tr} />}
      {status.backend === "rocm" && <FlashAttentionSetting config={config} setConfig={setConfig} disabled={status.running || busy} />}
      {status.backend === "vllm" && <VllmGpuSettings config={config} setConfig={setConfig} disabled={status.running || busy} maxGpus={Math.max(1, config.gpuSelection?.deviceIds.length || candidates.length)} tensorParallelAvailable={tensorParallelAvailable} tr={tr} />}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {descriptor.supports.context && <NumberSetting label={tr ? "Bağlam uzunluğu (boş = Otomatik)" : "Context length (blank = Auto)"} value={config.contextLength ?? ""} min={256} onChange={(value) => setConfig({ ...config, contextLength: value === "" ? null : Number(value) })} />}
        {descriptor.supports.threads && <NumberSetting label={tr ? "CPU iş parçacıkları" : "CPU threads"} value={config.cpuThreads ?? ""} min={1} onChange={(value) => setConfig({ ...config, cpuThreads: value === "" ? undefined : Number(value) })} />}
        <NumberSetting label={tr ? "Boşta kapanma (dakika, 0 = kapalı)" : "Idle shutdown (minutes, 0 = off)"} value={config.idleTimeoutMinutes ?? 10} min={0} max={1440} onChange={(value) => setConfig({ ...config, idleTimeoutMinutes: Number(value) })} />
      </div>
      <p className="text-[11px] text-muted-foreground">{tr ? "Başlangıç seçeneklerindeki değişiklikler çalışan süreçte yeniden başlatma gerektirir." : "Changes to startup options require a restart of a running process."}</p>
    </div>
      <div className="space-y-4"><dl className="grid grid-cols-2 gap-3"><Detail icon={<Cpu className="size-3" />} label="PID">{status.pid ?? "—"}</Detail><Detail icon={<Server className="size-3" />} label="Port">{status.port ?? "—"}</Detail><Detail icon={<HardDrive className="size-3" />} label="RAM / VRAM">{memory(status.ramMB)} / {memory(status.vramMB)}</Detail><Detail icon={<Activity className="size-3" />} label={tr ? "Çalışma süresi" : "Uptime"}>{status.running ? uptime(status.uptimeSeconds) : "—"}</Detail><Detail icon={<Cpu className="size-3" />} label={tr ? "Aygıt" : "Device"}>{status.device ?? config.device ?? "auto"}</Detail><Detail icon={<Activity className="size-3" />} label={tr ? "Son sağlık denetimi" : "Last health check"}>{fmtTime(status.lastHealthCheckAt)}</Detail></dl>{status.activeRequests > 0 && <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-800 dark:text-blue-300">{tr ? `${status.activeRequests} etkin istek güvenli kapanmayı engelliyor. Normal Durdur bu istekleri kesmez.` : `${status.activeRequests} active request(s) block safe shutdown. Normal Stop will not interrupt them.`}</div>}{(error || status.startupError) && <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"><p>{error || status.startupError}</p>{status.recoveryAction && <p className="mt-2 font-medium">{status.recoveryAction}</p>}</div>}{status.running && <Button className="w-full" variant="outline" disabled={busy || status.activeRequests > 0} onClick={() => onAction(status.backend, "restart")}><RotateCw className="mr-2 size-4" />{tr ? "Yeniden başlat" : "Restart"}</Button>}<Button className="w-full" variant="ghost" onClick={onLogs}><Terminal className="mr-2 size-4" />{tr ? `Günlükleri görüntüle (${status.logs.length})` : `View logs (${status.logs.length})`}</Button></div></div></article>;
}

function NumberSetting({ label, value, min, max, step, disabled, onChange }: { label: string; value: string | number; min?: number; max?: number; step?: number; disabled?: boolean; onChange(value: string): void }) { return <label className="text-[11px] text-muted-foreground">{label}<Input className="mt-1 h-8" type="number" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>; }

function GpuLayerModeSetting({ config, setConfig, disabled, tr }: { config: RuntimeStartupConfig; setConfig(value: RuntimeStartupConfig): void; disabled: boolean; tr: boolean }) {
  const mode = config.gpuLayerMode ?? "auto";
  return <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"><label className="text-[11px] text-muted-foreground">{tr ? "GPU katman modu" : "GPU layer mode"}<select className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs" value={mode} disabled={disabled} onChange={(event) => setConfig({ ...config, gpuLayerMode: event.target.value as RuntimeStartupConfig["gpuLayerMode"], gpuLayers: event.target.value === "manual" ? config.gpuLayers ?? 1 : undefined })}><option value="auto">{tr ? "Otomatik (önerilen)" : "Automatic (recommended)"}</option><option value="cpu">{tr ? "Yalnızca CPU" : "CPU only"}</option><option value="max">{tr ? "Tüm GPU katmanları (başarısız olabilir)" : "All GPU layers (may fail)"}</option><option value="manual">{tr ? "Manuel katman sayısı" : "Manual layer count"}</option></select></label>{mode === "manual" && <NumberSetting label={tr ? "Katman sayısı" : "Layer count"} value={config.gpuLayers ?? 1} min={0} max={65535} onChange={(value) => setConfig({ ...config, gpuLayers: Number(value) })} />}<p className="text-[11px] text-muted-foreground sm:col-span-2">{tr ? "Otomatik mod, seçilen bağlam ve çalışma alanı için VRAM payı bırakarak güvenli yerleşimi hesaplar. Tüm katmanlar modu bu güvenlik payını atlar." : "Automatic calculates memory-safe placement for the selected context and scratch buffers. All-layers mode bypasses that safety margin."}</p></div>;
}

function FlashAttentionSetting({ config, setConfig, disabled }: { config: RuntimeStartupConfig; setConfig(value: RuntimeStartupConfig): void; disabled: boolean }) {
  return <label className="block rounded-lg border p-3 text-[11px] text-muted-foreground">Flash Attention<select className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs" value={String(config.flashAttention ?? "auto")} disabled={disabled} onChange={(event) => setConfig({ ...config, flashAttention: event.target.value === "auto" ? "auto" : event.target.value === "true" })}><option value="auto">Auto</option><option value="true">On</option><option value="false">Off</option></select></label>;
}

function VllmGpuSettings({ config, setConfig, disabled, maxGpus, tensorParallelAvailable, tr }: { config: RuntimeStartupConfig; setConfig(value: RuntimeStartupConfig): void; disabled: boolean; maxGpus: number; tensorParallelAvailable: boolean; tr: boolean }) {
  return <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 xl:grid-cols-4"><NumberSetting disabled={disabled} label={tr ? "GPU bellek kullanımı" : "GPU memory utilization"} value={config.gpuMemoryUtilization ?? 0.85} min={0.1} max={0.95} step={0.05} onChange={(value) => setConfig({ ...config, gpuMemoryUtilization: Number(value) })} />{tensorParallelAvailable && <NumberSetting disabled={disabled} label={tr ? "Tensor paralelliği" : "Tensor parallel size"} value={config.tensorParallelSize ?? 1} min={1} max={maxGpus} onChange={(value) => setConfig({ ...config, tensorParallelSize: Number(value) })} />}<NumberSetting disabled={disabled} label={tr ? "CPU aktarımı (GB)" : "CPU offload (GB)"} value={config.cpuOffloadGB ?? 0} min={0} max={1024} step={1} onChange={(value) => setConfig({ ...config, cpuOffloadGB: Number(value) })} /><NumberSetting disabled={disabled} label={tr ? "Takas alanı (GB)" : "Swap space (GB)"} value={config.swapSpaceGB ?? 0} min={0} max={1024} step={1} onChange={(value) => setConfig({ ...config, swapSpaceGB: Number(value) })} /><p className="text-[11px] text-muted-foreground sm:col-span-2 xl:col-span-4">{tr ? "Yalnızca kurulu vLLM sürümünün --help çıktısında doğrulanan seçenekler uygulanır." : "Only options verified in the installed vLLM version's --help output are applied."}</p></div>;
}

function gpuLabel(gpu: GpuInfo): string { return gpu.vramGB != null ? `${gpu.name} (${gpu.vramGB.toFixed(0)} GB)` : gpu.name; }

function estimatedUsableVram(gpu: GpuInfo, reserveGB: number): number | null {
  const reported = gpu.freeVramGB ?? gpu.vramGB;
  if (reported == null || reported <= 0) return null;
  const physical = gpu.vramGB ?? reported;
  return Math.max(0, reported - Math.max(reserveGB, physical * 0.08));
}

function gpuComputeBackend(gpu: GpuInfo): string {
  if (gpu.capabilities?.cuda) return "CUDA";
  if (gpu.capabilities?.rocm) return "ROCm";
  if (gpu.capabilities?.metal) return "Metal";
  if (gpu.capabilities?.vulkan) return "Vulkan";
  return "GPU";
}

// Per-runtime device selection: auto (default, no filtering — every
// compatible device stays visible to the runtime), a single GPU, an ordered
// group, or all of them. Selecting exactly one collapses the mode to
// "single"; two or more collapses to "group"; clearing the selection goes
// back to "auto" rather than leaving a stale single-item group behind.
function GpuSelectionControl({ candidates, config, setConfig, backend, disabled, tr }: { candidates: GpuInfo[]; config: RuntimeStartupConfig; setConfig(value: RuntimeStartupConfig): void; backend: Backend; disabled: boolean; tr: boolean }) {
  const selection = config.gpuSelection ?? { mode: "auto" as const, deviceIds: [] };
  const selectedIds = new Set(selection.deviceIds);
  const selectedGpus = candidates.filter((gpu) => gpu.id && selectedIds.has(gpu.id));
  const selectedVendor = selectedGpus[0]?.vendor;
  const reserveGB = config.vramReserveGB ?? 1;

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    const deviceIds = candidates.filter((gpu) => gpu.id && next.has(gpu.id)).map((gpu) => gpu.id!);
    const mode: GpuSelection["mode"] = deviceIds.length === 0 ? "auto" : deviceIds.length === 1 ? "single" : "group";
    const mainGpuId = mode === "group" ? (config.mainGpuId && deviceIds.includes(config.mainGpuId) ? config.mainGpuId : deviceIds[0]) : undefined;
    setConfig({ ...config, gpuSelection: { mode, deviceIds }, mainGpuId, ...(mode !== "group" ? { tensorSplit: undefined } : {}) });
  }

  function useAutomatic() {
    setConfig({ ...config, gpuSelection: { mode: "auto", deviceIds: [] }, tensorSplit: undefined, mainGpuId: undefined });
  }

  const showSplit = backend === "rocm" && selection.deviceIds.length > 1;
  const totalPhysical = selectedGpus.reduce((sum, gpu) => sum + (gpu.vramGB ?? 0), 0);
  const totalUsable = selectedGpus.reduce((sum, gpu) => sum + (estimatedUsableVram(gpu, reserveGB) ?? 0), 0);
  return <div className="space-y-3 rounded-xl border bg-muted/20 p-3.5">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-medium">{tr ? "GPU yerleşimi" : "GPU placement"}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{tr ? "Otomatik önerilir; manuel gruplar tek bir compute backend kullanmalıdır." : "Automatic is recommended; manual groups must use one compute backend."}</p></div><span className="rounded-full bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground">{backend === "rocm" ? "ROCm" : "vLLM"}</span></div>
    <button type="button" disabled={disabled} aria-pressed={selection.deviceIds.length === 0} onClick={useAutomatic} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${selection.deviceIds.length === 0 ? "border-primary/40 bg-primary/8" : "bg-background hover:bg-muted/60"}`}>
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${selection.deviceIds.length === 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}><Zap className="size-4" /></span>
      <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{tr ? "Otomatik · önerilen" : "Automatic · recommended"}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{tr ? "En uygun homojen GPU grubunu ve güvenli bellek payını seçer." : "Chooses the best homogeneous GPU cohort and preserves memory headroom."}</span></span>
      {selection.deviceIds.length === 0 && <Check className="size-4 shrink-0 text-primary" />}
    </button>
    <div className="grid gap-2 sm:grid-cols-2">
      {candidates.map((gpu) => {
        const selected = !!gpu.id && selectedIds.has(gpu.id);
        const vendorConflict = !!selectedVendor && gpu.vendor !== selectedVendor && !selected;
        const usable = estimatedUsableVram(gpu, reserveGB);
        return <button type="button" key={gpu.id ?? gpu.name} disabled={disabled || !gpu.id || vendorConflict} aria-pressed={selected} onClick={() => gpu.id && toggle(gpu.id)} className={`flex min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${selected ? "border-primary/40 bg-primary/8" : "bg-background hover:bg-muted/60"}`}>
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}><Cpu className="size-4" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium" title={gpuLabel(gpu)}>{gpu.name}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{gpuComputeBackend(gpu)} · {usable != null ? `~${usable.toFixed(1)} GB usable` : (tr ? "Bellek bilinmiyor" : "Memory unknown")}</span>{vendorConflict && <span className="mt-0.5 block text-[10px] text-warning">{tr ? "Farklı GPU backend'i" : "Different GPU backend"}</span>}</span>
          {selected && <Check className="size-4 shrink-0 text-primary" />}
        </button>;
      })}
    </div>
    {selectedGpus.length > 0 && <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-[10px] text-muted-foreground"><span className="font-medium text-foreground">{selectedGpus.length} {tr ? "GPU seçildi" : "GPU selected"}</span> · {totalPhysical.toFixed(1)} GB {tr ? "fiziksel" : "physical"} · ~{totalUsable.toFixed(1)} GB {tr ? "tahmini kullanılabilir" : "estimated usable"}. {selectedGpus.length > 1 && (tr ? "Bellek tek bir havuz değildir; çalışma zamanı modeli aygıtlar arasında böler." : "Memory is not one pool; the runtime splits the model across devices.")}</div>}
    {showSplit && <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
      <label className="text-[11px] text-muted-foreground">{tr ? "Bölme modu" : "Split mode"}
        <select className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-[11px]" value={config.splitMode ?? "layer"} disabled={disabled} onChange={(event) => setConfig({ ...config, splitMode: event.target.value as "layer" | "tensor" })}>
          <option value="layer">{tr ? "Katman" : "Layer"}</option>
          <option value="tensor">{tr ? "Tensor (Deneysel)" : "Tensor (Experimental)"}</option>
        </select>
      </label>
      <label className="text-[11px] text-muted-foreground">{tr ? "Birincil GPU" : "Primary GPU"}<select className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-[11px]" value={config.mainGpuId ?? selectedGpus[0]?.id ?? ""} disabled={disabled} onChange={(event) => setConfig({ ...config, mainGpuId: event.target.value })}>{selectedGpus.map((gpu) => <option key={gpu.id} value={gpu.id}>{gpu.name}</option>)}</select></label>
      <p className="text-[11px] text-muted-foreground sm:col-span-2">{tr ? "Katman bölme önerilir. Oranlar her GPU'nun boş VRAM'ından güvenlik payı düşülerek hesaplanır; Tensor modu deneysel ve benzer GPU'lar içindir." : "Layer split is recommended. Proportions use each GPU's free VRAM after a safety reserve; Tensor mode is experimental and intended for similar GPUs."}</p>
    </div>}
  </div>;
}

function telemetryFor(telemetry: GpuTelemetrySample[], gpu: GpuInfo): GpuTelemetrySample | undefined {
  return telemetry.find((sample) => sample.id === gpu.id);
}

function clampPercent(value: number | null | undefined): number {
  return value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value));
}

function GpuMeter({ value, tone = "primary" }: { value: number | null | undefined; tone?: "primary" | "warning" }) {
  const width = clampPercent(value);
  return <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className={`h-full rounded-full transition-[width] ${tone === "warning" ? "bg-warning" : "bg-primary"}`} style={{ width: `${width}%` }} /></div>;
}

// A dense hardware inventory with live meters. Physical VRAM remains
// per-device; even in the multi-GPU summary we never present it as one
// continuous allocation pool.
function GpuDevicesTable({ gpus, telemetry, tr }: { gpus: GpuInfo[]; telemetry: GpuTelemetrySample[]; tr: boolean }) {
  const hasTelemetry = telemetry.length > 0;
  return <section className="overflow-hidden rounded-2xl border bg-card shadow-soft">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3.5 sm:px-5">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><Gauge className="size-4.5" /></span>
        <div><h2 className="font-medium">{tr ? "GPU aygıtları" : "GPU devices"}</h2><p className="text-xs text-muted-foreground">{tr ? "Aygıt başına fiziksel bellek ve canlı telemetri" : "Per-device physical memory and live telemetry"}</p></div>
      </div>
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${hasTelemetry ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
        <span className={`size-1.5 rounded-full ${hasTelemetry ? "bg-success animate-pulse motion-reduce:animate-none" : "bg-muted-foreground/50"}`} />
        {hasTelemetry ? (tr ? "Canlı" : "Live") : (tr ? "Telemetri yok" : "Telemetry unavailable")}
      </span>
    </div>
    <div className="divide-y">
      {gpus.map((gpu) => {
        const sample = telemetryFor(telemetry, gpu);
        const totalVram = sample?.usedVramGB != null && sample.freeVramGB != null ? sample.usedVramGB + sample.freeVramGB : gpu.vramGB;
        const usedVram = sample?.usedVramGB ?? gpu.usedVramGB;
        const freeVram = sample?.freeVramGB ?? gpu.freeVramGB;
        const memoryPercent = totalVram && usedVram != null ? usedVram / totalVram * 100 : null;
        const capabilityLabels = Object.entries(gpu.capabilities ?? {}).filter(([, available]) => available).map(([name]) => name.toUpperCase());
        const available = gpu.computeAvailable !== false && !gpu.displayOnly && !gpu.compatibilityIssue;
        const hot = (sample?.temperatureC ?? 0) >= 80;
        return <div key={gpu.id ?? gpu.name} className="px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-sm font-semibold">{gpu.name}</h3><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${available ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>{available ? (tr ? "Hazır" : "Compute ready") : (tr ? "Kullanılamıyor" : "Unavailable")}</span></div><p className="mt-1 text-[11px] text-muted-foreground">{gpu.vendor.toUpperCase()}{gpu.architecture ? ` · ${gpu.architecture}` : ""}{gpu.driverVersion ? ` · driver ${gpu.driverVersion}` : ""}</p></div>
            <div className="flex flex-wrap justify-end gap-1">{capabilityLabels.length > 0 ? capabilityLabels.map((label) => <span key={label} className="rounded-md border bg-background px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-muted-foreground">{label}</span>) : <span className="text-[10px] text-muted-foreground">{tr ? "Doğrulanmış backend yok" : "No verified backend"}</span>}</div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-muted/45 p-3"><div className="flex items-center justify-between gap-2 text-[11px]"><span className="flex items-center gap-1.5 text-muted-foreground"><MemoryStick className="size-3" />VRAM</span><span className="font-medium tabular-nums">{usedVram != null && totalVram != null ? `${usedVram.toFixed(1)} / ${totalVram.toFixed(1)} GB` : totalVram != null ? `${totalVram.toFixed(1)} GB` : "—"}</span></div><div className="mt-2"><GpuMeter value={memoryPercent} tone={(memoryPercent ?? 0) >= 90 ? "warning" : "primary"} /></div>{freeVram != null && <p className="mt-1.5 text-[10px] text-muted-foreground">{freeVram.toFixed(1)} GB {tr ? "boş" : "free"}</p>}</div>
            <div className="rounded-xl bg-muted/45 p-3"><div className="flex items-center justify-between gap-2 text-[11px]"><span className="flex items-center gap-1.5 text-muted-foreground"><Activity className="size-3" />{tr ? "Kullanım" : "Utilization"}</span><span className="font-medium tabular-nums">{sample?.utilizationPercent != null ? `${sample.utilizationPercent.toFixed(0)}%` : "—"}</span></div><div className="mt-2"><GpuMeter value={sample?.utilizationPercent} /></div><p className="mt-1.5 text-[10px] text-muted-foreground">{sample ? `${sample.source} · ${sample.confidence}` : (tr ? "Okuma yok" : "No reading")}</p></div>
            <div className="rounded-xl bg-muted/45 p-3"><div className="flex items-center justify-between gap-2 text-[11px]"><span className="flex items-center gap-1.5 text-muted-foreground"><Thermometer className="size-3" />{tr ? "Sıcaklık" : "Temperature"}</span><span className={`font-medium tabular-nums ${hot ? "text-warning" : ""}`}>{sample?.temperatureC != null ? `${sample.temperatureC.toFixed(0)}°C` : "—"}</span></div><p className="mt-3 text-[10px] text-muted-foreground">{hot ? (tr ? "Yüksek sıcaklık" : "High temperature") : (tr ? "Termal telemetri" : "Thermal telemetry")}</p></div>
            <div className="rounded-xl bg-muted/45 p-3"><div className="flex items-center justify-between gap-2 text-[11px]"><span className="flex items-center gap-1.5 text-muted-foreground"><Zap className="size-3" />{tr ? "Güç" : "Power"}</span><span className="font-medium tabular-nums">{sample?.powerWatts != null ? `${sample.powerWatts.toFixed(0)} W` : "—"}</span></div><p className="mt-3 text-[10px] text-muted-foreground">{sample?.powerLimitWatts != null ? `${tr ? "Sınır" : "Limit"}: ${sample.powerLimitWatts.toFixed(0)} W` : (tr ? "Güç sınırı yok" : "No power limit reading")}</p></div>
          </div>
          {gpu.compatibilityIssue && <div className="mt-3 flex gap-2 rounded-lg border border-warning/20 bg-warning/5 p-2.5 text-[11px] text-warning"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{gpu.compatibilityIssue}</div>}
          {gpu.migInfo && <p className="mt-2 text-[11px] text-muted-foreground">{gpu.migInfo}</p>}
        </div>;
      })}
    </div>
  </section>;
}

function EnvironmentRow({ environment, tr, onPlan }: { environment: PythonEnvironmentStatus; tr: boolean; onPlan(): void }) {
  const action = environment.state === "missing" ? (tr ? "Kurulum planı" : "Install plan") : environment.state === "drifted" ? (tr ? "Onarım planı" : "Repair plan") : null;
  return <div className="grid gap-4 px-4 py-4 lg:grid-cols-[1fr_1.2fr_auto]"><div><div className="flex items-center gap-2"><h3 className="font-medium">{environment.family}</h3><StatusBadge state={environment.state} /></div><p className="mt-1 break-all text-xs text-muted-foreground">{environment.destination}</p></div><div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><span><span className="block text-muted-foreground">Python</span>{environment.pythonVersion ?? environment.manifest.python}</span><span><span className="block text-muted-foreground">{tr ? "İndirme" : "Download"}</span>{bytes(environment.manifest.expectedDownloadBytes)}</span><span><span className="block text-muted-foreground">{tr ? "Disk" : "Disk"}</span>{bytes(environment.manifest.diskRequirementBytes)}</span><a className="inline-flex items-start gap-1 text-primary hover:underline" href={environment.manifest.documentationUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-3" />{tr ? "Belgeler" : "Docs"}</a><span className="col-span-full text-muted-foreground">{Object.entries(environment.manifest.packages).map(([name, version]) => `${name} ${version}`).join(" · ")}</span>{environment.issues.length > 0 && <span className="col-span-full text-amber-700 dark:text-amber-400">{environment.issues.join(" ")}</span>}</div><div className="flex items-start">{action && <Button variant="outline" size="sm" onClick={onPlan}>{environment.state === "drifted" ? <Wrench className="mr-1.5 size-3.5" /> : <FileText className="mr-1.5 size-3.5" />}{action}</Button>}</div></div>;
}
