import { useEffect, useState } from "react";
import { Pencil, Plus, Users2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, InlineNotice, SectionHeader } from "@/components/ds";
import { MultiSelectChecklist } from "@/components/multi-select-checklist";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { createGroup, listGroups, listPolicies, listUsers, updateGroup } from "@/lib/api/client";
import type { Group, Policy, User } from "@/lib/api/types";

interface GroupFormState {
    name: string;
    policyIds: string[];
}

function emptyForm(): GroupFormState {
    return { name: "", policyIds: [] };
}

export default function Groups() {
    const { organizationId, permissions } = useOrg();
    const [groups, setGroups] = useState<Group[] | undefined>(undefined);
    const [users, setUsers] = useState<User[]>([]);
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [dialogGroup, setDialogGroup] = useState<Group | null | undefined>(undefined);
    const [form, setForm] = useState<GroupFormState>(emptyForm());
    const [busy, setBusy] = useState(false);
    const [formError, setFormError] = useState<string | undefined>(undefined);

    const canManageGroups = permissions?.["iam:manageGroups"] ?? false;
    const canManagePolicies = permissions?.["iam:managePolicies"] ?? false;

    function refresh(): void {
        setLoadError(undefined);
        Promise.all([listGroups(organizationId), listUsers(organizationId), canManagePolicies ? listPolicies(organizationId) : Promise.resolve([])])
            .then(([g, u, p]) => {
                setGroups(g);
                setUsers(u);
                setPolicies(p);
            })
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // suppression) as frontend/'s sessions-context.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(refresh, [organizationId, canManagePolicies]);

    const policyNameById = new Map(policies.map((p) => [p.id, p.name]));

    function memberCount(groupId: string): number {
        return users.filter((u) => u.groupIds.includes(groupId)).length;
    }

    function openCreate(): void {
        setForm(emptyForm());
        setFormError(undefined);
        setDialogGroup(null);
    }

    function openEdit(group: Group): void {
        setForm({ name: group.name, policyIds: group.policyIds });
        setFormError(undefined);
        setDialogGroup(group);
    }

    async function handleSubmit(): Promise<void> {
        setBusy(true);
        setFormError(undefined);
        try {
            const body = { name: form.name.trim(), policyIds: canManagePolicies ? form.policyIds : undefined };
            if (dialogGroup === null) await createGroup(organizationId, body);
            else if (dialogGroup) await updateGroup(organizationId, dialogGroup.id, body);
            setDialogGroup(undefined);
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
                <InlineNotice variant="destructive" title="Could not load groups" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }
    if (groups === undefined) return null;

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <SectionHeader title="Groups" description={`${groups.length} total`} />
                {canManageGroups && (
                    <Button size="sm" onClick={openCreate} className="gap-2">
                        <Plus className="size-4" />
                        Create group
                    </Button>
                )}
            </div>

            {groups.length === 0 ? (
                <EmptyState icon={<Users2 className="size-6" />} title="No groups yet" />
            ) : (
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {groups.map((g) => (
                        <div key={g.id} className="flex items-center gap-3 p-3">
                            <div className="min-w-0 flex-1">
                                <span className="font-medium">{g.name}</span>
                                <p className="text-xs text-muted-foreground">
                                    {memberCount(g.id)} member{memberCount(g.id) === 1 ? "" : "s"}
                                    {g.policyIds.length > 0 && ` · ${g.policyIds.map((id) => policyNameById.get(id) ?? id).join(", ")}`}
                                </p>
                            </div>
                            {canManageGroups && (
                                <Button variant="ghost" size="sm" onClick={() => openEdit(g)} className="gap-2">
                                    <Pencil className="size-4" />
                                    Edit
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Dialog open={dialogGroup !== undefined} onOpenChange={(open) => !open && setDialogGroup(undefined)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{dialogGroup === null ? "Create group" : "Edit group"}</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        {formError && (
                            <InlineNotice variant="destructive" title="Could not save">
                                {formError}
                            </InlineNotice>
                        )}
                        <label className="flex flex-col gap-1 text-sm">
                            Name
                            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                        </label>
                        {canManagePolicies && (
                            <div className="text-sm">
                                Policies
                                <MultiSelectChecklist
                                    items={policies.map((p) => ({ id: p.id, label: p.name }))}
                                    selected={form.policyIds}
                                    onChange={(policyIds) => setForm({ ...form, policyIds })}
                                />
                            </div>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDialogGroup(undefined)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleSubmit()} disabled={busy || !form.name.trim()}>
                            {dialogGroup === null ? "Create" : "Save"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
