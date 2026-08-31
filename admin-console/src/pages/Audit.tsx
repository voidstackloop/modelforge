import { useEffect, useState } from "react";
import { Download, Gavel, ScrollText, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import {
    exportAudit,
    listAudit,
    listAuditLegalHolds,
    listUsers,
    placeAuditLegalHold,
    releaseAuditLegalHold,
    verifyAuditChain,
} from "@/lib/api/client";
import type { AuditEvent, AuditLegalHold, AuditSearchFilters, ChainVerificationResult, User } from "@/lib/api/types";

const PAGE_SIZE = 200;
const ANY_ACTOR = "__any__";

interface FilterFormState {
    action: string;
    targetId: string;
    actorUserId: string;
    since: string;
    until: string;
}

const EMPTY_FILTERS: FilterFormState = { action: "", targetId: "", actorUserId: ANY_ACTOR, since: "", until: "" };

/** A `datetime-local` value has no timezone; the server expects ISO 8601.
 * Returns undefined for an empty/unparseable box so a half-typed date never
 * silently narrows the results. */
function toIso(localDateTime: string): string | undefined {
    if (!localDateTime) return undefined;
    const parsed = new Date(localDateTime);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function toSearchFilters(form: FilterFormState): AuditSearchFilters {
    return {
        action: form.action.trim() || undefined,
        targetId: form.targetId.trim() || undefined,
        actorUserId: form.actorUserId === ANY_ACTOR ? undefined : form.actorUserId,
        since: toIso(form.since),
        until: toIso(form.until),
    };
}

export default function Audit() {
    const { organizationId, permissions } = useOrg();
    const [events, setEvents] = useState<AuditEvent[] | undefined>(undefined);
    const [users, setUsers] = useState<User[]>([]);
    const [holds, setHolds] = useState<AuditLegalHold[]>([]);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [form, setForm] = useState<FilterFormState>(EMPTY_FILTERS);
    const [appliedFilters, setAppliedFilters] = useState<AuditSearchFilters>({});
    const [loadingMore, setLoadingMore] = useState(false);
    const [reachedEnd, setReachedEnd] = useState(false);
    const [chainResult, setChainResult] = useState<ChainVerificationResult | undefined>(undefined);
    const [placingHold, setPlacingHold] = useState(false);
    const [holdReason, setHoldReason] = useState("");
    const [holdBusy, setHoldBusy] = useState(false);
    const [holdError, setHoldError] = useState<string | undefined>(undefined);

    const canManageLegalHold = permissions?.["audit:manageLegalHold"] ?? false;

    function load(filters: AuditSearchFilters): void {
        setLoadError(undefined);
        setChainResult(undefined);
        Promise.all([
            listAudit(organizationId, { ...filters, limit: PAGE_SIZE }),
            listUsers(organizationId).catch(() => []),
            listAuditLegalHolds(organizationId).catch(() => []),
        ])
            .then(([e, u, h]) => {
                setEvents(e);
                setUsers(u);
                setHolds(h);
                setAppliedFilters(filters);
                setReachedEnd(e.length < PAGE_SIZE);
            })
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    function refresh(): void {
        load({});
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // set-state-in-effect suppression) as frontend/'s sessions-context.tsx.
    // exhaustive-deps is suppressed too because refresh -> load is
    // recreated on every render: depending on it would re-fetch in a loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
    useEffect(refresh, [organizationId]);

    const displayNameBySubject = new Map(users.map((u) => [u.externalSubject, u.displayName]));
    const displayNameByUserId = new Map(users.map((u) => [u.id, u.displayName]));
    const activeHold = holds.find((h) => h.status === "active");

    async function handleLoadMore(): Promise<void> {
        if (!events || events.length === 0) return;
        setLoadingMore(true);
        try {
            const cursor = events[events.length - 1].sequence;
            const next = await listAudit(organizationId, { ...appliedFilters, cursor, limit: PAGE_SIZE });
            setEvents([...events, ...next]);
            if (next.length < PAGE_SIZE) setReachedEnd(true);
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        } finally {
            setLoadingMore(false);
        }
    }

    async function handleExport(): Promise<void> {
        try {
            const blob = await exportAudit(organizationId, appliedFilters);
            // The export needs the bearer token, so it can't be a plain
            // <a href> — fetch it, then hand the browser a blob URL.
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `audit-${organizationId}.csv`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    async function handleVerifyChain(): Promise<void> {
        try {
            setChainResult(await verifyAuditChain(organizationId));
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    async function handlePlaceHold(): Promise<void> {
        setHoldBusy(true);
        setHoldError(undefined);
        try {
            await placeAuditLegalHold(organizationId, { reason: holdReason.trim() });
            setPlacingHold(false);
            setHoldReason("");
            load(appliedFilters);
        } catch (err) {
            setHoldError(describeApiError(err, organizationId));
        } finally {
            setHoldBusy(false);
        }
    }

    async function handleReleaseHold(hold: AuditLegalHold): Promise<void> {
        const releaseReason = window.prompt("Reason for releasing this legal hold (optional):") ?? undefined;
        try {
            await releaseAuditLegalHold(organizationId, hold.id, { releaseReason: releaseReason || undefined });
            load(appliedFilters);
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    if (loadError) {
        return (
            <div className="p-6">
                <InlineNotice variant="destructive" title="Could not load the audit log" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }
    if (events === undefined) return null;

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between gap-2">
                <SectionHeader title="Audit log" description="Newest first. Filters and pagination run on the server." />
                <div className="flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" onClick={() => void handleVerifyChain()} className="gap-2">
                        <ShieldCheck className="size-4" />
                        Verify integrity
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void handleExport()} className="gap-2">
                        <Download className="size-4" />
                        Export CSV
                    </Button>
                </div>
            </div>

            {chainResult &&
                (chainResult.valid ? (
                    <InlineNotice variant="success" title="Audit chain verified">
                        {chainResult.checkedCount} chained {chainResult.checkedCount === 1 ? "entry" : "entries"} verified — none has been modified or
                        removed since it was written. This is tamper-evidence, not a cryptographic signature.
                    </InlineNotice>
                ) : (
                    <InlineNotice variant="destructive" title="Audit chain verification FAILED">
                        The chain breaks at sequence {chainResult.brokenAtSequence}. Entries at or after that point may have been modified or removed
                        outside the application. Escalate this — do not dismiss it.
                    </InlineNotice>
                ))}

            <div className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                    <p className="flex items-center gap-2 text-sm font-medium">
                        <Gavel className="size-4" />
                        Legal hold
                    </p>
                    {canManageLegalHold && !activeHold && (
                        <Button size="sm" variant="outline" onClick={() => setPlacingHold(true)}>
                            Place hold
                        </Button>
                    )}
                </div>
                {holds.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No legal holds have been placed on this organization's audit trail.</p>
                ) : (
                    <div className="flex flex-col gap-2">
                        {holds.map((hold) => (
                            <div key={hold.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-2 text-xs">
                                <div className="min-w-0">
                                    <StatusBadge tone={hold.status === "active" ? "warning" : "neutral"}>{hold.status}</StatusBadge>
                                    <p className="mt-1">{hold.reason}</p>
                                    <p className="text-muted-foreground">
                                        Placed by {displayNameByUserId.get(hold.placedByUserId) ?? hold.placedByUserId} ·{" "}
                                        {new Date(hold.placedAt).toLocaleString()}
                                    </p>
                                    {hold.releasedAt && (
                                        <p className="text-muted-foreground">
                                            Released by {displayNameByUserId.get(hold.releasedByUserId ?? "") ?? hold.releasedByUserId} ·{" "}
                                            {new Date(hold.releasedAt).toLocaleString()}
                                            {hold.releaseReason && <> — {hold.releaseReason}</>}
                                        </p>
                                    )}
                                </div>
                                {canManageLegalHold && hold.status === "active" && (
                                    <Button size="sm" variant="ghost" onClick={() => void handleReleaseHold(hold)} className="shrink-0">
                                        Release
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                    A hold is a compliance record of intent to preserve. Nothing in this system deletes audit history today, so a hold does not
                    currently block anything — it is the record a future retention/purge process must consult.
                </p>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs">
                        Action
                        <Input placeholder="e.g. policy.create" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        Target id
                        <Input placeholder="e.g. a case or policy id" value={form.targetId} onChange={(e) => setForm({ ...form, targetId: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        Actor
                        <Select value={form.actorUserId} onValueChange={(v) => setForm({ ...form, actorUserId: v ?? ANY_ACTOR })}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ANY_ACTOR}>Anyone</SelectItem>
                                {users.map((u) => (
                                    <SelectItem key={u.id} value={u.id}>
                                        {u.displayName}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1 text-xs">
                            From
                            <Input type="datetime-local" value={form.since} onChange={(e) => setForm({ ...form, since: e.target.value })} />
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                            To
                            <Input type="datetime-local" value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} />
                        </label>
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button size="sm" onClick={() => load(toSearchFilters(form))}>
                        Apply filters
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            setForm(EMPTY_FILTERS);
                            load({});
                        }}
                    >
                        Clear
                    </Button>
                </div>
            </div>

            {events.length === 0 ? (
                <EmptyState icon={<ScrollText className="size-6" />} title="No matching events" description="Try widening or clearing the filters." />
            ) : (
                <>
                    <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                        {events.map((event) => (
                            <div key={event.id} className="flex flex-col gap-1 p-3 text-sm">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium">{event.action}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</span>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {event.targetType} · {event.targetId} — by {displayNameBySubject.get(event.actorExternalSubject) ?? event.actorExternalSubject}
                                </p>
                                {event.details && Object.keys(event.details).length > 0 && (
                                    <details className="text-xs">
                                        <summary className="cursor-pointer text-muted-foreground">Details</summary>
                                        <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2">{JSON.stringify(event.details, null, 2)}</pre>
                                    </details>
                                )}
                            </div>
                        ))}
                    </div>
                    {!reachedEnd && (
                        <Button variant="outline" onClick={() => void handleLoadMore()} disabled={loadingMore}>
                            {loadingMore ? "Loading…" : "Load more"}
                        </Button>
                    )}
                </>
            )}

            <Dialog open={placingHold} onOpenChange={setPlacingHold}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Place a legal hold</DialogTitle>
                    </DialogHeader>
                    {holdError && (
                        <InlineNotice variant="destructive" title="Could not place the hold">
                            {holdError}
                        </InlineNotice>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        Reason
                        <Textarea
                            value={holdReason}
                            onChange={(e) => setHoldReason(e.target.value)}
                            rows={3}
                            placeholder="Why must this organization's audit trail be preserved?"
                        />
                    </label>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setPlacingHold(false)} disabled={holdBusy}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handlePlaceHold()} disabled={holdBusy || !holdReason.trim()}>
                            Place hold
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
