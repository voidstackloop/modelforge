import { useEffect, useRef, useState } from "react";
import { DatabaseBackup, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, InlineNotice, SectionHeader, StatusBadge, type StatusTone } from "@/components/ds";
import { useOrg } from "@/lib/org-context";
import { describeApiError } from "@/lib/authz/permissions";
import { approveTenantRestore, exportTenantBackup, listTenantRestoreRequests, proposeTenantRestore, rejectTenantRestore } from "@/lib/api/client";
import type { TenantBackupArtifact, TenantRestoreRequest, TenantRestoreRequestStatus } from "@/lib/api/types";

const STATUS_TONE: Record<TenantRestoreRequestStatus, StatusTone> = {
    pending: "warning",
    approved: "success",
    completed: "success",
    rejected: "neutral",
    failed: "error",
};

export default function Backup() {
    const { organizationId, permissions, membership } = useOrg();
    const [requests, setRequests] = useState<TenantRestoreRequest[] | undefined>(undefined);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);
    const [exporting, setExporting] = useState(false);
    const [pendingUpload, setPendingUpload] = useState<TenantBackupArtifact | undefined>(undefined);
    const [proposing, setProposing] = useState(false);
    const [proposeError, setProposeError] = useState<string | undefined>(undefined);
    const [rejectTarget, setRejectTarget] = useState<TenantRestoreRequest | undefined>(undefined);
    const [rejectReason, setRejectReason] = useState("");
    const [rejectBusy, setRejectBusy] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const canExport = permissions?.["tenantBackup:export"] ?? false;
    const canPropose = permissions?.["tenantBackup:proposeRestore"] ?? false;
    const canApprove = permissions?.["tenantBackup:approveRestore"] ?? false;
    const callerUserId = membership.user.id;

    function refresh(): void {
        setLoadError(undefined);
        listTenantRestoreRequests(organizationId)
            .then(setRequests)
            .catch((err: unknown) => setLoadError(describeApiError(err, organizationId)));
    }

    // Intentional fetch-on-mount/refresh, same pattern (and same
    // suppression) as frontend/'s sessions-context.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(refresh, [organizationId]);

    async function handleExport(): Promise<void> {
        setExporting(true);
        try {
            const blob = await exportTenantBackup(organizationId);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `backup-${organizationId}.json`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        } finally {
            setExporting(false);
        }
    }

    function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>): void {
        const file = e.target.files?.[0];
        e.target.value = ""; // allow re-selecting the same file later
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result as string) as TenantBackupArtifact;
                setProposeError(undefined);
                setPendingUpload(parsed);
            } catch {
                setLoadError("That file is not valid JSON — it doesn't look like a backup exported from this system.");
            }
        };
        reader.readAsText(file);
    }

    async function handlePropose(): Promise<void> {
        if (!pendingUpload) return;
        setProposing(true);
        setProposeError(undefined);
        try {
            await proposeTenantRestore(organizationId, { artifact: pendingUpload });
            setPendingUpload(undefined);
            refresh();
        } catch (err) {
            setProposeError(describeApiError(err, organizationId));
        } finally {
            setProposing(false);
        }
    }

    async function handleApprove(request: TenantRestoreRequest): Promise<void> {
        if (!confirm("Restore this backup now? This will insert any missing rows it contains — it never deletes or overwrites existing data.")) return;
        try {
            await approveTenantRestore(organizationId, request.id);
            refresh();
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        }
    }

    async function handleReject(): Promise<void> {
        if (!rejectTarget) return;
        setRejectBusy(true);
        try {
            await rejectTenantRestore(organizationId, rejectTarget.id, { reason: rejectReason.trim() || undefined });
            setRejectTarget(undefined);
            setRejectReason("");
            refresh();
        } catch (err) {
            setLoadError(describeApiError(err, organizationId));
        } finally {
            setRejectBusy(false);
        }
    }

    if (loadError) {
        return (
            <div className="p-6">
                <InlineNotice variant="destructive" title="Could not load backup/restore data" action={<Button onClick={refresh}>Retry</Button>}>
                    {loadError}
                </InlineNotice>
            </div>
        );
    }
    if (requests === undefined) return null;

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <SectionHeader
                title="Backup and restore"
                description="On-demand tenant export and reconciliation-restore — not continuous PITR. Restore only adds back missing data; it never deletes or overwrites anything already there."
            />

            <div className="flex flex-wrap gap-2 rounded-lg border border-border p-3">
                {canExport && (
                    <Button size="sm" variant="outline" onClick={() => void handleExport()} disabled={exporting} className="gap-2">
                        <Download className="size-4" />
                        {exporting ? "Exporting…" : "Export backup"}
                    </Button>
                )}
                {canPropose && (
                    <>
                        <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} className="gap-2">
                            <Upload className="size-4" />
                            Propose restore from file…
                        </Button>
                        <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFileSelected} />
                    </>
                )}
            </div>

            {requests.length === 0 ? (
                <EmptyState icon={<DatabaseBackup className="size-6" />} title="No restore requests yet" />
            ) : (
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {requests.map((r) => (
                        <div key={r.id} className="flex flex-col gap-2 p-3 text-sm">
                            <div className="flex items-center justify-between gap-2">
                                <StatusBadge tone={STATUS_TONE[r.status]}>{r.status}</StatusBadge>
                                <span className="text-xs text-muted-foreground">{new Date(r.requestedAt).toLocaleString()}</span>
                            </div>
                            <details className="text-xs">
                                <summary className="cursor-pointer text-muted-foreground">
                                    {Object.values(r.summary).reduce((sum, t) => sum + t.willInsert, 0)} row(s) would be added across{" "}
                                    {Object.keys(r.summary).length} table(s)
                                </summary>
                                <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 rounded-md bg-muted p-2 sm:grid-cols-3">
                                    {Object.entries(r.summary)
                                        .filter(([, counts]) => counts.willInsert > 0 || counts.alreadyPresent > 0)
                                        .map(([table, counts]) => (
                                            <li key={table}>
                                                {table}: +{counts.willInsert} / {counts.alreadyPresent} already present
                                            </li>
                                        ))}
                                </ul>
                            </details>
                            {r.errorMessage && (
                                <InlineNotice variant="destructive" title="Restore failed">
                                    {r.errorMessage}
                                </InlineNotice>
                            )}
                            {r.rejectionReason && <p className="text-xs text-muted-foreground">Rejected: {r.rejectionReason}</p>}
                            {r.status === "pending" && (
                                <div className="flex gap-2">
                                    {canApprove && r.requestedByUserId !== callerUserId && (
                                        <Button size="sm" variant="outline" onClick={() => void handleApprove(r)}>
                                            Approve and restore
                                        </Button>
                                    )}
                                    {canApprove && (
                                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRejectTarget(r)}>
                                            Reject
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Dialog open={pendingUpload !== undefined} onOpenChange={(open) => !open && setPendingUpload(undefined)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Propose this backup for restore</DialogTitle>
                    </DialogHeader>
                    {proposeError && (
                        <InlineNotice variant="destructive" title="Could not propose">
                            {proposeError}
                        </InlineNotice>
                    )}
                    {pendingUpload && (
                        <p className="text-sm text-muted-foreground">
                            Exported {new Date(pendingUpload.exportedAt).toLocaleString()} for organization {pendingUpload.organizationId}. This needs
                            approval from someone other than you before anything is restored.
                        </p>
                    )}
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setPendingUpload(undefined)} disabled={proposing}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handlePropose()} disabled={proposing}>
                            Submit for approval
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={rejectTarget !== undefined} onOpenChange={(open) => !open && setRejectTarget(undefined)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Reject this restore request</DialogTitle>
                    </DialogHeader>
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
