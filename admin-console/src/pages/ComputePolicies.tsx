import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, InlineNotice, SectionHeader } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { activateComputePolicy, createComputePolicy, listComputePoliciesForPool, listComputePools } from "@/lib/api/client";
import type { ComputePolicy, ComputePool, ComputePriorityClass, ComputeResourceLimit, SignedComputePolicyRequest } from "@/lib/api/types";

const PRIORITIES: ComputePriorityClass[] = ["interactive", "imaging", "scheduled", "background", "maintenance"];

const EMPTY_LIMIT: ComputeResourceLimit = {};

function limitField(limit: ComputeResourceLimit, onChange: (next: ComputeResourceLimit) => void, disabled: boolean) {
    const numberField = (label: string, key: keyof ComputeResourceLimit) => (
        <label key={key} className="flex flex-col gap-1 text-xs text-muted-foreground">
            {label}
            <Input type="number" min={0} disabled={disabled} className="h-8 text-xs" value={(limit[key] as number) ?? ""}
                placeholder="unset"
                onChange={(e) => onChange({ ...limit, [key]: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
    );
    return <div className="grid gap-2 sm:grid-cols-4">
        {numberField("Max CPU threads", "maxCpuThreads")}
        {numberField("Max RAM (MB)", "maxRamMB")}
        {numberField("Max pinned mem (MB)", "maxPinnedMemoryMB")}
        {numberField("Max accelerators", "maxAccelerators")}
        {numberField("Max VRAM/device (MB)", "maxVramMBPerDevice")}
        {numberField("Max concurrency/device", "maxConcurrencyPerDevice")}
        {numberField("Max temperature (C)", "maxTemperatureC")}
        {numberField("Max power (W)", "maxPowerWatts")}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Allow CPU fallback
            <select className="h-8 rounded-md border bg-background px-2 text-xs" disabled={disabled} value={limit.allowCpuFallback === undefined ? "unset" : String(limit.allowCpuFallback)}
                onChange={(e) => onChange({ ...limit, allowCpuFallback: e.target.value === "unset" ? undefined : e.target.value === "true" })}>
                <option value="unset">unset</option><option value="true">Allowed</option><option value="false">Forbidden</option>
            </select>
        </label>
    </div>;
}

function mergeLimits(hard: ComputeResourceLimit, classLimit: ComputeResourceLimit | undefined): ComputeResourceLimit {
    return { ...hard, ...classLimit };
}

export default function ComputePolicies() {
    const { organizationId, permissions } = useOrg();
    const canManage = permissions?.["compute:managePolicies"] ?? false;
    const [pools, setPools] = useState<ComputePool[]>([]);
    const [selectedPool, setSelectedPool] = useState<string>("");
    const [policies, setPolicies] = useState<ComputePolicy[]>([]);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState<string>();

    const [draftName, setDraftName] = useState("New resource policy");
    const [draftExpiresInDays, setDraftExpiresInDays] = useState(30);
    const [draftHardLimits, setDraftHardLimits] = useState<ComputeResourceLimit>(EMPTY_LIMIT);
    const [draftClassLimits, setDraftClassLimits] = useState<Partial<Record<ComputePriorityClass, ComputeResourceLimit>>>({});
    const [previewPriority, setPreviewPriority] = useState<ComputePriorityClass>("background");
    const [signedPaste, setSignedPaste] = useState("");

    const load = useCallback(async () => {
        setError(undefined);
        try {
            const nextPools = await listComputePools(organizationId);
            setPools(nextPools);
            const poolId = selectedPool || nextPools[0]?.id || "";
            if (poolId && !selectedPool) setSelectedPool(poolId);
            if (poolId) setPolicies(await listComputePoliciesForPool(organizationId, poolId));
        } catch (reason) { setError(describeApiError(reason, organizationId)); }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedPool intentionally read, not a re-trigger dependency (see the explicit reload below)
    }, [organizationId]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        if (!selectedPool) return;
        listComputePoliciesForPool(organizationId, selectedPool).then(setPolicies).catch((reason) => setError(describeApiError(reason, organizationId)));
    }, [organizationId, selectedPool]);

    const draftJson = useMemo(() => JSON.stringify({
        name: draftName, ...(selectedPool ? { poolId: selectedPool } : {}), expiresInDays: draftExpiresInDays,
        hardLimits: draftHardLimits, workloadClassLimits: draftClassLimits,
    }, null, 2), [draftName, selectedPool, draftExpiresInDays, draftHardLimits, draftClassLimits]);

    function downloadDraft() {
        const blob = new Blob([draftJson], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = "compute-policy-draft.json";
        link.click();
        URL.revokeObjectURL(url);
    }

    async function submitSigned() {
        setBusy("submit"); setError(undefined);
        try {
            const parsed = JSON.parse(signedPaste) as SignedComputePolicyRequest;
            await createComputePolicy(organizationId, parsed);
            setSignedPaste("");
            if (selectedPool) setPolicies(await listComputePoliciesForPool(organizationId, selectedPool));
        } catch (reason) { setError(reason instanceof SyntaxError ? "That isn't valid JSON." : describeApiError(reason, organizationId)); }
        finally { setBusy(undefined); }
    }

    async function activate(policyId: string) {
        setBusy(policyId); setError(undefined);
        try {
            await activateComputePolicy(organizationId, policyId);
            if (selectedPool) setPolicies(await listComputePoliciesForPool(organizationId, selectedPool));
        } catch (reason) { setError(describeApiError(reason, organizationId)); }
        finally { setBusy(undefined); }
    }

    return <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
        <SectionHeader title="Compute resource policies" description="Signed hard CPU/GPU guardrails for the compute fleet. Signing happens offline (server/scripts/sign-compute-policy.js) — the private key never touches this console." />
        {error && <InlineNotice variant="destructive" title="Compute policy request failed">{error}</InlineNotice>}

        <Card><CardHeader><CardTitle className="text-base">Pool</CardTitle></CardHeader><CardContent>
            <select className="h-9 w-full max-w-sm rounded-md border bg-background px-2 text-sm" value={selectedPool} onChange={(e) => setSelectedPool(e.target.value)}>
                {pools.length === 0 && <option value="">No pools</option>}
                {pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}
            </select>
        </CardContent></Card>

        <Card><CardHeader><CardTitle className="text-base">Existing versions</CardTitle></CardHeader><CardContent className="space-y-2">
            {policies.length === 0 && <EmptyState icon={<ShieldCheck className="size-6" />} title="No policy versions for this pool" description="Compose a draft below, sign it offline, and submit it to create the first one." />}
            {policies.sort((a, b) => b.version - a.version).map((policy) => <div key={policy.id} className="flex flex-wrap items-center gap-2 rounded border p-3 text-sm">
                <strong>{policy.name}</strong><Badge variant={policy.status === "active" ? "default" : policy.status === "retired" ? "outline" : "secondary"}>{policy.status}</Badge>
                <span className="text-xs text-muted-foreground">v{policy.version} · issued {new Date(policy.issuedAt).toLocaleDateString()} · expires {new Date(policy.expiresAt).toLocaleDateString()}</span>
                {canManage && policy.status !== "active" && <Button size="sm" variant="outline" className="ml-auto" disabled={busy === policy.id} onClick={() => void activate(policy.id)}>{policy.status === "retired" ? "Activate (rollback)" : "Activate"}</Button>}
            </div>)}
        </CardContent></Card>

        <Card><CardHeader><CardTitle className="text-base">Compose a draft</CardTitle></CardHeader><CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">Name<Input className="h-8 text-xs" value={draftName} onChange={(e) => setDraftName(e.target.value)} /></label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">Expires in (days)<Input type="number" min={1} className="h-8 text-xs" value={draftExpiresInDays} onChange={(e) => setDraftExpiresInDays(Math.max(1, Number(e.target.value)))} /></label>
            </div>

            <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">Hard limits (apply to every workload class unless overridden below)</div>
                {limitField(draftHardLimits, setDraftHardLimits, false)}
            </div>

            <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">Per-priority overrides</div>
                <div className="space-y-3">
                    {PRIORITIES.map((priority) => <div key={priority} className="rounded border p-2">
                        <div className="mb-1 text-xs font-medium capitalize">{priority}</div>
                        {limitField(draftClassLimits[priority] ?? EMPTY_LIMIT, (next) => setDraftClassLimits((cur) => ({ ...cur, [priority]: next })), false)}
                    </div>)}
                </div>
            </div>

            <div className="rounded border bg-muted/30 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    Effective policy preview for
                    <select className="h-7 rounded-md border bg-background px-2 text-xs" value={previewPriority} onChange={(e) => setPreviewPriority(e.target.value as ComputePriorityClass)}>
                        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                </div>
                <pre className="overflow-x-auto text-xs">{JSON.stringify(mergeLimits(draftHardLimits, draftClassLimits[previewPriority]), null, 2)}</pre>
            </div>

            <Button size="sm" variant="outline" onClick={downloadDraft}><Download className="mr-2 size-3.5" />Download draft JSON to sign offline</Button>
        </CardContent></Card>

        {canManage && <Card><CardHeader><CardTitle className="text-base">Submit a signed policy</CardTitle></CardHeader><CardContent className="space-y-3">
            <Textarea rows={6} placeholder="Paste the JSON produced by server/scripts/sign-compute-policy.js" value={signedPaste} onChange={(e) => setSignedPaste(e.target.value)} />
            <Button size="sm" disabled={!signedPaste.trim() || busy === "submit"} onClick={() => void submitSigned()}>{busy === "submit" ? "Submitting…" : "Create policy"}</Button>
        </CardContent></Card>}
    </div>;
}
