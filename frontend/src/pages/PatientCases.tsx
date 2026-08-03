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
import type { PatientCase } from "@/types/electron";

export default function PatientCases() {
    const { t } = useI18n();
    const navigate = useNavigate();
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [cases, setCases] = useState<PatientCase[]>([]);
    const [newTitle, setNewTitle] = useState("");
    const [creating, setCreating] = useState(false);
    const [locked, setLocked] = useState(false);

    function refresh() {
        if (!hasApi) return;
        window.api.encryption.status().then((status) => {
            if (status.enabled && !status.unlocked) {
                setLocked(true);
                return;
            }
            setLocked(false);
            window.api.patientCases.list().then(setCases).catch(() => setLocked(true));
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

    async function handleDelete(e: React.MouseEvent, id: string) {
        e.stopPropagation();
        if (!confirm("Delete this patient case? This cannot be undone.")) return;
        await window.api.patientCases.delete(id);
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
                                        onClick={(e) => handleDelete(e, c.id)}
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
