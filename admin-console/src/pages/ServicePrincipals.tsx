import { useEffect, useState } from "react";
import { Pencil, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge } from "@/components/ds";
import { MultiSelectChecklist } from "@/components/multi-select-checklist";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { createServicePrincipal, listPolicies, listServicePrincipals, updateServicePrincipal } from "@/lib/api/client";
import type { Policy, ServicePrincipal, ServicePrincipalStatus } from "@/lib/api/types";

interface FormState {
    issuer: string;
    externalSubject: string;
    displayName: string;
    status: ServicePrincipalStatus;
    policyIds: string[];
}

function emptyForm(): FormState {
    return { issuer: "", externalSubject: "", displayName: "", status: "active", policyIds: [] };
}

export default function ServicePrincipals() {
    const { organizationId, permissions } = useOrg();
    const [principals, setPrincipals] = useState<ServicePrincipal[] | undefined>(undefined);
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [dialogPrincipal, setDialogPrincipal] = useState<ServicePrincipal | null | undefined>(undefined);
    const [form, setForm] = useState<FormState>(emptyForm());
    const [busy, setBusy] = useState(false);
    const [formError, setFormError] = useState<string | undefined>(undefined);

    // service-principals.ts requires BOTH iam:manageUsers AND
    // iam:managePolicies unconditionally to create one (unlike users/groups,
    // where managePolicies is only required when policy fields are sent) —
    // so creation is gated on both together, not managePolicies alone.
    const canCreate = (permissions?.["iam:manageUsers"] ?? false) && (permissions?.["iam:managePolicies"] ?? false);
    const canManageUsers = permissions?.["iam:manageUsers"] ?? false;
    const canManagePolicies = permissions?.["iam:managePolicies"] ?? false;

    function refresh(): void {
        setLoadError(undefined);
        Promise.all([listServicePrincipals(organizationId), canManagePolicies ? listPolicies(organizationId) : Promise.resolve([])])
            .then(([p, pol]) => {
                setPrincipals(p);
                setPolicies(pol);
            })
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // suppression) as frontend/'s sessions-context.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(refresh, [organizationId, canManagePolicies]);

    const policyNameById = new Map(policies.map((p) => [p.id, p.name]));

    function openCreate(): void {
        setForm(emptyForm());
        setFormError(undefined);
        setDialogPrincipal(null);
    }

    function openEdit(principal: ServicePrincipal): void {
        setForm({
            issuer: principal.issuer,
            externalSubject: principal.externalSubject,
            displayName: principal.displayName,
            status: principal.status,
            policyIds: principal.policyIds,
        });
        setFormError(undefined);
        setDialogPrincipal(principal);
    }

    async function handleSubmit(): Promise<void> {
        setBusy(true);
        setFormError(undefined);
        try {
            if (dialogPrincipal === null) {
                await createServicePrincipal(organizationId, {
                    issuer: form.issuer.trim(),
                    externalSubject: form.externalSubject.trim(),
                    displayName: form.displayName.trim(),
                    policyIds: form.policyIds,
                });
            } else if (dialogPrincipal) {
                await updateServicePrincipal(organizationId, dialogPrincipal.id, {
                    displayName: form.displayName.trim(),
                    status: form.status,
                    policyIds: form.policyIds,
                });
            }
            setDialogPrincipal(undefined);
            refresh();
        } catch (err) {
            setFormError(describeApiError(err, organizationId));
        } finally {
            setBusy(false);
        }
    }

    if (loadError) {
        return (
            <div className="p-6">
                <InlineNotice variant="destructive" title="Could not load service principals" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }
    if (principals === undefined) return null;

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <SectionHeader
                    title="Service principals"
                    description="Non-human callers, authenticated with their own externally-issued OIDC token — ModelForge does not issue or store credentials for them."
                />
                {canCreate && (
                    <Button size="sm" onClick={openCreate} className="gap-2 shrink-0">
                        <Plus className="size-4" />
                        Create
                    </Button>
                )}
            </div>

            {principals.length === 0 ? (
                <EmptyState icon={<ShieldCheck className="size-6" />} title="No service principals yet" />
            ) : (
                <TooltipProvider>
                    <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                        {principals.map((p) => (
                            <div key={p.id} className="flex items-center gap-3 p-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate font-medium">{p.displayName}</span>
                                        <StatusBadge tone={p.status === "active" ? "success" : p.status === "suspended" ? "warning" : "error"}>
                                            {p.status}
                                        </StatusBadge>
                                    </div>
                                    <Tooltip>
                                        <TooltipTrigger
                                            render={<p className="truncate text-xs text-muted-foreground">{p.issuer} · {p.externalSubject}</p>}
                                        />
                                        <TooltipContent>{p.externalSubject}</TooltipContent>
                                    </Tooltip>
                                    {p.policyIds.length > 0 && (
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {p.policyIds.map((id) => policyNameById.get(id) ?? id).join(", ")}
                                        </p>
                                    )}
                                </div>
                                {canManageUsers && (
                                    <Button variant="ghost" size="sm" onClick={() => openEdit(p)} className="gap-2">
                                        <Pencil className="size-4" />
                                        Edit
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                </TooltipProvider>
            )}

            <Dialog open={dialogPrincipal !== undefined} onOpenChange={(open) => !open && setDialogPrincipal(undefined)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{dialogPrincipal === null ? "Create service principal" : "Edit service principal"}</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        {formError && (
                            <InlineNotice variant="destructive" title="Could not save">
                                {formError}
                            </InlineNotice>
                        )}
                        {dialogPrincipal === null && (
                            <>
                                <label className="flex flex-col gap-1 text-sm">
                                    Issuer (URL)
                                    <Input value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="https://…" />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    External subject
                                    <Input value={form.externalSubject} onChange={(e) => setForm({ ...form, externalSubject: e.target.value })} />
                                </label>
                            </>
                        )}
                        <label className="flex flex-col gap-1 text-sm">
                            Display name
                            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
                        </label>
                        {dialogPrincipal && (
                            <label className="flex flex-col gap-1 text-sm">
                                Status
                                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as ServicePrincipalStatus })}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="active">Active</SelectItem>
                                        <SelectItem value="suspended">Suspended</SelectItem>
                                        <SelectItem value="deprovisioned">Deprovisioned</SelectItem>
                                    </SelectContent>
                                </Select>
                            </label>
                        )}
                        <div className="text-sm">
                            Policies
                            <MultiSelectChecklist
                                items={policies.map((p) => ({ id: p.id, label: p.name }))}
                                selected={form.policyIds}
                                onChange={(policyIds) => setForm({ ...form, policyIds })}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDialogPrincipal(undefined)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => void handleSubmit()}
                            disabled={
                                busy ||
                                !form.displayName.trim() ||
                                (dialogPrincipal === null && (!form.issuer.trim() || !form.externalSubject.trim()))
                            }
                        >
                            {dialogPrincipal === null ? "Create" : "Save"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
