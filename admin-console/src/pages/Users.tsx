import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge } from "@/components/ds";
import { MultiSelectChecklist } from "@/components/multi-select-checklist";
import { useToast } from "@/components/toast";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { createUser, listGroups, listPolicies, listUsers, updateUser } from "@/lib/api/client";
import type { Group, Policy, User, UserStatus } from "@/lib/api/types";

interface UserFormState {
    externalSubject: string;
    displayName: string;
    email: string;
    status: UserStatus;
    groupIds: string[];
    policyIds: string[];
}

function emptyForm(): UserFormState {
    return { externalSubject: "", displayName: "", email: "", status: "active", groupIds: [], policyIds: [] };
}

export default function Users() {
    const { organizationId, permissions } = useOrg();
    const toast = useToast();
    const [users, setUsers] = useState<User[] | undefined>(undefined);
    const [groups, setGroups] = useState<Group[]>([]);
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [search, setSearch] = useState("");
    // undefined = dialog closed, null = create mode, a User = edit mode
    const [dialogUser, setDialogUser] = useState<User | null | undefined>(undefined);
    const [form, setForm] = useState<UserFormState>(emptyForm());
    const [busy, setBusy] = useState(false);
    const [formError, setFormError] = useState<string | undefined>(undefined);

    const canManagePolicies = permissions?.["iam:managePolicies"] ?? false;
    const canManageUsers = permissions?.["iam:manageUsers"] ?? false;

    function refresh(): void {
        setLoadError(undefined);
        Promise.all([listUsers(organizationId), listGroups(organizationId), canManagePolicies ? listPolicies(organizationId) : Promise.resolve([])])
            .then(([u, g, p]) => {
                setUsers(u);
                setGroups(g);
                setPolicies(p);
            })
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // suppression) as frontend/'s sessions-context.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(refresh, [organizationId, canManagePolicies]);

    const groupNameById = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

    const filtered = (users ?? []).filter((u) => {
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return u.displayName.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q) || u.externalSubject.toLowerCase().includes(q);
    });

    function openCreate(): void {
        setForm(emptyForm());
        setFormError(undefined);
        setDialogUser(null);
    }

    function openEdit(user: User): void {
        setForm({
            externalSubject: user.externalSubject,
            displayName: user.displayName,
            email: user.email ?? "",
            status: user.status,
            groupIds: user.groupIds,
            policyIds: user.policyIds,
        });
        setFormError(undefined);
        setDialogUser(user);
    }

    async function handleSubmit(): Promise<void> {
        setBusy(true);
        setFormError(undefined);
        try {
            if (dialogUser === null) {
                await createUser(organizationId, {
                    externalSubject: form.externalSubject.trim(),
                    displayName: form.displayName.trim(),
                    email: form.email.trim() || undefined,
                    groupIds: form.groupIds,
                    policyIds: canManagePolicies ? form.policyIds : undefined,
                });
                toast.success("User created.");
            } else if (dialogUser) {
                await updateUser(organizationId, dialogUser.id, {
                    displayName: form.displayName.trim(),
                    email: form.email.trim() || undefined,
                    status: form.status,
                    groupIds: form.groupIds,
                    policyIds: canManagePolicies ? form.policyIds : undefined,
                });
                toast.success("User updated.");
            }
            setDialogUser(undefined);
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
                <InlineNotice variant="destructive" title="Could not load users" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }
    if (users === undefined) return null;

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <SectionHeader title="Users" description={`${users.length} total`} />
                {canManageUsers && (
                    <Button size="sm" onClick={openCreate} className="gap-2">
                        <Plus className="size-4" />
                        Create user
                    </Button>
                )}
            </div>

            <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                    placeholder="Search by name, email, or subject…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8"
                />
            </div>

            {filtered.length === 0 ? (
                <EmptyState
                    icon={<Search className="size-6" />}
                    title="No users found"
                    description={search ? "Try a different search." : "No users yet."}
                />
            ) : (
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {filtered.map((u) => (
                        <div key={u.id} className="flex items-center gap-3 p-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="truncate font-medium">{u.displayName}</span>
                                    <StatusBadge tone={u.status === "active" ? "success" : "warning"}>{u.status}</StatusBadge>
                                </div>
                                <p className="truncate text-xs text-muted-foreground">{u.email ?? u.externalSubject}</p>
                                {u.groupIds.length > 0 && (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {u.groupIds.map((id) => groupNameById.get(id) ?? id).join(", ")}
                                    </p>
                                )}
                            </div>
                            {canManageUsers && (
                                <Button variant="ghost" size="sm" onClick={() => openEdit(u)} className="gap-2">
                                    <Pencil className="size-4" />
                                    Edit
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Dialog open={dialogUser !== undefined} onOpenChange={(open) => !open && setDialogUser(undefined)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{dialogUser === null ? "Create user" : "Edit user"}</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        {formError && (
                            <InlineNotice variant="destructive" title="Could not save">
                                {formError}
                            </InlineNotice>
                        )}
                        {dialogUser === null && (
                            <label className="flex flex-col gap-1 text-sm">
                                External subject (from your identity provider)
                                <Input value={form.externalSubject} onChange={(e) => setForm({ ...form, externalSubject: e.target.value })} />
                            </label>
                        )}
                        <label className="flex flex-col gap-1 text-sm">
                            Display name
                            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Email
                            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                        </label>
                        {dialogUser && (
                            <label className="flex flex-col gap-1 text-sm">
                                Status
                                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as UserStatus })}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="active">Active</SelectItem>
                                        <SelectItem value="suspended">Suspended</SelectItem>
                                    </SelectContent>
                                </Select>
                            </label>
                        )}
                        <div className="text-sm">
                            Groups
                            <MultiSelectChecklist
                                items={groups.map((g) => ({ id: g.id, label: g.name }))}
                                selected={form.groupIds}
                                onChange={(groupIds) => setForm({ ...form, groupIds })}
                            />
                        </div>
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
                        <Button variant="ghost" onClick={() => setDialogUser(undefined)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => void handleSubmit()}
                            disabled={busy || (dialogUser === null && !form.externalSubject.trim()) || !form.displayName.trim()}
                        >
                            {dialogUser === null ? "Create" : "Save"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
