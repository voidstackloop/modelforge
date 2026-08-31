import { useEffect, useState } from "react";
import { Check, ClipboardList, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { createAccessReviewCampaign, decideAccessReviewItem, listAccessReviewCampaigns, listAccessReviewItems, listUsers } from "@/lib/api/client";
import type { AccessReviewCampaign, AccessReviewItem, User } from "@/lib/api/types";

export default function AccessReviews() {
    const { organizationId, membership, permissions } = useOrg();
    const [campaigns, setCampaigns] = useState<AccessReviewCampaign[] | undefined>(undefined);
    const [users, setUsers] = useState<User[]>([]);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [selectedCampaignId, setSelectedCampaignId] = useState<string | undefined>(undefined);
    const [items, setItems] = useState<AccessReviewItem[] | undefined>(undefined);
    const [busy, setBusy] = useState(false);

    const canManage = permissions?.["accessReview:manage"] ?? false;
    const canDecide = permissions?.["accessReview:decide"] ?? false;

    function refresh(): void {
        setLoadError(undefined);
        Promise.all([listAccessReviewCampaigns(organizationId), listUsers(organizationId).catch(() => [])])
            .then(([c, u]) => {
                setCampaigns(c);
                setUsers(u);
            })
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // suppression) as frontend/'s sessions-context.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(refresh, [organizationId]);

    function refreshItems(campaignId: string): void {
        listAccessReviewItems(organizationId, campaignId)
            .then(setItems)
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    function openCampaign(campaignId: string): void {
        setSelectedCampaignId(campaignId);
        setItems(undefined);
        refreshItems(campaignId);
    }

    async function handleCreateCampaign(): Promise<void> {
        setBusy(true);
        try {
            const campaign = await createAccessReviewCampaign(organizationId);
            refresh();
            openCampaign(campaign.id);
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        } finally {
            setBusy(false);
        }
    }

    async function handleDecide(item: AccessReviewItem, decision: "keep" | "revoke"): Promise<void> {
        if (decision === "revoke" && !window.confirm("Revoke this membership? The user will lose access immediately.")) return;
        try {
            await decideAccessReviewItem(organizationId, item.campaignId, item.id, { decision });
            refreshItems(item.campaignId);
            refresh();
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    const userNameById = new Map(users.map((u) => [u.id, u.displayName]));

    if (loadError) {
        return (
            <div className="p-6">
                <InlineNotice variant="destructive" title="Could not load access reviews" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }
    if (campaigns === undefined) return null;

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <SectionHeader title="Access reviews" description="Every campaign snapshots the active memberships at the time it's created." />
                {canManage && (
                    <Button size="sm" onClick={() => void handleCreateCampaign()} disabled={busy} className="gap-2 shrink-0">
                        <Plus className="size-4" />
                        New campaign
                    </Button>
                )}
            </div>

            {campaigns.length === 0 ? (
                <EmptyState icon={<ClipboardList className="size-6" />} title="No campaigns yet" />
            ) : (
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {campaigns.map((campaign) => (
                        <button
                            key={campaign.id}
                            onClick={() => openCampaign(campaign.id)}
                            className="flex items-center gap-3 p-3 text-left hover:bg-muted"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">{new Date(campaign.createdAt).toLocaleString()}</span>
                                    <StatusBadge tone={campaign.status === "completed" ? "success" : "warning"}>{campaign.status}</StatusBadge>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {campaign.decidedCount}/{campaign.itemCount} decided
                                </p>
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {selectedCampaignId && (
                <div className="rounded-lg border border-border p-3">
                    <SectionHeader title="Campaign items" />
                    {items === undefined ? null : items.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No memberships were active when this campaign was created.</p>
                    ) : (
                        <div className="flex flex-col divide-y divide-border">
                            {items.map((item) => {
                                const isSelf = item.subjectUserId === membership.user.id;
                                return (
                                    <div key={item.id} className="flex items-center gap-3 py-2">
                                        <div className="min-w-0 flex-1">
                                            <span className="text-sm font-medium">{userNameById.get(item.subjectUserId) ?? item.subjectUserId}</span>
                                        </div>
                                        <StatusBadge tone={item.decision === "pending" ? "neutral" : item.decision === "keep" ? "success" : "error"}>
                                            {item.decision}
                                        </StatusBadge>
                                        {canDecide && item.decision === "pending" && !isSelf && (
                                            <div className="flex shrink-0 gap-2">
                                                <Button variant="outline" size="sm" onClick={() => void handleDecide(item, "keep")} className="gap-1.5">
                                                    <Check className="size-3.5" />
                                                    Keep
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={() => void handleDecide(item, "revoke")} className="gap-1.5 text-destructive">
                                                    <X className="size-3.5" />
                                                    Revoke
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
