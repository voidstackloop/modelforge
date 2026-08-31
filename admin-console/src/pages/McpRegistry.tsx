import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Power, PowerOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge } from "@/components/ds";
import {
    createMcpRegistryEntry, listMcpRegistryEntries, setMcpRegistryEntryStatus, updateMcpRegistryEntry,
} from "@/lib/api/client";
import type { McpDataEgressPolicy, McpRegistryEntry, McpTransport } from "@/lib/api/types";
import { describeApiError } from "@/lib/authz/permissions";
import { useOrg } from "@/lib/org-context";
import { formatAllowedTools, parseAllowedTools, validateMcpEndpoint } from "./mcp-registry-form";

interface Draft {
    name: string;
    description: string;
    transport: McpTransport;
    endpoint: string;
    allowedTools: string;
    dataEgressPolicy: McpDataEgressPolicy;
}

const blankDraft: Draft = {
    name: "", description: "", transport: "http", endpoint: "", allowedTools: "*", dataEgressPolicy: "none",
};

export default function McpRegistry() {
    const { organizationId, permissions } = useOrg();
    const canManage = permissions?.["mcpRegistry:manage"] ?? false;
    const [entries, setEntries] = useState<McpRegistryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [formError, setFormError] = useState<string>();
    const [dialogEntry, setDialogEntry] = useState<McpRegistryEntry | null | undefined>();
    const [draft, setDraft] = useState<Draft>(blankDraft);

    const load = useCallback(async () => {
        setLoading(true); setError(undefined);
        try { setEntries(await listMcpRegistryEntries(organizationId)); }
        catch (reason) { setError(describeApiError(reason, organizationId)); }
        finally { setLoading(false); }
    }, [organizationId]);

    useEffect(() => {
        let active = true;
        listMcpRegistryEntries(organizationId)
            .then((items) => { if (active) setEntries(items); })
            .catch((reason) => { if (active) setError(describeApiError(reason, organizationId)); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [organizationId]);

    function openCreate() {
        setDraft(blankDraft); setFormError(undefined); setDialogEntry(null);
    }

    function openEdit(entry: McpRegistryEntry) {
        setDraft({
            name: entry.name,
            description: entry.description ?? "",
            transport: entry.transport,
            endpoint: entry.endpoint,
            allowedTools: formatAllowedTools(entry.allowedTools),
            dataEgressPolicy: entry.dataEgressPolicy,
        });
        setFormError(undefined); setDialogEntry(entry);
    }

    async function save() {
        const endpointError = validateMcpEndpoint(draft.transport, draft.endpoint.trim());
        if (endpointError) { setFormError(endpointError); return; }
        let allowedTools: "*" | string[];
        try { allowedTools = parseAllowedTools(draft.allowedTools); }
        catch (reason) { setFormError((reason as Error).message); return; }
        setBusy(true); setFormError(undefined);
        const body = {
            name: draft.name.trim(),
            description: draft.description.trim() || undefined,
            transport: draft.transport,
            endpoint: draft.endpoint.trim(),
            allowedTools,
            dataEgressPolicy: draft.dataEgressPolicy,
        };
        try {
            const saved = dialogEntry
                ? await updateMcpRegistryEntry(organizationId, dialogEntry.id, body)
                : await createMcpRegistryEntry(organizationId, body);
            setEntries((current) => [...current.filter((entry) => entry.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
            setDialogEntry(undefined);
        } catch (reason) { setFormError(describeApiError(reason, organizationId)); }
        finally { setBusy(false); }
    }

    async function toggleStatus(entry: McpRegistryEntry) {
        setBusy(true); setError(undefined);
        try {
            const updated = await setMcpRegistryEntryStatus(organizationId, entry.id, entry.status === "active" ? "disabled" : "active");
            setEntries((current) => current.map((item) => item.id === updated.id ? updated : item));
        } catch (reason) { setError(describeApiError(reason, organizationId)); }
        finally { setBusy(false); }
    }

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-5 p-6">
            <SectionHeader
                title="MCP registry"
                description="Control which MCP endpoints and tools managed desktop clients may use, with explicit data-egress limits."
                action={canManage ? <Button onClick={openCreate} className="gap-2"><Plus className="size-4" />Add endpoint</Button> : undefined}
            />
            <InlineNotice variant="warning" title="Endpoint identity is exact">
                HTTP entries use a normalized URL. Stdio entries must contain a JSON array with the command and every argument, matching the managed desktop configuration exactly.
            </InlineNotice>
            {error && <InlineNotice variant="destructive" title="Could not load MCP registry" action={<Button size="sm" onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Retry</Button>}>{error}</InlineNotice>}
            {!loading && entries.length === 0 && !error ? (
                <EmptyState title="No MCP endpoints are registered" description="Managed desktop clients will fail closed until an administrator adds an active endpoint." />
            ) : (
                <div className="grid gap-3">
                    {entries.map((entry) => (
                        <Card key={entry.id}>
                            <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <strong>{entry.name}</strong>
                                        <StatusBadge tone={entry.status === "active" ? "success" : "neutral"}>{entry.status}</StatusBadge>
                                        <StatusBadge tone={entry.dataEgressPolicy === "none" ? "success" : entry.dataEgressPolicy === "metadata-only" ? "info" : "warning"}>
                                            {entry.dataEgressPolicy} egress
                                        </StatusBadge>
                                        <span className="rounded bg-muted px-2 py-0.5 text-xs">{entry.transport}</span>
                                    </div>
                                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{entry.endpoint}</p>
                                    {entry.description && <p className="mt-2 text-sm text-muted-foreground">{entry.description}</p>}
                                    <p className="mt-2 text-xs text-muted-foreground">
                                        Tools: {entry.allowedTools === "*" ? "all server-advertised tools" : entry.allowedTools.join(", ")}
                                    </p>
                                </div>
                                {canManage && (
                                    <div className="flex gap-2">
                                        <Button variant="outline" size="sm" onClick={() => openEdit(entry)}><Pencil className="mr-2 size-4" />Edit</Button>
                                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggleStatus(entry)}>
                                            {entry.status === "active" ? <PowerOff className="mr-2 size-4" /> : <Power className="mr-2 size-4" />}
                                            {entry.status === "active" ? "Disable" : "Enable"}
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <Dialog open={dialogEntry !== undefined} onOpenChange={(open) => !open && setDialogEntry(undefined)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{dialogEntry ? "Edit MCP endpoint" : "Add MCP endpoint"}</DialogTitle>
                        <DialogDescription>Changes are audited and enforced by managed desktop clients on their next MCP operation.</DialogDescription>
                    </DialogHeader>
                    {formError && <InlineNotice variant="destructive" title="Could not save">{formError}</InlineNotice>}
                    <div className="grid gap-3">
                        <label className="grid gap-1 text-sm">Name<Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                        <label className="grid gap-1 text-sm">Description<Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="grid gap-1 text-sm">Transport
                                <Select value={draft.transport} onValueChange={(value) => setDraft({ ...draft, transport: value as McpTransport, endpoint: "" })}>
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent><SelectItem value="http">HTTP</SelectItem><SelectItem value="stdio">stdio</SelectItem></SelectContent>
                                </Select>
                            </label>
                            <label className="grid gap-1 text-sm">Data egress
                                <Select value={draft.dataEgressPolicy} onValueChange={(value) => setDraft({ ...draft, dataEgressPolicy: value as McpDataEgressPolicy })}>
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="none">None</SelectItem>
                                        <SelectItem value="metadata-only">Metadata only</SelectItem>
                                        <SelectItem value="unrestricted">Unrestricted</SelectItem>
                                    </SelectContent>
                                </Select>
                            </label>
                        </div>
                        <label className="grid gap-1 text-sm">Endpoint
                            <Input
                                value={draft.endpoint}
                                onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                                placeholder={draft.transport === "http" ? "https://mcp.example.org/api" : '["node","server.js","/approved/vault"]'}
                                className="font-mono"
                            />
                        </label>
                        <label className="grid gap-1 text-sm">Allowed tools
                            <Textarea value={draft.allowedTools} onChange={(event) => setDraft({ ...draft, allowedTools: event.target.value })} placeholder={'*\nor one tool name per line'} className="min-h-28 font-mono" />
                        </label>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDialogEntry(undefined)} disabled={busy}>Cancel</Button>
                        <Button onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.endpoint.trim()}>{dialogEntry ? "Save" : "Create"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
