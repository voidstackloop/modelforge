import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState, InlineNotice } from "@/components/ds";
import { StatusBadge, type StatusTone } from "@/components/ds/status-badge";
import { useToast } from "@/components/toast";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/format-time";
import type { Hl7IngestionJob } from "@/types/electron";

type StatusFilter = "pending-review" | "applied" | "rejected" | "all";

const STATUS_TONE: Record<Hl7IngestionJob["status"], StatusTone> = {
    "pending-review": "warning",
    applied: "success",
    rejected: "neutral",
};

const MATCH_TONE: Record<Hl7IngestionJob["matchStatus"], StatusTone> = {
    matched: "success",
    ambiguous: "warning",
    "no-match": "error",
};

/** One pending-review job's resolve controls. Ambiguous matches offer a
 * button per candidate case (never an arbitrary id — resolveHl7IngestionJob
 * enforces the same server-side, this just avoids offering a choice the
 * server would reject); a "matched" job that's still pending (a retry after
 * a concurrency conflict — see hl7/ingestion.ts) offers its one matched
 * case; a genuine no-match needs a case id typed in, since there is nothing
 * to pick from. Rejecting always requires a short reason, recorded on the
 * job for the audit trail. */
function ResolveRow({ job, resolving, onResolve }: { job: Hl7IngestionJob; resolving: boolean; onResolve: (decision: { action: "apply"; caseId: string } | { action: "reject"; reason: string }) => void }) {
    const [manualCaseId, setManualCaseId] = useState("");
    const [rejectReason, setRejectReason] = useState("");

    const applyTargets = job.matchStatus === "ambiguous" ? (job.candidateCaseIds ?? []) : job.matchedCaseId ? [job.matchedCaseId] : [];

    return (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
            {applyTargets.map((caseId) => (
                <Button key={caseId} size="sm" variant="outline" disabled={resolving} onClick={() => onResolve({ action: "apply", caseId })}>
                    Apply to case {caseId}
                </Button>
            ))}
            {applyTargets.length === 0 && (
                <div className="flex items-center gap-1.5">
                    <Input className="h-8 w-48 text-xs" placeholder="Case ID to apply to" value={manualCaseId} onChange={(e) => setManualCaseId(e.target.value)} />
                    <Button size="sm" variant="outline" disabled={resolving || !manualCaseId.trim()} onClick={() => onResolve({ action: "apply", caseId: manualCaseId.trim() })}>
                        Apply
                    </Button>
                </div>
            )}
            <div className="ml-auto flex items-center gap-1.5">
                <Input className="h-8 w-56 text-xs" placeholder="Rejection reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                <Button size="sm" variant="ghost" disabled={resolving || !rejectReason.trim()} onClick={() => onResolve({ action: "reject", reason: rejectReason.trim() })}>
                    Reject
                </Button>
            </div>
        </div>
    );
}

function JobCard({ job, resolving, onResolve }: { job: Hl7IngestionJob; resolving: boolean; onResolve: (decision: { action: "apply"; caseId: string } | { action: "reject"; reason: string }) => void }) {
    return (
        <div className="rounded-xl border border-border/70 bg-card p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-sm font-medium">
                        {job.messageType} · {job.patientIdentifierValue ?? "no patient identifier"}
                        {job.patientIdentifierIssuer ? ` (${job.patientIdentifierIssuer})` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        Received {formatRelativeTime(job.receivedAt)} · control id {job.messageControlId || "—"}
                        {job.observationsAdded ? ` · ${job.observationsAdded} observation(s) merged` : ""}
                    </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                    <StatusBadge tone={MATCH_TONE[job.matchStatus]}>{job.matchStatus}</StatusBadge>
                    <StatusBadge tone={STATUS_TONE[job.status]}>{job.status}</StatusBadge>
                </div>
            </div>
            {job.rejectionReason && <p className="mt-1.5 text-xs text-muted-foreground">Rejected: {job.rejectionReason}</p>}
            <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">Raw message</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">{job.rawMessage}</pre>
            </details>
            {job.status === "pending-review" && <ResolveRow job={job} resolving={resolving} onResolve={onResolve} />}
        </div>
    );
}

export default function Hl7Inbox() {
    const { t } = useI18n();
    const toast = useToast();
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [filter, setFilter] = useState<StatusFilter>("pending-review");
    const [jobs, setJobs] = useState<Hl7IngestionJob[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [resolvingJobId, setResolvingJobId] = useState<string | null>(null);

    const refresh = useCallback((): Promise<void> => {
        if (!hasApi) return Promise.resolve();
        return window.api.hl7
            .listJobs(filter === "all" ? undefined : filter)
            .then((next) => { setJobs(next); setError(null); })
            .catch((err: unknown) => setError((err as Error).message))
            .finally(() => setLoading(false));
    }, [hasApi, filter]);

    useEffect(() => { void refresh(); }, [refresh]);

    async function resolve(job: Hl7IngestionJob, decision: { action: "apply"; caseId: string } | { action: "reject"; reason: string }) {
        setResolvingJobId(job.id);
        try {
            await window.api.hl7.resolveJob(job.id, decision);
            toast.success(decision.action === "apply" ? `Applied to case ${decision.caseId}.` : "Message rejected.");
            await refresh();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setResolvingJobId(null);
        }
    }

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                HL7 Inbox is only available when running inside the Electron app.
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <Inbox className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{t.hl7Inbox}</span>
                <div className="ml-auto flex items-center gap-1.5">
                    {(["pending-review", "applied", "rejected", "all"] as const).map((f) => (
                        <Button key={f} size="sm" variant={filter === f ? "secondary" : "ghost"} onClick={() => setFilter(f)}>
                            {f === "all" ? "All" : f}
                        </Button>
                    ))}
                    <Button size="sm" variant="outline" onClick={() => { setLoading(true); void refresh(); }} disabled={loading}>
                        <RefreshCw className="size-3.5" />Refresh
                    </Button>
                </div>
            </div>

            <ScrollArea className="flex-1">
                <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
                    <InlineNotice variant="info" title="Inbound HL7 v2 patient matching">
                        Every inbound ORU/ADT message that didn't match exactly one existing case by patient identifier lands here for
                        human review — an ambiguous or absent match is never guessed automatically. See docs/HL7_V2_INTEGRATION.md.
                    </InlineNotice>

                    {error && <InlineNotice variant="destructive" title="Couldn't load the HL7 inbox">{error}</InlineNotice>}
                    {!error && !loading && jobs.length === 0 && (
                        <EmptyState icon={<AlertTriangle className="size-6" />} title="Nothing here" description={`No ${filter === "all" ? "" : filter + " "}HL7 ingestion jobs.`} />
                    )}
                    <div className="flex flex-col gap-2">
                        {jobs.map((job) => (
                            <JobCard key={job.id} job={job} resolving={resolvingJobId === job.id} onResolve={(decision) => void resolve(job, decision)} />
                        ))}
                    </div>
                </div>
            </ScrollArea>
        </div>
    );
}
