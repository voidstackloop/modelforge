import { useEffect, useState } from "react";
import { BookOpen, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { EmptyState, InlineNotice } from "@/components/ds";
import { useI18n } from "@/lib/i18n";
import type { EvidenceSource } from "@/types/electron";

const SOURCE_TYPE_LABEL: Record<EvidenceSource["sourceType"], string> = {
    "peer-reviewed": "Peer-reviewed",
    guideline: "Guideline",
    "reference-database": "Reference database",
    "local-document": "Local document",
    other: "Other / unclassified",
};

export default function EvidenceLibrary() {
    const { t } = useI18n();
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [sources, setSources] = useState<EvidenceSource[]>([]);
    const [url, setUrl] = useState("");
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function refresh() {
        if (!hasApi) return;
        window.api.evidence.list().then(setSources);
    }

    useEffect(refresh, [hasApi]);

    async function handleAdd() {
        const value = url.trim();
        if (!value) return;
        setAdding(true);
        setError(null);
        try {
            const { source, error: err } = await window.api.evidence.addFromUrl(value);
            if (err) {
                setError(err);
            } else if (source) {
                setUrl("");
                refresh();
            }
        } finally {
            setAdding(false);
        }
    }

    async function handleDelete(id: string) {
        await window.api.evidence.delete(id);
        refresh();
    }

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Evidence Library is only available when running inside the Electron app.
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <BookOpen className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{t.evidenceLibrary}</span>
            </div>

            <ScrollArea className="flex-1">
                <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
                    <InlineNotice variant="info" title="What this is">
                        Add a URL to a guideline, paper, or reference page you trust. ModelForge Medical fetches
                        only the page's own title and description — it never invents a title, author, or date it
                        couldn't find on the page. Nothing here is fetched automatically or without your action.
                    </InlineNotice>

                    <div className="flex gap-2">
                        <Input
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                            placeholder="https://www.who.int/... or any guideline/paper URL"
                            aria-label="Evidence source URL"
                        />
                        <Button onClick={handleAdd} disabled={!url.trim() || adding} className="shrink-0 gap-1.5">
                            <Plus className="size-4" /> Add source
                        </Button>
                    </div>
                    {error && (
                        <InlineNotice variant="destructive" title="Couldn't add this source">
                            {error}
                        </InlineNotice>
                    )}

                    {sources.length === 0 ? (
                        <EmptyState
                            icon={<BookOpen className="size-5" />}
                            title="No evidence sources yet"
                            description="Sources you add here can be cited in Clinical Assistant answers with a verified marker."
                        />
                    ) : (
                        <div className="flex flex-col gap-2">
                            {sources.map((s) => (
                                <div key={s.id} className="rounded-xl border border-border/70 bg-card p-3.5">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <a
                                                href={s.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="flex items-center gap-1.5 truncate text-sm font-medium hover:underline"
                                            >
                                                {s.title} <ExternalLink className="size-3 shrink-0" />
                                            </a>
                                            <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.url}</p>
                                        </div>
                                        <button
                                            onClick={() => handleDelete(s.id)}
                                            aria-label={`Remove ${s.title}`}
                                            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </button>
                                    </div>
                                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                        <Badge variant="secondary">{SOURCE_TYPE_LABEL[s.sourceType]}</Badge>
                                        {s.organization && <Badge variant="secondary">{s.organization}</Badge>}
                                        <span className="text-[11px] text-muted-foreground">
                                            Retrieved {new Date(s.retrievedAt).toLocaleDateString()}
                                        </span>
                                    </div>
                                    {s.excerpt && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.excerpt}</p>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
