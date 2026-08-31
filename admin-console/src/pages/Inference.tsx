import { useEffect, useState } from "react";
import { Cpu, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, InlineNotice, SectionHeader } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import {
    createAiInferenceDeployment, createAiModelArtifact, listAiInferenceDeployments, listAiModelArtifacts,
    listAiProviderModels, listAiProviders, listComputePools, setAiInferenceDeploymentStatus, setAiModelArtifactStatus, verifyAiInferenceDeployment,
} from "@/lib/api/client";
import type { AiInferenceDeployment, AiModelArtifact, AiProvider, AiProviderModel, ComputePool } from "@/lib/api/types";

interface ArtifactDraft { runtime: "llamacpp" | "vllm"; sourceUri: string; sourceRevision: string; fileName: string; sha256: string; configurationHash: string; licenseId: string; licenseAccepted: boolean; toolCallParser: string }
interface DeploymentDraft { name: string; endpointUrl: string; servedModelName: string; credentialRef: string; tlsMode: "required" | "private-network"; maxConcurrency: number; priority: number }
const blankArtifact: ArtifactDraft = { runtime: "llamacpp", sourceUri: "", sourceRevision: "", fileName: "", sha256: "", configurationHash: "", licenseId: "", licenseAccepted: false, toolCallParser: "" };
const blankDeployment: DeploymentDraft = { name: "", endpointUrl: "", servedModelName: "", credentialRef: "env:INFERENCE_API_KEY", tlsMode: "required", maxConcurrency: 1, priority: 100 };

export default function Inference() {
    const { organizationId, permissions } = useOrg();
    const canManage = permissions?.["aiGateway:manageProviders"] ?? false;
    const [providers, setProviders] = useState<AiProvider[]>([]);
    const [models, setModels] = useState<AiProviderModel[]>([]);
    const [artifacts, setArtifacts] = useState<AiModelArtifact[]>([]);
    const [deployments, setDeployments] = useState<AiInferenceDeployment[]>([]);
    const [computePools, setComputePools] = useState<ComputePool[]>([]);
    const [poolId, setPoolId] = useState("");
    const [providerId, setProviderId] = useState("");
    const [modelId, setModelId] = useState("");
    const [artifactId, setArtifactId] = useState("");
    const [artifactDraft, setArtifactDraft] = useState(blankArtifact);
    const [deploymentDraft, setDeploymentDraft] = useState(blankDeployment);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);

    function loadProviders() {
        setError(undefined);
        listAiProviders(organizationId).then((items) => { setProviders(items); setProviderId((value) => value || items[0]?.id || ""); }).catch((reason) => setError(describeApiError(reason, organizationId)));
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount, same pattern as org-context.tsx
    useEffect(loadProviders, [organizationId]);
    useEffect(() => { listComputePools(organizationId).then((items) => { setComputePools(items); setPoolId((value) => value || items.find((item) => item.status === "active")?.id || ""); }).catch((reason) => setError(describeApiError(reason, organizationId))); }, [organizationId]);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting dependent selection when the parent selection changes
        if (!providerId) { setModels([]); setModelId(""); return; }
        listAiProviderModels(organizationId, providerId).then((items) => { setModels(items); setModelId(items[0]?.id ?? ""); }).catch((reason) => setError(describeApiError(reason, organizationId)));
    }, [organizationId, providerId]);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting dependent selection when the parent selection changes
        if (!modelId) { setArtifacts([]); setArtifactId(""); return; }
        listAiModelArtifacts(organizationId, modelId).then((items) => { setArtifacts(items); setArtifactId(items[0]?.id ?? ""); }).catch((reason) => setError(describeApiError(reason, organizationId)));
    }, [organizationId, modelId]);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting dependent selection when the parent selection changes
        if (!artifactId) { setDeployments([]); return; }
        listAiInferenceDeployments(organizationId, artifactId).then(setDeployments).catch((reason) => setError(describeApiError(reason, organizationId)));
    }, [organizationId, artifactId]);

    async function addArtifact() {
        if (!modelId) return;
        setBusy(true); setError(undefined);
        try {
            const runtime = artifactDraft.runtime;
            const created = await createAiModelArtifact(organizationId, modelId, {
                runtime, format: runtime === "llamacpp" ? "gguf" : "safetensors", sourceUri: artifactDraft.sourceUri.trim(), sourceRevision: artifactDraft.sourceRevision.trim(),
                fileName: artifactDraft.fileName.trim() || undefined, sha256: artifactDraft.sha256.trim(), configurationHash: artifactDraft.configurationHash.trim(),
                licenseId: artifactDraft.licenseId.trim(), licenseAccepted: artifactDraft.licenseAccepted,
                capabilities: { chat: true, streaming: true, tools: runtime === "vllm" && !!artifactDraft.toolCallParser.trim(), structuredOutput: true, embeddings: false, tokenCounting: true },
                toolCallParser: artifactDraft.toolCallParser.trim() || undefined, trustRemoteCode: false,
            });
            setArtifacts((items) => [...items, created]); setArtifactId(created.id); setArtifactDraft(blankArtifact);
        } catch (reason) { setError(describeApiError(reason, organizationId)); } finally { setBusy(false); }
    }

    async function approveArtifact(artifact: AiModelArtifact) {
        setBusy(true); try { const updated = await setAiModelArtifactStatus(organizationId, artifact.id, "verified"); setArtifacts((items) => items.map((item) => item.id === updated.id ? updated : item)); } catch (reason) { setError(describeApiError(reason, organizationId)); } finally { setBusy(false); }
    }

    async function addDeployment() {
        if (!artifactId) return;
        setBusy(true); setError(undefined);
        try {
            const created = await createAiInferenceDeployment(organizationId, artifactId, { ...deploymentDraft, poolId });
            setDeployments((items) => [...items, created]); setDeploymentDraft(blankDeployment);
        } catch (reason) { setError(describeApiError(reason, organizationId)); } finally { setBusy(false); }
    }

    async function verifyDeployment(deployment: AiInferenceDeployment) {
        setBusy(true); setError(undefined);
        try { const result = await verifyAiInferenceDeployment(organizationId, deployment.id); setDeployments((items) => items.map((item) => item.id === deployment.id ? result.deployment : item)); }
        catch (reason) { setError(describeApiError(reason, organizationId)); } finally { setBusy(false); }
    }

    async function disableDeployment(deployment: AiInferenceDeployment) {
        setBusy(true); try { const updated = await setAiInferenceDeploymentStatus(organizationId, deployment.id, "disabled"); setDeployments((items) => items.map((item) => item.id === updated.id ? updated : item)); } catch (reason) { setError(describeApiError(reason, organizationId)); } finally { setBusy(false); }
    }

    return <div className="mx-auto flex max-w-5xl flex-col gap-5 p-6">
        <SectionHeader title="Inference deployments" description="Approve immutable llama.cpp/vLLM artifacts, register authenticated endpoints, and verify exact served-model identity before use." />
        {error && <InlineNotice variant="destructive" title="Inference operation failed" action={<Button size="sm" onClick={loadProviders}>Retry</Button>}>{error}</InlineNotice>}
        <Card><CardHeader><CardTitle className="text-base">Catalog selection</CardTitle></CardHeader><CardContent className="grid gap-3 md:grid-cols-3">
            <label className="text-xs text-muted-foreground">Provider<select className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={providerId} onChange={(event) => setProviderId(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="text-xs text-muted-foreground">Model<select className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.modelId} · {item.modelVersion}</option>)}</select></label>
            <label className="text-xs text-muted-foreground">Artifact<select className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={artifactId} onChange={(event) => setArtifactId(event.target.value)}>{artifacts.map((item) => <option key={item.id} value={item.id}>{item.runtime} · {item.status} · {item.sha256.slice(0, 10)}</option>)}</select></label>
        </CardContent></Card>

        {artifacts.length === 0 && !canManage ? <EmptyState icon={<Cpu className="size-6" />} title="No inference artifacts are registered" /> : null}
        {canManage && modelId && <Card><CardHeader><CardTitle className="text-base">Register immutable artifact</CardTitle></CardHeader><CardContent className="grid gap-2 md:grid-cols-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={artifactDraft.runtime} onChange={(event) => setArtifactDraft((value) => ({ ...value, runtime: event.target.value as "llamacpp" | "vllm" }))}><option value="llamacpp">llama.cpp / GGUF</option><option value="vllm">vLLM / Safetensors</option></select>
            <Input placeholder="Source URI (hf://publisher/model)" value={artifactDraft.sourceUri} onChange={(event) => setArtifactDraft((value) => ({ ...value, sourceUri: event.target.value }))} />
            <Input placeholder="Exact source revision" value={artifactDraft.sourceRevision} onChange={(event) => setArtifactDraft((value) => ({ ...value, sourceRevision: event.target.value }))} />
            <Input placeholder="File name or snapshot path (optional)" value={artifactDraft.fileName} onChange={(event) => setArtifactDraft((value) => ({ ...value, fileName: event.target.value }))} />
            <Input placeholder="Artifact SHA-256" value={artifactDraft.sha256} onChange={(event) => setArtifactDraft((value) => ({ ...value, sha256: event.target.value }))} />
            <Input placeholder="Configuration SHA-256" value={artifactDraft.configurationHash} onChange={(event) => setArtifactDraft((value) => ({ ...value, configurationHash: event.target.value }))} />
            <Input placeholder="License identifier" value={artifactDraft.licenseId} onChange={(event) => setArtifactDraft((value) => ({ ...value, licenseId: event.target.value }))} />
            {artifactDraft.runtime === "vllm" && <Input placeholder="Verified tool-call parser (optional)" value={artifactDraft.toolCallParser} onChange={(event) => setArtifactDraft((value) => ({ ...value, toolCallParser: event.target.value }))} />}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={artifactDraft.licenseAccepted} onChange={(event) => setArtifactDraft((value) => ({ ...value, licenseAccepted: event.target.checked }))} /> License reviewed and accepted</label>
            <Button className="gap-2" disabled={busy || !artifactDraft.sourceUri || !artifactDraft.sourceRevision || artifactDraft.sha256.length !== 64 || artifactDraft.configurationHash.length !== 64 || !artifactDraft.licenseId} onClick={() => void addArtifact()}><Plus className="size-4" />Register pending artifact</Button>
        </CardContent></Card>}

        {artifacts.map((artifact) => <Card key={artifact.id}><CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm"><Badge>{artifact.runtime}</Badge><Badge variant="outline">{artifact.status}</Badge><span className="font-mono text-xs">{artifact.sha256.slice(0, 16)}…</span><span>{artifact.sourceUri}@{artifact.sourceRevision}</span>{canManage && artifact.status === "pending" && <Button size="sm" variant="outline" disabled={busy || !artifact.licenseAccepted} onClick={() => void approveArtifact(artifact)}><ShieldCheck className="mr-2 size-4" />Approve artifact</Button>}</CardContent></Card>)}

        {canManage && artifactId && <Card><CardHeader><CardTitle className="text-base">Register deployment</CardTitle></CardHeader><CardContent className="grid gap-2 md:grid-cols-2">
            <Input placeholder="Deployment name" value={deploymentDraft.name} onChange={(event) => setDeploymentDraft((value) => ({ ...value, name: event.target.value }))} />
            <Input placeholder="https://host/v1" value={deploymentDraft.endpointUrl} onChange={(event) => setDeploymentDraft((value) => ({ ...value, endpointUrl: event.target.value }))} />
            <Input placeholder="Served model name" value={deploymentDraft.servedModelName} onChange={(event) => setDeploymentDraft((value) => ({ ...value, servedModelName: event.target.value }))} />
            <Input placeholder="env:INFERENCE_API_KEY or file:/run/secrets/key" value={deploymentDraft.credentialRef} onChange={(event) => setDeploymentDraft((value) => ({ ...value, credentialRef: event.target.value }))} />
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={deploymentDraft.tlsMode} onChange={(event) => setDeploymentDraft((value) => ({ ...value, tlsMode: event.target.value as "required" | "private-network" }))}><option value="required">HTTPS required</option><option value="private-network">Private network HTTP/HTTPS</option></select>
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={poolId} onChange={(event) => setPoolId(event.target.value)}><option value="">Select compute pool</option>{computePools.filter((pool) => pool.status === "active").map((pool) => <option key={pool.id} value={pool.id}>{pool.name} · {pool.region}</option>)}</select>
            <Input type="number" min={1} max={1024} value={deploymentDraft.maxConcurrency} onChange={(event) => setDeploymentDraft((value) => ({ ...value, maxConcurrency: Number(event.target.value) }))} />
            <Button className="gap-2" disabled={busy || !poolId || !deploymentDraft.name || !deploymentDraft.endpointUrl.endsWith("/v1") || !deploymentDraft.servedModelName || !deploymentDraft.credentialRef} onClick={() => void addDeployment()}><Plus className="size-4" />Register disabled deployment</Button>
        </CardContent></Card>}

        {deployments.map((deployment) => <Card key={deployment.id}><CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm"><Badge variant="outline">{deployment.operationalStatus}</Badge><strong>{deployment.name}</strong><span className="font-mono text-xs">{deployment.endpointUrl}</span><span>{deployment.servedModelName}</span>{deployment.runtimeVersion && <span>runtime {deployment.runtimeVersion}</span>}{canManage && <Button size="sm" variant="outline" disabled={busy} onClick={() => void verifyDeployment(deployment)}><RefreshCw className="mr-2 size-4" />Verify</Button>}{canManage && deployment.operationalStatus !== "disabled" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disableDeployment(deployment)}>Disable</Button>}</CardContent></Card>)}
    </div>;
}
