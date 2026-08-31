import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardList, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState, InlineNotice } from "@/components/ds";
import { CaseLockScreen } from "@/components/case-lock-screen";
import { CASE_LOCKED_EVENT } from "@/lib/case-auto-lock";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/format-time";
import { useToast } from "@/components/toast";
import type { PatientCase, SyncStatus } from "@/types/electron";

export default function PatientCases() {
    const { t } = useI18n();
    const toast = useToast();
    const navigate = useNavigate();
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [cases, setCases] = useState<PatientCase[]>([]);
    const [newTitle, setNewTitle] = useState("");
    const [creating, setCreating] = useState(false);
    const [locked, setLocked] = useState(false);
    // Distinct from `locked`: encryption.status() is a direct, synchronous
    // fact ("is this device's local store unlocked"), while patientCases.list()
    // can fail for a completely different reason once a shared/networked
    // backend is configured — connectivity, an unreachable server, an
    // expired token (see app/src/patient-cases-store.ts's
    // SharedBackendUnavailableError doc comment: "'no cases' and 'couldn't
    // reach the server' must never look the same to a clinician"). Treating
    // that failure as "locked" would show a passphrase-entry screen for a
    // problem no passphrase can fix.
    const [loadError, setLoadError] = useState<string | null>(null);
    // P1 item 5 (app/src/case-offline-cache.ts) — null (not an empty
    // status) while unfetched, so the banner never flashes "0 pending"
    // before the real count is known.
    const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

    function refresh() {
        if (!hasApi) return;
        window.api.encryption.status().then((status) => {
            if (status.enabled && !status.unlocked) {
                setLocked(true);
                return;
            }
            setLocked(false);
            window.api.patientCases
                .list()
                .then((list) => {
                    setLoadError(null);
                    setCases(list);
                })
                .catch((err) => setLoadError((err as Error).message));
            window.api.patientCases.getSyncStatus().then(setSyncStatus);
        });
    }

    useEffect(refresh, [hasApi]);

    useEffect(() => {
        window.addEventListener(CASE_LOCKED_EVENT, refresh);
        return () => window.removeEventListener(CASE_LOCKED_EVENT, refresh);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function handleCreate() {
        const title = newTitle.trim();
        if (!title) return;
        setCreating(true);
        try {
            const created = await window.api.patientCases.create(title);
            setNewTitle("");
            navigate(`/cases/${created.id}`);
        } finally {
            setCreating(false);
        }
    }

    async function handleDelete(e: React.MouseEvent, id: string, version?: string) {
        e.stopPropagation();
        if (!confirm("Delete this patient case? This cannot be undone.")) return;
        try {
            // version: what this list row last showed — same optimistic-
            // concurrency contract as PatientCaseDetail.tsx's edits, so a
            // delete from this list surfaces a conflict too, rather than
            // deleting whatever the server currently has under this id.
            await window.api.patientCases.delete(id, version ?? null);
        } catch (err) {
            toast.error((err as Error).message);
        }
        refresh();
    }

    // Discards the queued edit that conflicted — the server's current copy
    // stays authoritative and untouched either way. Never an automatic
    // merge (see docs/SHARED_BACKEND_DESIGN.md §5): if the clinician still
    // wants their change, they reapply it as a fresh, normal edit after
    // reviewing what the case looks like now.
    async function handleDiscardConflict(caseId: string, idempotencyKey: string) {
        const title = cases.find((c) => c.id === caseId)?.title ?? "this case";
        if (!confirm(`Discard your unsynced change to "${title}"? The version currently on the server will remain as-is.`)) return;
        await window.api.patientCases.discardSyncConflict(idempotencyKey);
        refresh();
    }

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Patient Cases is only available when running inside the Electron app.
            </div>
        );
    }

    if (locked) {
        return <CaseLockScreen onUnlocked={refresh} />;
    }

    if (loadError) {
        return (
            <div className="flex h-full items-center justify-center p-8">
                <InlineNotice
                    variant="destructive"
                    title="Couldn't load patient cases"
                    action={
                        <Button variant="outline" size="sm" onClick={refresh} className="shrink-0">
                            Retry
                        </Button>
                    }
                >
                    {loadError}
                </InlineNotice>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <ClipboardList className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{t.patientCases}</span>
            </div>

            <ScrollArea className="flex-1">
                <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
                    <InlineNotice variant="info" title="Structured case workspace">
                        Cases are stored locally on this device. You choose exactly which fields are sent to a
                        model, per request, from the case detail page — nothing is included by default.
                    </InlineNotice>

                    {syncStatus && syncStatus.conflicts.length > 0 && (
                        <InlineNotice variant="destructive" title={`${syncStatus.conflicts.length} case(s) have a sync conflict`}>
                            <div className="flex flex-col gap-2">
                                <p>
                                    Someone else changed these cases on the shared backend before your offline edit could sync. Your edit was
                                    never applied — review the case as it stands now, then reapply your change if it still applies.
                                </p>
                                <ul className="flex flex-col gap-1">
                                    {syncStatus.conflicts.map((c) => (
                                        <li key={c.idempotencyKey} className="flex items-center justify-between gap-2 text-xs">
                                            <span className="truncate">{cases.find((x) => x.id === c.caseId)?.title ?? c.caseId}</span>
                                            <div className="flex shrink-0 gap-2">
                                                <Button variant="outline" size="sm" onClick={() => navigate(`/cases/${c.caseId}`)}>
                                                    View case
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={() => void handleDiscardConflict(c.caseId, c.idempotencyKey)}>
                                                    Discard my edit
                                                </Button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </InlineNotice>
                    )}
                    {syncStatus && syncStatus.conflicts.length === 0 && syncStatus.pendingCount > 0 && (
                        <InlineNotice variant="warning" title={`${syncStatus.pendingCount} case(s) have unsynced changes`}>
                            Saved on this device — they'll sync to the shared backend automatically once you're back online.
                        </InlineNotice>
                    )}

                    <div className="flex gap-2">
                        <Input
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                            placeholder='e.g. "Synthetic case — chest pain workup"'
                            aria-label={t.newCase}
                        />
                        <Button onClick={handleCreate} disabled={!newTitle.trim() || creating} className="shrink-0 gap-1.5">
                            <Plus className="size-4" /> {t.newCase}
                        </Button>
                    </div>

                    {cases.length === 0 ? (
                        <EmptyState
                            icon={<ClipboardList className="size-5" />}
                            title={t.noCasesYet}
                            description="Create a case to track structured clinical fields and control what's shared with the model."
                        />
                    ) : (
                        <div className="flex flex-col gap-1.5">
                            {cases.map((c) => (
                                <button
                                    key={c.id}
                                    onClick={() => navigate(`/cases/${c.id}`)}
                                    className="group flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-card px-3.5 py-3 text-left text-sm transition-colors hover:border-primary/30 hover:bg-primary/5"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate font-medium">{c.title}</p>
                                        <p className="text-xs text-muted-foreground">Updated {formatRelativeTime(c.updatedAt)}</p>
                                    </div>
                                    <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => handleDelete(e, c.id, c.version)}
                                        aria-label={`${t.deleteCase}: ${c.title}`}
                                        className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 hover:bg-background hover:text-destructive group-hover:opacity-100"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
