import { useEffect, useState } from "react";
import { Building2, ChevronRight, Plus } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineNotice, SectionHeader, StatusBadge } from "@/components/ds";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth/auth-context";
import { useMe } from "@/lib/org-context";
import { createOrganization, ApiError } from "@/lib/api/client";

export default function OrgPicker() {
    const { me, error, refresh } = useMe();
    const { signOut } = useAuth();
    const navigate = useNavigate();
    const [creating, setCreating] = useState(false);
    const [newOrgName, setNewOrgName] = useState("");
    const [busy, setBusy] = useState(false);
    const [createError, setCreateError] = useState<string | undefined>(undefined);

    // A single membership is the common case (an org admin managing their
    // own org) — skip the picker entirely rather than making them click
    // through a list of one.
    useEffect(() => {
        if (me?.memberships.length === 1) {
            navigate(`/organizations/${me.memberships[0].organization.id}/users`, { replace: true });
        }
    }, [me, navigate]);

    if (error) {
        return (
            <div className="mx-auto max-w-lg p-6">
                <InlineNotice variant="destructive" title="Could not load your account" action={<Button onClick={refresh}>Retry</Button>}>
                    {error}
                </InlineNotice>
            </div>
        );
    }
    if (!me) return null;

    async function handleCreateOrganization(): Promise<void> {
        if (!newOrgName.trim()) return;
        setBusy(true);
        setCreateError(undefined);
        try {
            const { organization } = await createOrganization(newOrgName.trim());
            navigate(`/organizations/${organization.id}/users`);
        } catch (err) {
            setCreateError(err instanceof ApiError ? (err.body?.message ?? err.message) : "Could not create the organization.");
        } finally {
            setBusy(false);
        }
    }

    if (me.memberships.length === 1) return <Navigate to={`/organizations/${me.memberships[0].organization.id}/users`} replace />;

    return (
        <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-lg font-semibold">Choose an organization</h1>
                    <p className="text-sm text-muted-foreground">Signed in as {me.email ?? me.name ?? me.subject}.</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                    Sign out
                </Button>
            </div>

            {me.memberships.length === 0 ? (
                <p className="text-sm text-muted-foreground">You don't belong to any organization yet.</p>
            ) : (
                <div className="flex flex-col gap-2">
                    {me.memberships.map((m) => (
                        <button
                            key={m.organization.id}
                            onClick={() => navigate(`/organizations/${m.organization.id}/users`)}
                            className="flex items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-muted"
                        >
                            <Building2 className="size-5 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">{m.organization.name}</span>
                                    <StatusBadge tone={m.user.status === "active" ? "success" : "warning"}>{m.user.status}</StatusBadge>
                                </div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {m.effectivePolicyNames.map((name) => (
                                        <Badge key={name} variant="secondary" className="text-xs">
                                            {name}
                                        </Badge>
                                    ))}
                                </div>
                            </div>
                            <ChevronRight className="size-4 text-muted-foreground" />
                        </button>
                    ))}
                </div>
            )}

            <SectionHeader title="Create a new organization" />
            {!creating ? (
                <Button variant="outline" onClick={() => setCreating(true)} className="gap-2">
                    <Plus className="size-4" />
                    Create organization
                </Button>
            ) : (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    {createError && (
                        <InlineNotice variant="destructive" title="Could not create organization">
                            {createError}
                        </InlineNotice>
                    )}
                    <Input placeholder="Organization name" value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} disabled={busy} />
                    <div className="flex gap-2">
                        <Button onClick={() => void handleCreateOrganization()} disabled={busy || !newOrgName.trim()}>
                            Create
                        </Button>
                        <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
