import { useEffect, useState } from "react";
import { Check, KeyRound, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge, type StatusTone } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import {
    ApiError,
    approvePolicyVersion,
    createPolicy,
    deletePolicy,
    listPolicies,
    listPolicyVersions,
    listUsers,
    proposePolicyVersion,
    rejectPolicyVersion,
    rollbackPolicy,
    updatePolicy,
} from "@/lib/api/client";
import type { Policy, PolicyVersion, PolicyVersionStatus, User } from "@/lib/api/types";
import { validatePolicyDocumentJson } from "./policy-document-schema";

interface PolicyFormState {
    name: string;
    description: string;
    documentJson: string;
}

function emptyForm(): PolicyFormState {
    return {
        name: "",
        description: "",
        documentJson: JSON.stringify({ version: "2026-01-01", statements: [{ effect: "Allow", actions: [""], resources: [""] }] }, null, 2),
    };
}

const VERSION_STATUS_TONE: Record<PolicyVersionStatus, StatusTone> = {
    pending: "warning",
    approved: "success",
    rejected: "error",
    superseded: "neutral",
};

export default function Policies() {
    const { organizationId, permissions, membership } = useOrg();
    const [policies, setPolicies] = useState<Policy[] | undefined>(undefined);
    const [users, setUsers] = useState<User[]>([]);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [dialogPolicy, setDialogPolicy] = useState<Policy | null | undefined>(undefined);
    const [form, setForm] = useState<PolicyFormState>(emptyForm());
    const [busy, setBusy] = useState(false);
    const [formErrors, setFormErrors] = useState<string[]>([]);
    const [versionsByPolicy, setVersionsByPolicy] = useState<Record<string, PolicyVersion[] | undefined>>({});
    const [versionsError, setVersionsError] = useState<Record<string, string | undefined>>({});
    const [rejectTarget, setRejectTarget] = useState<{ policyId: string; versionId: string; version: number } | undefined>(undefined);
    const [rejectReason, setRejectReason] = useState("");
    const [rejectBusy, setRejectBusy] = useState(false);
    const [rejectError, setRejectError] = useState<string | undefined>(undefined);

    const canManagePolicies = permissions?.["iam:managePolicies"] ?? false;
    const canPropose = permissions?.["policy:propose"] ?? false;
    const canApprove = permissions?.["policy:approve"] ?? false;
    const canListUsers = permissions?.["iam:listUsers"] ?? false;
    const callerUserId = membership.user.id;
    // The propose-only path only ever applies to an *existing* policy: a
    // brand-new Policy resource still requires iam:managePolicies to create
    // (policy:propose only covers proposing a new version of one that
    // already exists — see routes/policy-versions.ts's header comment).
    const proposingChange = dialogPolicy != null && !canManagePolicies && canPropose;

    const userNameById = new Map(users.map((u) => [u.id, u.displayName]));
    function labelFor(userId: string): string {
        if (userId === callerUserId) return "you";
        return userNameById.get(userId) ?? userId;
    }

    function refresh(): void {
        setLoadError(undefined);
        Promise.all([listPolicies(organizationId), canListUsers ? listUsers(organizationId) : Promise.resolve([])])
            .then(([p, u]) => {
                setPolicies(p);
                setUsers(u);
            })
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // suppression) as frontend/'s sessions-context.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(refresh, [organizationId, canListUsers]);

    function loadVersions(policyId: string): void {
        setVersionsError((prev) => ({ ...prev, [policyId]: undefined }));
        listPolicyVersions(organizationId, policyId)
            .then((versions) => setVersionsByPolicy((prev) => ({ ...prev, [policyId]: versions })))
            .catch((err: unknown) => setVersionsError((prev) => ({ ...prev, [policyId]: describeApiError(err, organizationId) })));
    }

    function openCreate(): void {
        setForm(emptyForm());
        setFormErrors([]);
        setDialogPolicy(null);
    }

    function openEdit(policy: Policy): void {
        setForm({ name: policy.name, description: policy.description ?? "", documentJson: JSON.stringify(policy.document, null, 2) });
        setFormErrors([]);
        setDialogPolicy(policy);
    }

    async function handleSubmit(): Promise<void> {
        const validation = validatePolicyDocumentJson(form.documentJson);
        if (!validation.valid) {
            setFormErrors(validation.errors);
            return;
        }
        setBusy(true);
        setFormErrors([]);
        try {
            if (dialogPolicy === null) {
                await createPolicy(organizationId, {
                    name: form.name.trim(),
                    description: form.description.trim() || undefined,
                    document: validation.document,
                });
            } else if (dialogPolicy && proposingChange) {
                await proposePolicyVersion(organizationId, dialogPolicy.id, { document: validation.document });
                loadVersions(dialogPolicy.id);
            } else if (dialogPolicy) {
                await updatePolicy(organizationId, dialogPolicy.id, {
                    name: form.name.trim(),
                    description: form.description.trim() || undefined,
                    document: validation.document,
                });
            }
            setDialogPolicy(undefined);
            refresh();
        } catch (err) {
            setFormErrors([describeApiError(err, organizationId)]);
        } finally {
            setBusy(false);
        }
    }

    async function handleDelete(policy: Policy): Promise<void> {
        if (!window.confirm(`Delete the policy "${policy.name}"? This cannot be undone.`)) return;
        try {
            await deletePolicy(organizationId, policy.id);
            refresh();
        } catch (err) {
            // builtin_policy (400) is already prevented proactively by hiding
            // the button below — this is defense-in-depth in case a policy
            // was made builtin by someone else between load and click.
            setLoadError(err instanceof ApiError ? (err.body?.message ?? err.message) : describeApiError(err, organizationId));
        }
    }

    async function handleApprove(policyId: string, versionId: string): Promise<void> {
        try {
            await approvePolicyVersion(organizationId, policyId, versionId);
            loadVersions(policyId);
            refresh();
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    async function handleRollback(policyId: string, version: PolicyVersion): Promise<void> {
        if (!window.confirm(`Roll back to version ${version.version}? This supersedes whatever is currently live.`)) return;
        try {
            await rollbackPolicy(organizationId, policyId, { versionId: version.id });
            loadVersions(policyId);
            refresh();
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    async function handleReject(): Promise<void> {
        if (!rejectTarget) return;
        setRejectBusy(true);
        setRejectError(undefined);
        try {
            await rejectPolicyVersion(organizationId, rejectTarget.policyId, rejectTarget.versionId, { reason: rejectReason.trim() || undefined });
            loadVersions(rejectTarget.policyId);
            setRejectTarget(undefined);
            setRejectReason("");
        } catch (err) {
            setRejectError(describeApiError(err, organizationId));
        } finally {
            setRejectBusy(false);
        }
    }

    if (loadError) {
        return (
            <div className="p-6">
                <InlineNotice variant="destructive" title="Could not load policies" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }
    if (policies === undefined) return null;

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <SectionHeader title="Policies" description={`${policies.length} total`} />
                {canManagePolicies && (
                    <Button size="sm" onClick={openCreate} className="gap-2">
                        <Plus className="size-4" />
                        Create policy
                    </Button>
                )}
            </div>

            {policies.length === 0 ? (
                <EmptyState icon={<KeyRound className="size-6" />} title="No policies yet" />
            ) : (
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {policies.map((p) => (
                        <div key={p.id} className="flex items-start gap-3 p-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="truncate font-medium">{p.name}</span>
                                    {p.builtin && <Badge variant="secondary">Built-in — protected</Badge>}
                                </div>
                                <p className="truncate text-xs text-muted-foreground">
                                    {p.description || `${p.document.statements.length} statement${p.document.statements.length === 1 ? "" : "s"}`}
                                </p>

                                <details
                                    className="mt-1.5 text-xs"
                                    onToggle={(e) => {
                                        if (e.currentTarget.open && versionsByPolicy[p.id] === undefined) loadVersions(p.id);
                                    }}
                                >
                                    <summary className="cursor-pointer text-muted-foreground">History</summary>
                                    <div className="mt-2 flex flex-col gap-2">
                                        {versionsError[p.id] && (
                                            <InlineNotice variant="destructive" title="Could not load history">
                                                {versionsError[p.id]}
                                            </InlineNotice>
                                        )}
                                        {versionsByPolicy[p.id] === undefined && !versionsError[p.id] && (
                                            <p className="text-muted-foreground">Loading…</p>
                                        )}
                                        {versionsByPolicy[p.id]?.length === 0 && <p className="text-muted-foreground">No proposed changes yet.</p>}
                                        {versionsByPolicy[p.id]?.map((v) => (
                                            <div key={v.id} className="rounded-md border border-border p-2">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium">v{v.version}</span>
                                                    <StatusBadge tone={VERSION_STATUS_TONE[v.status]}>{v.status}</StatusBadge>
                                                </div>
                                                <p className="mt-1 text-muted-foreground">
                                                    Proposed by {labelFor(v.proposedByUserId)} · {new Date(v.proposedAt).toLocaleString()}
                                                </p>
                                                {v.decidedAt && v.decidedByUserId && (
                                                    <p className="text-muted-foreground">
                                                        {v.status === "rejected" ? "Rejected" : "Decided"} by {labelFor(v.decidedByUserId)} ·{" "}
                                                        {new Date(v.decidedAt).toLocaleString()}
                                                        {v.rejectionReason && <> — "{v.rejectionReason}"</>}
                                                    </p>
                                                )}
                                                {v.status === "pending" && canApprove && (
                                                    <div className="mt-1.5 flex gap-2">
                                                        {v.proposedByUserId !== callerUserId && (
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="gap-1.5"
                                                                onClick={() => void handleApprove(p.id, v.id)}
                                                            >
                                                                <Check className="size-3.5" />
                                                                Approve
                                                            </Button>
                                                        )}
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            className="gap-1.5 text-destructive"
                                                            onClick={() => setRejectTarget({ policyId: p.id, versionId: v.id, version: v.version })}
                                                        >
                                                            <X className="size-3.5" />
                                                            Reject
                                                        </Button>
                                                    </div>
                                                )}
                                                {v.status === "superseded" && canApprove && (
                                                    <div className="mt-1.5">
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="gap-1.5"
                                                            onClick={() => void handleRollback(p.id, v)}
                                                        >
                                                            <RotateCcw className="size-3.5" />
                                                            Roll back to this version
                                                        </Button>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            </div>
                            {canManagePolicies && (
                                <>
                                    <Button variant="ghost" size="sm" onClick={() => openEdit(p)} className="gap-2">
                                        <Pencil className="size-4" />
                                        Edit
                                    </Button>
                                    {!p.builtin && (
                                        <Button variant="ghost" size="sm" onClick={() => void handleDelete(p)} className="gap-2 text-destructive">
                                            <Trash2 className="size-4" />
                                            Delete
                                        </Button>
                                    )}
                                </>
                            )}
                            {!canManagePolicies && canPropose && (
                                <Button variant="ghost" size="sm" onClick={() => openEdit(p)} className="gap-2">
                                    <Pencil className="size-4" />
                                    Propose change
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Dialog open={dialogPolicy !== undefined} onOpenChange={(open) => !open && setDialogPolicy(undefined)}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{dialogPolicy === null ? "Create policy" : proposingChange ? "Propose policy change" : "Edit policy"}</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        {formErrors.length > 0 && (
                            <InlineNotice variant="destructive" title="Could not save">
                                <ul className="list-disc pl-4">
                                    {formErrors.map((e, i) => (
                                        <li key={i}>{e}</li>
                                    ))}
                                </ul>
                            </InlineNotice>
                        )}
                        {proposingChange && (
                            <InlineNotice variant="info" title="This needs a second approver">
                                Submitting creates a pending version. It only takes effect once someone else with policy:approve approves it.
                            </InlineNotice>
                        )}
                        <label className="flex flex-col gap-1 text-sm">
                            Name
                            <Input
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                disabled={dialogPolicy?.builtin || proposingChange}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Description
                            <Input
                                value={form.description}
                                onChange={(e) => setForm({ ...form, description: e.target.value })}
                                disabled={proposingChange}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Policy document (JSON)
                            <Textarea
                                value={form.documentJson}
                                onChange={(e) => setForm({ ...form, documentJson: e.target.value })}
                                rows={12}
                                className="font-mono text-xs"
                            />
                        </label>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDialogPolicy(undefined)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleSubmit()} disabled={busy || !form.name.trim()}>
                            {dialogPolicy === null ? "Create" : proposingChange ? "Submit for approval" : "Save"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={rejectTarget !== undefined} onOpenChange={(open) => !open && setRejectTarget(undefined)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Reject version {rejectTarget?.version}</DialogTitle>
                    </DialogHeader>
                    {rejectError && (
                        <InlineNotice variant="destructive" title="Could not reject">
                            {rejectError}
                        </InlineNotice>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        Reason (optional)
                        <Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} />
                    </label>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setRejectTarget(undefined)} disabled={rejectBusy}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={() => void handleReject()} disabled={rejectBusy}>
                            Reject
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
