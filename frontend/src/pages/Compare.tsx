import { useEffect, useState } from "react";
import { Send, Loader2, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from "@/components/markdown";
import { useI18n } from "@/lib/i18n";
import { OPENAI_MODELS, ANTHROPIC_MODELS, formatModelRef, parseModelRef } from "@/lib/providers";
import { estimateCost, formatCost } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import type { OllamaModel, LocalGgufModel, UsageInfo, ChatChunk } from "@/types/electron";

interface CandidateModel {
    ref: string;
    label: string;
}

interface CompareResult {
    content: string;
    usage?: UsageInfo;
    error?: string;
    streaming: boolean;
}

export default function Compare() {
    const { t } = useI18n();
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
    const [llamaCppModels, setLlamaCppModels] = useState<LocalGgufModel[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [prompt, setPrompt] = useState("");
    const [results, setResults] = useState<Record<string, CompareResult>>({});
    const [running, setRunning] = useState(false);

    useEffect(() => {
        if (!hasApi) return;
        window.api.ollama.listModels().then(setOllamaModels);
        window.api.llamacpp.listModels().then(setLlamaCppModels);
    }, [hasApi]);

    const candidates: CandidateModel[] = [
        ...ollamaModels.map((m) => ({ ref: formatModelRef("ollama", m.name), label: `${m.name} (Ollama)` })),
        ...llamaCppModels.map((m) => ({ ref: formatModelRef("llamacpp", m.name), label: `${m.name} (llama.cpp)` })),
        ...OPENAI_MODELS.map((m) => ({ ref: formatModelRef("openai", m.id), label: m.label })),
        ...ANTHROPIC_MODELS.map((m) => ({ ref: formatModelRef("anthropic", m.id), label: m.label })),
    ];

    function toggleModel(ref: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(ref)) next.delete(ref);
            else next.add(ref);
            return next;
        });
    }

    async function runComparison() {
        const text = prompt.trim();
        if (!text || selected.size === 0 || running) return;
        setRunning(true);
        const refs = [...selected];
        setResults(Object.fromEntries(refs.map((ref) => [ref, { content: "", streaming: true }])));

        await Promise.all(
            refs.map(async (ref) => {
                const parsed = parseModelRef(ref);
                if (!parsed) return;
                const { promise } = window.api.chat.send(
                    parsed.provider,
                    parsed.modelId,
                    [{ role: "user", content: text }],
                    {},
                    (chunk: ChatChunk) => {
                        setResults((prev) => {
                            const current = prev[ref] ?? { content: "", streaming: true };
                            return {
                                ...prev,
                                [ref]: {
                                    ...current,
                                    content: current.content + (chunk.message?.content ?? ""),
                                    usage: chunk.usage ?? current.usage,
                                },
                            };
                        });
                    }
                );
                const result = await promise;
                setResults((prev) => ({
                    ...prev,
                    [ref]: { ...(prev[ref] ?? { content: "" }), streaming: false, error: result.error },
                }));
            })
        );
        setRunning(false);
    }

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Compare is only available when running inside the Electron app.
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <Scale className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{t.compareModels}</span>
            </div>

            <div className="flex flex-wrap gap-1.5 border-b border-border p-3">
                {candidates.length === 0 && (
                    <span className="text-xs text-muted-foreground">{t.noModelsAvailable}</span>
                )}
                {candidates.map((c) => (
                    <button
                        key={c.ref}
                        onClick={() => toggleModel(c.ref)}
                        className={cn(
                            "rounded-full border px-2.5 py-1 text-xs transition-colors",
                            selected.has(c.ref)
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-muted text-muted-foreground hover:bg-muted/70"
                        )}
                    >
                        {c.label}
                    </button>
                ))}
            </div>

            <ScrollArea className="flex-1">
                <div
                    className="grid gap-4 p-4"
                    style={{ gridTemplateColumns: `repeat(${Math.max(1, selected.size)}, minmax(280px, 1fr))` }}
                >
                    {[...selected].map((ref) => {
                        const result = results[ref];
                        const candidate = candidates.find((c) => c.ref === ref);
                        const parsed = parseModelRef(ref);
                        const cost =
                            parsed && result?.usage
                                ? estimateCost(parsed.modelId, result.usage.promptTokens, result.usage.completionTokens)
                                : null;
                        return (
                            <div key={ref} className="flex flex-col rounded-lg border border-border">
                                <div className="border-b border-border px-3 py-2 text-xs font-medium">
                                    {candidate?.label ?? ref}
                                </div>
                                <div className="flex-1 p-3 text-sm">
                                    {result?.error ? (
                                        <p className="text-destructive">{result.error}</p>
                                    ) : result?.content ? (
                                        <Markdown content={result.content} />
                                    ) : result?.streaming ? (
                                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                                    ) : (
                                        <p className="text-muted-foreground">{t.compareRunToSee}</p>
                                    )}
                                </div>
                                {result?.usage && !result.streaming && (
                                    <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                                        {(result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0)} tokens
                                        {cost !== null ? ` · ~${formatCost(cost)}` : ""}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </ScrollArea>

            <div className="border-t border-border p-4">
                <div className="mx-auto flex max-w-3xl items-end gap-2">
                    <Textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder={t.compareSamePrompt}
                        className="min-h-16 flex-1"
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                runComparison();
                            }
                        }}
                    />
                    <Button
                        onClick={runComparison}
                        disabled={running || !prompt.trim() || selected.size === 0}
                        className="gap-1.5"
                    >
                        {running ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                        {t.compareRun}
                    </Button>
                </div>
            </div>
        </div>
    );
}
