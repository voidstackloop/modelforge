import { useEffect, useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { invokeBreakGlass, listBreakGlassGrants, listPolicies, listUsers, reviewBreakGlassGrant, setBreakGlassPolicy } from "@/lib/api/client";
import type { BreakGlassGrant, BreakGlassGrantStatus, Policy, User } from "@/lib/api/types";

const STATUS_TONE: Record<BreakGlassGrantStatus, "warning" | "neutral" | "success" | "error"> = {
    active: "warning",
    expired: "neutral",
    reviewed: "success", // overridden to "error" per-grant below when reviewOutcome is "flagged"
};

export default function BreakGlass() {
    const { organizationId, permissions } = useOrg();
    const [grants, setGrants] = useState<BreakGlassGrant[] | undefined>(undefined);
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [users, setUsers] = useState<User[]>([]);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [invoking, setInvoking] = useState(false);
    const [justification, setJustification] = useState("");
    const [busy, setBusy] = useState(false);
    const [formError, setFormError] = useState<string | undefined>(undefined);
    const [invokedGrant, setInvokedGrant] = useState<BreakGlassGrant | undefined>(undefined);

    const canInvoke = permissions?.["breakGlass:invoke"] ?? false;
    const canList = permissions?.["breakGlass:list"] ?? false;
    const canReview = permissions?.["breakGlass:review"] ?? false;
    const canManagePolicies = permissions?.["iam:managePolicies"] ?? false;

    function refresh(): void {
        setLoadError(undefined);
        Promise.all([
            canList ? listBreakGlassGrants(organizationId) : Promise.resolve([]),
            canManagePolicies ? listPolicies(organizationId) : Promise.resolve([]),
            canList || canManagePolicies ? listUsers(organizationId) : Promise.resolve([]),
        ])
            .then(([g, p, u]) => {
                setGrants(g);
                setPolicies(p);
                setUsers(u);
            })
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // suppression) as frontend/'s sessions-context.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(refresh, [organizationId, canList, canManagePolicies]);

    const userNameById = new Map(users.map((u) => [u.id, u.displayName]));
    const currentEmergencyPolicy = policies.find((p) => p.isBreakGlassPolicy);

    async function handleInvoke(): Promise<void> {
        setBusy(true);
        setFormError(undefined);
        try {
            const grant = await invokeBreakGlass(organizationId, { justification: justification.trim() });
            setInvoking(false);
            setJustification("");
            setInvokedGrant(grant);
            refresh();
        } catch (err) {
            setFormError(describeApiError(err, organizationId));
        } finally {
            setBusy(false);
        }
    }

    async function handleReview(grant: BreakGlassGrant, outcome: "acknowledged" | "flagged"): Promise<void> {
        if (outcome === "flagged" && !window.confirm("Flag this grant for compliance follow-up?")) return;
        try {
            await reviewBreakGlassGrant(organizationId, grant.id, { outcome });
            refresh();
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    async function handleSetEmergencyPolicy(policyId: string | null): Promise<void> {
        try {
            await setBreakGlassPolicy(organizationId, { policyId: policyId === "none" || policyId === null ? null : policyId });
            refresh();
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    if (loadError) {
        return (
            <div className="p-6">
                <InlineNotice variant="destructive" title="Could not load break-glass data" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <SectionHeader
                    title="Break glass"
                    description="Emergency access: grants immediately on entering a justification, no pre-approval. Heavily audited and reviewed afterward."
                />
                {canInvoke && (
                    <Button size="sm" variant="destructive" onClick={() => setInvoking(true)} className="gap-2 shrink-0">
                        <ShieldAlert className="size-4" />
                        Invoke break-glass access
                    </Button>
                )}
            </div>

            {canManagePolicies && (
                <div className="rounded-lg border border-border p-3">
                    <p className="mb-2 text-sm font-medium">Emergency access policy</p>
                    <Select value={currentEmergencyPolicy?.id ?? "none"} onValueChange={(v) => void handleSetEmergencyPolicy(v)}>
                        <SelectTrigger className="w-72">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="none">None configured</SelectItem>
                            {policies
                                .filter((p) => !p.builtin)
                                .map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                        {p.name}
                                    </SelectItem>
                                ))}
                        </SelectContent>
                    </Select>
                    <p className="mt-2 text-xs text-muted-foreground">
                        Whoever invokes break-glass temporarily gets exactly this policy's permissions, for a bounded time.
                    </p>
                </div>
            )}

            {canList &&
                (grants === undefined ? null : grants.length === 0 ? (
                    <EmptyState icon={<ShieldAlert className="size-6" />} title="No break-glass grants yet" />
                ) : (
                    <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                        {grants.map((grant) => (
                            <div key={grant.id} className="flex items-start gap-3 p-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">{userNameById.get(grant.userId) ?? grant.userId}</span>
                                        <StatusBadge tone={grant.status === "reviewed" && grant.reviewOutcome === "flagged" ? "error" : STATUS_TONE[grant.status]}>
                                            {grant.status === "reviewed" ? `reviewed (${grant.reviewOutcome})` : grant.status}
                                        </StatusBadge>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        Granted {new Date(grant.grantedAt).toLocaleString()} · expires {new Date(grant.expiresAt).toLocaleString()}
                                    </p>
                                    <details className="mt-1 text-xs">
                                        <summary className="cursor-pointer text-muted-foreground">Justification</summary>
                                        <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-2">{grant.justification}</p>
                                    </details>
                                </div>
                                {canReview && !grant.reviewedAt && (
                                    <div className="flex shrink-0 gap-2">
                                        <Button variant="outline" size="sm" onClick={() => void handleReview(grant, "acknowledged")} className="gap-1.5">
                                            <Check className="size-3.5" />
                                            Acknowledge
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => void handleReview(grant, "flagged")} className="gap-1.5 text-destructive">
                                            <X className="size-3.5" />
                                            Flag
                                        </Button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                ))}

            <Dialog open={invoking} onOpenChange={setInvoking}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Invoke break-glass access</DialogTitle>
                    </DialogHeader>
                    <InlineNotice variant="warning" title="This grants access immediately">
                        Access is granted the moment you submit — there is no approval step. It is heavily audited and will be reviewed afterward.
                    </InlineNotice>
                    {formError && (
                        <InlineNotice variant="destructive" title="Could not invoke break-glass access">
                            {formError}
                        </InlineNotice>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        Justification
                        <Textarea
                            value={justification}
                            onChange={(e) => setJustification(e.target.value)}
                            rows={4}
                            placeholder="Why do you need emergency access right now?"
                        />
                    </label>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setInvoking(false)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={() => void handleInvoke()} disabled={busy || justification.trim().length < 10}>
                            Grant access now
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={invokedGrant !== undefined} onOpenChange={(open) => !open && setInvokedGrant(undefined)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Access granted</DialogTitle>
                    </DialogHeader>
                    {invokedGrant && (
                        <InlineNotice variant="warning" title="Emergency access is now active">
                            Expires {new Date(invokedGrant.expiresAt).toLocaleString()}. This will be reviewed afterward.
                        </InlineNotice>
                    )}
                    <DialogFooter>
                        <Button onClick={() => setInvokedGrant(undefined)}>Done</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
