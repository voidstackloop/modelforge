import { useEffect, useState } from "react";
import { Check, Copy, Mail, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { createInvitation, listInvitations, listUsers, revokeInvitation } from "@/lib/api/client";
import type { Invitation, InvitationStatus, User } from "@/lib/api/types";

const STATUS_TONE: Record<InvitationStatus, "success" | "warning" | "error" | "neutral"> = {
    pending: "neutral",
    accepted: "success",
    revoked: "error",
    expired: "warning",
};

export default function Invitations() {
    const { organizationId, permissions } = useOrg();
    const [invitations, setInvitations] = useState<Invitation[] | undefined>(undefined);
    const [users, setUsers] = useState<User[]>([]);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [creating, setCreating] = useState(false);
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [expiresInHours, setExpiresInHours] = useState("72");
    const [busy, setBusy] = useState(false);
    const [formError, setFormError] = useState<string | undefined>(undefined);
    const [revealedToken, setRevealedToken] = useState<string | undefined>(undefined);
    const [copied, setCopied] = useState(false);

    const canManageUsers = permissions?.["iam:manageUsers"] ?? false;

    function refresh(): void {
        setLoadError(undefined);
        Promise.all([listInvitations(organizationId), listUsers(organizationId)])
            .then(([i, u]) => {
                setInvitations(i);
                setUsers(u);
            })
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // suppression) as frontend/'s sessions-context.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(refresh, [organizationId]);

    const userNameById = new Map(users.map((u) => [u.id, u.displayName]));

    function openCreate(): void {
        setEmail("");
        setDisplayName("");
        setExpiresInHours("72");
        setFormError(undefined);
        setCreating(true);
    }

    async function handleCreate(): Promise<void> {
        setBusy(true);
        setFormError(undefined);
        try {
            const hours = Number(expiresInHours);
            const { token } = await createInvitation(organizationId, {
                email: email.trim(),
                displayName: displayName.trim() || undefined,
                expiresInHours: Number.isFinite(hours) && hours > 0 ? hours : undefined,
            });
            setCreating(false);
            setRevealedToken(token);
            setCopied(false);
            refresh();
        } catch (err) {
            setFormError(describeApiError(err, organizationId));
        } finally {
            setBusy(false);
        }
    }

    async function handleRevoke(invitation: Invitation): Promise<void> {
        if (!window.confirm(`Revoke the invitation sent to ${invitation.email}?`)) return;
        try {
            await revokeInvitation(organizationId, invitation.id);
            refresh();
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    async function handleCopy(): Promise<void> {
        if (!revealedToken) return;
        await navigator.clipboard.writeText(revealedToken);
        setCopied(true);
    }

    if (loadError) {
        return (
            <div className="p-6">
                <InlineNotice variant="destructive" title="Could not load invitations" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }
    if (invitations === undefined) return null;

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <SectionHeader title="Invitations" description={`${invitations.length} total`} />
                {canManageUsers && (
                    <Button size="sm" onClick={openCreate} className="gap-2">
                        <Plus className="size-4" />
                        Invite user
                    </Button>
                )}
            </div>

            {invitations.length === 0 ? (
                <EmptyState icon={<Mail className="size-6" />} title="No invitations yet" />
            ) : (
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {invitations.map((invitation) => (
                        <div key={invitation.id} className="flex items-center gap-3 p-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="truncate font-medium">{invitation.email}</span>
                                    <StatusBadge tone={STATUS_TONE[invitation.status]}>{invitation.status}</StatusBadge>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Invited by {userNameById.get(invitation.invitedByUserId) ?? "someone no longer in this org"} · expires{" "}
                                    {new Date(invitation.expiresAt).toLocaleString()}
                                </p>
                            </div>
                            {canManageUsers && invitation.status === "pending" && (
                                <Button variant="ghost" size="sm" onClick={() => void handleRevoke(invitation)} className="gap-2 text-destructive">
                                    <X className="size-4" />
                                    Revoke
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Dialog open={creating} onOpenChange={setCreating}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Invite user</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        {formError && (
                            <InlineNotice variant="destructive" title="Could not create invitation">
                                {formError}
                            </InlineNotice>
                        )}
                        <label className="flex flex-col gap-1 text-sm">
                            Email
                            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Display name (optional)
                            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Expires in (hours)
                            <Input type="number" min={1} max={720} value={expiresInHours} onChange={(e) => setExpiresInHours(e.target.value)} />
                        </label>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleCreate()} disabled={busy || !email.trim()}>
                            Send invitation
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={revealedToken !== undefined} onOpenChange={(open) => !open && setRevealedToken(undefined)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Invitation created</DialogTitle>
                    </DialogHeader>
                    <InlineNotice variant="warning" title="This token is shown once">
                        Copy it now and send it to the invitee yourself — the API never emails anything, and this token cannot be retrieved again after
                        you close this dialog.
                    </InlineNotice>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted p-2 font-mono text-xs">
                        <span className="min-w-0 flex-1 truncate">{revealedToken}</span>
                        <Button variant="ghost" size="sm" onClick={() => void handleCopy()} className="gap-1.5 shrink-0">
                            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                            {copied ? "Copied" : "Copy"}
                        </Button>
                    </div>
                    <DialogFooter>
                        <Button onClick={() => setRevealedToken(undefined)}>Done</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
