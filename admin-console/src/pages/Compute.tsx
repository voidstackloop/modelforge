import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cpu, Gauge, RefreshCw, Scale, Server, Thermometer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, InlineNotice, SectionHeader } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { getComputeQuota, getComputeSummary, listComputeLeases, listComputeNodes, listComputePolicies, listComputePools, listComputeRequests, setComputeNodeState, setComputeQuota } from "@/lib/api/client";
import type { ComputeLease, ComputeNode, ComputeNodeState, ComputePolicy, ComputePool, ComputeQuota, ComputeRequest, ComputeSummary, SetComputeQuotaRequest } from "@/lib/api/types";

const EMPTY_QUOTA_DRAFT: SetComputeQuotaRequest = { reservedCpuThreads: 0, reservedRamMB: 0, reservedAccelerators: 0, burstCpuThreads: 0, burstRamMB: 0, burstAccelerators: 0, weight: 1, borrowingEnabled: true };

function quotaDraftFrom(quota: ComputeQuota | null): SetComputeQuotaRequest {
    return quota ? { reservedCpuThreads: quota.reservedCpuThreads, reservedRamMB: quota.reservedRamMB, reservedAccelerators: quota.reservedAccelerators, burstCpuThreads: quota.burstCpuThreads, burstRamMB: quota.burstRamMB, burstAccelerators: quota.burstAccelerators, weight: quota.weight, borrowingEnabled: quota.borrowingEnabled } : EMPTY_QUOTA_DRAFT;
}

function utilizationBar(used: number, reserved: number, burst: number): React.ReactNode {
    const denominator = Math.max(burst, reserved, 1);
    const reservedPercent = Math.min(100, (Math.min(used, reserved) / denominator) * 100);
    const borrowedPercent = Math.min(100 - reservedPercent, Math.max(0, (used - reserved) / denominator) * 100);
    return <div className="h-2 w-full overflow-hidden rounded-full bg-muted"><div className="flex h-full"><div className="h-full bg-primary" style={{ width: `${reservedPercent}%` }} /><div className="h-full bg-amber-500" style={{ width: `${borrowedPercent}%` }} /></div></div>;
}

function stateTone(state: string): "default" | "secondary" | "destructive" | "outline" {
    if (state === "online" || state === "running" || state === "active") return "default";
    if (state === "quarantined" || state === "failed" || state === "offline") return "destructive";
    return "outline";
}

export default function Compute() {
    const { organizationId, permissions } = useOrg();
    const canManageNodes = permissions?.["compute:manageNodes"] ?? false;
    const canManageCritical = permissions?.["compute:manageCritical"] ?? false;
    const [summary, setSummary] = useState<ComputeSummary>();
    const [nodes, setNodes] = useState<ComputeNode[]>([]);
    const [pools, setPools] = useState<ComputePool[]>([]);
    const [requests, setRequests] = useState<ComputeRequest[]>([]);
    const [leases, setLeases] = useState<ComputeLease[]>([]);
    const [policies, setPolicies] = useState<ComputePolicy[]>([]);
    const [quotas, setQuotas] = useState<Record<string, ComputeQuota | null>>({});
    const [quotaDrafts, setQuotaDrafts] = useState<Record<string, SetComputeQuotaRequest>>({});
    const [savingQuota, setSavingQuota] = useState<string>();
    const [error, setError] = useState<string>();
    const [busyNode, setBusyNode] = useState<string>();

    const load = useCallback(async () => {
        setError(undefined);
        try {
            const [nextSummary, nextNodes, nextPools, nextRequests, nextLeases, nextPolicies] = await Promise.all([
                getComputeSummary(organizationId), listComputeNodes(organizationId), listComputePools(organizationId),
                listComputeRequests(organizationId), listComputeLeases(organizationId), listComputePolicies(organizationId),
            ]);
            setSummary(nextSummary); setNodes(nextNodes); setPools(nextPools); setRequests(nextRequests); setLeases(nextLeases); setPolicies(nextPolicies);
            const quotaEntries = await Promise.all(nextPools.map(async (pool): Promise<[string, ComputeQuota | null]> => [pool.id, await getComputeQuota(organizationId, pool.id)]));
            const nextQuotas = Object.fromEntries(quotaEntries);
            setQuotas(nextQuotas);
            // Never clobbers a draft the operator is mid-edit on — only seeds
            // drafts for pools that don't have one yet (a fresh load or a
            // newly-created pool), matching this page's own 15s auto-refresh
            // not overwriting in-progress node-transition state either.
            setQuotaDrafts((current) => {
                const next = { ...current };
                for (const [poolId, quota] of quotaEntries) if (!(poolId in next)) next[poolId] = quotaDraftFrom(quota);
                return next;
            });
        } catch (reason) { setError(describeApiError(reason, organizationId)); }
    }, [organizationId]);

    async function saveQuota(poolId: string) {
        const draft = quotaDrafts[poolId];
        if (!draft) return;
        setSavingQuota(poolId); setError(undefined);
        try {
            const updated = await setComputeQuota(organizationId, poolId, draft);
            setQuotas((current) => ({ ...current, [poolId]: updated }));
            setQuotaDrafts((current) => ({ ...current, [poolId]: quotaDraftFrom(updated) }));
        } catch (reason) { setError(describeApiError(reason, organizationId)); }
        finally { setSavingQuota(undefined); }
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount + poll, same pattern as org-context.tsx
    useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer); }, [load]);

    async function transition(node: ComputeNode, state: ComputeNodeState) {
        setBusyNode(node.id); setError(undefined);
        try { const updated = await setComputeNodeState(organizationId, node.id, state, `Operator changed node state from the compute fleet console.`); setNodes((items) => items.map((item) => item.id === updated.id ? updated : item)); }
        catch (reason) { setError(describeApiError(reason, organizationId)); }
        finally { setBusyNode(undefined); }
    }

    const activeLeases = leases.filter((lease) => ["offered", "acknowledged", "running"].includes(lease.state));
    const queued = requests.filter((request) => request.state === "queued");
    const activePolicies = policies.filter((policy) => policy.status === "active");

    return <div className="mx-auto flex max-w-7xl flex-col gap-5 p-6">
        <SectionHeader title="Compute fleet" description="Regional CPU/GPU capacity, fenced leases, workload queues, and signed resource guardrails. This view contains infrastructure metadata only." action={<Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Refresh</Button>} />
        {error && <InlineNotice variant="destructive" title="Compute control request failed">{error}</InlineNotice>}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
                ["Nodes online", `${summary?.nodes.online ?? 0} / ${summary?.nodes.total ?? 0}`, Server],
                ["CPU threads", String(summary?.capacity.cpuThreads ?? 0), Cpu],
                ["Accelerators", String(summary?.capacity.accelerators ?? 0), Gauge],
                ["Queued", String(summary?.queuedRequests ?? 0), AlertTriangle],
                ["Active leases", String(summary?.activeLeases ?? 0), RefreshCw],
            ].map(([label, value, Icon]) => <Card key={String(label)}><CardContent className="flex items-center justify-between p-4"><div><div className="text-xs text-muted-foreground">{String(label)}</div><div className="mt-1 text-2xl font-semibold">{String(value)}</div></div><Icon className="size-5 text-muted-foreground" /></CardContent></Card>)}
        </div>

        <Card><CardHeader><CardTitle className="text-base">Nodes and accelerators</CardTitle></CardHeader><CardContent className="space-y-3">
            {nodes.length === 0 && <EmptyState icon={<Server className="size-6" />} title="No compute nodes enrolled" description="Enroll a workstation or inference server through the node-agent registration API." />}
            {nodes.map((node) => <div key={node.id} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2"><strong>{node.name}</strong><Badge variant={stateTone(node.state)}>{node.state}</Badge><span className="text-xs text-muted-foreground">{node.region} · {node.operatingSystem} · agent {node.agentVersion}</span><span className="ml-auto text-xs text-muted-foreground">heartbeat {new Date(node.lastHeartbeatAt).toLocaleString()}</span></div>
                <div className="mt-2 text-sm">CPU {node.freeCpuThreads}/{node.cpuThreads} free · RAM {(node.freeRamMB / 1024).toFixed(1)}/{(node.totalRamMB / 1024).toFixed(1)} GB free</div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">{node.devices.map((device) => <div key={device.id} className="rounded border bg-muted/30 p-2 text-xs"><div className="flex items-center gap-2"><strong>{device.vendor} {device.model}</strong><Badge variant={stateTone(device.health)}>{device.health}</Badge>{device.throttled && <Badge variant="destructive">throttled</Badge>}</div><div className="mt-1 text-muted-foreground">VRAM {(device.freeVramMB / 1024).toFixed(1)}/{(device.totalVramMB / 1024).toFixed(1)} GB · util {device.utilizationPercent ?? "—"}% · <Thermometer className="inline size-3" /> {device.temperatureC ?? "—"}°C · {device.powerWatts ?? "—"} W</div></div>)}</div>
                {canManageNodes && <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" disabled={busyNode === node.id} onClick={() => void transition(node, node.state === "cordoned" ? "online" : "cordoned")}>{node.state === "cordoned" ? "Restore" : "Cordon"}</Button><Button size="sm" variant="outline" disabled={busyNode === node.id} onClick={() => void transition(node, "draining")}>Drain</Button>{canManageCritical && <Button size="sm" variant="destructive" disabled={busyNode === node.id} onClick={() => void transition(node, "quarantined")}>Quarantine</Button>}</div>}
            </div>)}
        </CardContent></Card>

        <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader><CardTitle className="text-base">Pools and active guardrails</CardTitle></CardHeader><CardContent className="space-y-2">{pools.map((pool) => <div key={pool.id} className="rounded border p-3 text-sm"><div className="flex items-center gap-2"><strong>{pool.name}</strong><Badge variant={stateTone(pool.status)}>{pool.status}</Badge></div><div className="text-xs text-muted-foreground">{pool.region} · {pool.nodeIds.length} nodes · {pool.schedulingPolicy}</div><div className="mt-1 text-xs">Policy {activePolicies.find((policy) => policy.poolId === pool.id)?.version ?? "none"}</div></div>)}</CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Queue</CardTitle></CardHeader><CardContent className="space-y-2">{queued.length === 0 ? <div className="text-sm text-muted-foreground">No queued workloads.</div> : queued.map((request) => <div key={request.id} className="flex items-center gap-2 rounded border p-3 text-sm"><Badge variant="outline">{request.priority}</Badge><strong>{request.workloadKind}</strong><span className="ml-auto text-xs text-muted-foreground">{request.profile} · {new Date(request.queuedAt).toLocaleTimeString()}</span></div>)}</CardContent></Card>
        </div>

        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Scale className="size-4" />Quota and fair-share utilization</CardTitle></CardHeader><CardContent className="space-y-4">
            {pools.length === 0 && <div className="text-sm text-muted-foreground">No pools yet.</div>}
            {pools.map((pool) => {
                const quota = quotas[pool.id];
                const draft = quotaDrafts[pool.id] ?? EMPTY_QUOTA_DRAFT;
                const poolLeases = activeLeases.filter((lease) => lease.poolId === pool.id);
                const used = { cpu: poolLeases.reduce((sum, lease) => sum + lease.cpuThreads, 0), ram: poolLeases.reduce((sum, lease) => sum + lease.ramMB, 0), accel: poolLeases.reduce((sum, lease) => sum + lease.acceleratorDeviceIds.length, 0) };
                const field = (label: string, key: keyof SetComputeQuotaRequest, usedValue: number, unit: string) => <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {label}
                    <Input type="number" min={0} disabled={!canManageCritical} className="h-8 text-xs" value={draft[key] as number}
                        onChange={(e) => setQuotaDrafts((cur) => ({ ...cur, [pool.id]: { ...draft, [key]: Math.max(0, Number(e.target.value)) } }))} />
                    {quota && <span className="normal-case text-[11px]">{usedValue}{unit} used</span>}
                </label>;
                return <div key={pool.id} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-center gap-2"><strong>{pool.name}</strong>{!quota && <Badge variant="outline">no quota set — unlimited within pool capacity</Badge>}</div>
                    {quota && <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        <div>CPU threads{utilizationBar(used.cpu, quota.reservedCpuThreads, quota.burstCpuThreads)}</div>
                        <div>RAM{utilizationBar(used.ram, quota.reservedRamMB, quota.burstRamMB)}</div>
                        <div>Accelerators{utilizationBar(used.accel, quota.reservedAccelerators, quota.burstAccelerators)}</div>
                    </div>}
                    <div className="mt-3 grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
                        {field("Reserved CPU", "reservedCpuThreads", used.cpu, "")}
                        {field("Reserved RAM (MB)", "reservedRamMB", used.ram, "")}
                        {field("Reserved accel.", "reservedAccelerators", used.accel, "")}
                        {field("Burst CPU", "burstCpuThreads", used.cpu, "")}
                        {field("Burst RAM (MB)", "burstRamMB", used.ram, "")}
                        {field("Burst accel.", "burstAccelerators", used.accel, "")}
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Fair-share weight<Input type="number" min={0.01} step={0.1} disabled={!canManageCritical} className="h-8 text-xs" value={draft.weight} onChange={(e) => setQuotaDrafts((cur) => ({ ...cur, [pool.id]: { ...draft, weight: Math.max(0.01, Number(e.target.value)) } }))} /></label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Borrowing<select className="h-8 rounded-md border bg-background px-2 text-xs" disabled={!canManageCritical} value={String(draft.borrowingEnabled)} onChange={(e) => setQuotaDrafts((cur) => ({ ...cur, [pool.id]: { ...draft, borrowingEnabled: e.target.value === "true" } }))}><option value="true">Enabled</option><option value="false">Disabled</option></select></label>
                    </div>
                    {canManageCritical && <Button size="sm" className="mt-3" disabled={savingQuota === pool.id} onClick={() => void saveQuota(pool.id)}>{savingQuota === pool.id ? "Saving…" : "Save quota"}</Button>}
                </div>;
            })}
        </CardContent></Card>

        <Card><CardHeader><CardTitle className="text-base">Active leases</CardTitle></CardHeader><CardContent className="space-y-2">{activeLeases.length === 0 ? <div className="text-sm text-muted-foreground">No active leases.</div> : activeLeases.map((lease) => <div key={lease.id} className="grid gap-1 rounded border p-3 text-sm md:grid-cols-5"><Badge variant={stateTone(lease.state)}>{lease.state}</Badge><span>node {lease.nodeId.slice(0, 8)}</span><span>{lease.acceleratorDeviceIds.length ? `${lease.acceleratorDeviceIds.length} GPU` : "CPU"}</span><span>{lease.cpuThreads} threads · {lease.ramMB} MB</span><span className="text-xs text-muted-foreground">fence {lease.fencingToken} · expires {new Date(lease.expiresAt).toLocaleTimeString()}</span>{lease.explanation.degradedToCpu && <Badge variant="destructive">CPU fallback</Badge>}{lease.explanation.borrowedCapacity && <Badge variant="outline">borrowed</Badge>}</div>)}</CardContent></Card>
    </div>;
}
