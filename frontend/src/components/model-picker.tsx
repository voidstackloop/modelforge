import { useMemo, useState } from "react";
import { Bot, Check, Cloud, HardDrive, Plus, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { ProviderId } from "@/types/electron";

export type ModelPickerScope = "local" | "cloud";

export interface ModelPickerItem {
    ref: string;
    name: string;
    // Bytes on disk — known for local models (Ollama/llama.cpp/ROCm), absent
    // for cloud/custom ones since there's nothing local to size.
    sizeBytes?: number;
    // Marks the "Custom model ID..." row for a cloud provider — selecting it
    // doesn't pick a model directly, it opens the id-entry step below.
    customSentinelProvider?: ProviderId;
}

export interface ModelPickerGroup {
    key: string;
    label: string;
    items: ModelPickerItem[];
    // Which tab this group belongs to — local (Ollama/llama.cpp/MLX/ROCm/vLLM,
    // no API key, no per-token cost) vs. cloud (OpenAI/Anthropic/Gemini/custom
    // OpenAI-compatible endpoints). Splitting these into tabs keeps a long
    // local model list from burying the cloud providers below the fold.
    scope: ModelPickerScope;
}

export interface ModelPickerDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    currentModel: string;
    groups: ModelPickerGroup[];
    onSelectModel: (ref: string) => void;
    // Custom-model-id entry step (one cloud provider's "Custom model ID..."
    // row was picked) — owned by the caller since it's the same state Chat.tsx
    // already tracks for other reasons (e.g. surviving a session reload).
    pendingCustomProvider: ProviderId | null;
    customModelInput: string;
    onCustomModelInputChange: (value: string) => void;
    onConfirmCustomModel: () => void;
    onCancelCustomProvider: () => void;
    providerLabel: (provider: ProviderId) => string;
}

function formatSize(bytes?: number): string | null {
    if (!bytes || bytes <= 0) return null;
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export function ModelPickerDialog({
    open,
    onOpenChange,
    currentModel,
    groups,
    onSelectModel,
    pendingCustomProvider,
    customModelInput,
    onCustomModelInputChange,
    onConfirmCustomModel,
    onCancelCustomProvider,
    providerLabel,
}: ModelPickerDialogProps) {
    const [query, setQuery] = useState("");
    const defaultScope: ModelPickerScope =
        groups.find((group) => group.items.some((item) => item.ref === currentModel && !item.customSentinelProvider))?.scope ?? "local";
    const [scopeTab, setScopeTab] = useState<ModelPickerScope>(defaultScope);

    const groupsByScope = useMemo(() => {
        const q = query.trim().toLowerCase();
        const filtered = groups
            .map((group) =>
                q
                    ? {
                          ...group,
                          items: group.items.filter(
                              (item) => item.name.toLowerCase().includes(q) || group.label.toLowerCase().includes(q)
                          ),
                      }
                    : group
            )
            // An empty group (e.g. "Ollama (local)" with nothing installed
            // yet) reads as a dead-end heading with nothing under it —
            // dropped unconditionally, not just while a search is active.
            .filter((group) => group.items.length > 0);
        return {
            local: filtered.filter((group) => group.scope === "local"),
            cloud: filtered.filter((group) => group.scope === "cloud"),
        };
    }, [groups, query]);
    const modelCounts = {
        local: groupsByScope.local.reduce((count, group) => count + group.items.length, 0),
        cloud: groupsByScope.cloud.reduce((count, group) => count + group.items.length, 0),
    };

    function handleOpenChange(next: boolean) {
        if (!next) {
            setQuery("");
            setScopeTab(defaultScope);
            onCancelCustomProvider();
        }
        onOpenChange(next);
    }

    function selectItem(item: ModelPickerItem) {
        onSelectModel(item.ref);
        if (!item.customSentinelProvider) {
            setQuery("");
            onOpenChange(false);
        }
    }

    function confirmCustom() {
        onConfirmCustomModel();
        setQuery("");
        onOpenChange(false);
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="flex max-h-[min(90vh,44rem)] w-[calc(100%-1rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl sm:max-w-2xl">
                <DialogHeader className="border-b border-border/70 px-5 py-4 sm:px-6 sm:py-5">
                    <div className="flex items-start gap-3 pr-8">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            {pendingCustomProvider ? <Cloud className="size-5" /> : <Bot className="size-5" />}
                        </span>
                        <div className="min-w-0 space-y-1">
                            <DialogTitle className="text-lg">
                                {pendingCustomProvider ? "Enter a model ID" : "Choose your model"}
                            </DialogTitle>
                            <DialogDescription className="text-xs sm:text-sm">
                                {pendingCustomProvider
                                    ? `Connect to a model from ${providerLabel(pendingCustomProvider)} by its exact API identifier.`
                                    : "Search your local library and connected cloud providers."}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                {pendingCustomProvider ? (
                    <div className="flex flex-col gap-4 p-5 sm:p-6">
                        <p className="rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                            The exact model ID {providerLabel(pendingCustomProvider)} expects — this isn't validated
                            against a catalog, so a typo will only surface as a failed request.
                        </p>
                        <Input
                            autoFocus
                            value={customModelInput}
                            onChange={(e) => onCustomModelInputChange(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && confirmCustom()}
                            placeholder="exact model id..."
                            className="h-11 rounded-xl bg-background px-3 font-mono"
                        />
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={onCancelCustomProvider}>
                                Back
                            </Button>
                            <Button onClick={confirmCustom} disabled={!customModelInput.trim()}>
                                Use this model
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="relative px-5 pb-3 pt-4 sm:px-6">
                            <Search className="pointer-events-none absolute left-8 top-[calc(50%+0.125rem)] size-4 -translate-y-1/2 text-muted-foreground sm:left-9" />
                            <Input
                                autoFocus
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search models..."
                                aria-label="Search models"
                                className="h-11 rounded-xl border-border bg-muted/35 pl-10 pr-10 shadow-none focus-visible:bg-background"
                            />
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => setQuery("")}
                                    aria-label="Clear model search"
                                    className="absolute right-7 top-[calc(50%+0.125rem)] flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:right-8"
                                >
                                    <X className="size-3.5" />
                                </button>
                            )}
                        </div>
                        <Tabs value={scopeTab} onValueChange={(v) => setScopeTab(v as ModelPickerScope)} className="min-h-0 flex-1 gap-0 overflow-hidden">
                            <TabsList className="mx-5 mb-3 h-10 w-auto rounded-xl bg-muted/70 p-1 sm:mx-6">
                                <TabsTrigger value="local" className="gap-2 rounded-lg px-3">
                                    <HardDrive className="size-3.5" />
                                    <span>Local</span>
                                    <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                                        {modelCounts.local}
                                    </span>
                                </TabsTrigger>
                                <TabsTrigger value="cloud" className="gap-2 rounded-lg px-3">
                                    <Cloud className="size-3.5" />
                                    <span>Cloud</span>
                                    <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                                        {modelCounts.cloud}
                                    </span>
                                </TabsTrigger>
                            </TabsList>
                            {(["local", "cloud"] as const).map((scope) => (
                                <TabsContent key={scope} value={scope} className="min-h-0 flex-none">
                                    <ScrollArea className="h-[clamp(16rem,52vh,28rem)] px-3 sm:px-4">
                                        <div className="flex flex-col gap-4 px-1 pb-4">
                                            {groupsByScope[scope].length === 0 && (
                                                <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
                                                    <span className="flex size-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                                                        {scope === "local" ? <HardDrive className="size-5" /> : <Cloud className="size-5" />}
                                                    </span>
                                                    <div>
                                                        <p className="text-sm font-medium text-foreground">
                                                            {query ? "No matching models" : `No ${scope} models yet`}
                                                        </p>
                                                        <p className="mt-1 text-xs text-muted-foreground">
                                                            {query ? `Try another search instead of “${query}”.` : `Add a ${scope} model to see it here.`}
                                                        </p>
                                                    </div>
                                                </div>
                                            )}
                                            {groupsByScope[scope].map((group) => (
                                                <div key={group.key} className="flex flex-col gap-1">
                                                    <div className="sticky top-0 z-10 flex items-center justify-between bg-popover/95 px-2 py-2 backdrop-blur-sm">
                                                        <p className="section-eyebrow">{group.label}</p>
                                                        <span className="text-[10px] tabular-nums text-muted-foreground">
                                                            {group.items.length}
                                                        </span>
                                                    </div>
                                                    <div className="flex flex-col gap-1">
                                                        {group.items.map((item) => {
                                                            const size = formatSize(item.sizeBytes);
                                                            const active = item.ref === currentModel;
                                                            return (
                                                                <button
                                                                    key={item.ref}
                                                                    type="button"
                                                                    onClick={() => selectItem(item)}
                                                                    aria-pressed={active}
                                                                    className={cn(
                                                                        "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-[background-color,box-shadow] focus-visible:outline-offset-[-2px]",
                                                                        active
                                                                            ? "bg-primary/10 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_28%,transparent)]"
                                                                            : "hover:bg-muted/80"
                                                                    )}
                                                                >
                                                                    <span
                                                                        className={cn(
                                                                            "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                                                                            active
                                                                                ? "bg-primary text-primary-foreground"
                                                                                : "bg-muted text-muted-foreground group-hover:text-foreground"
                                                                        )}
                                                                    >
                                                                        {item.customSentinelProvider
                                                                            ? <Plus className="size-4" />
                                                                            : <Bot className="size-4" />}
                                                                    </span>
                                                                    <span className="min-w-0 flex-1">
                                                                        <span className="block truncate font-medium text-foreground">
                                                                            {item.name}
                                                                        </span>
                                                                        {active && (
                                                                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                                                                Currently selected
                                                                            </span>
                                                                        )}
                                                                    </span>
                                                                    {size && (
                                                                        <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
                                                                            {size}
                                                                        </span>
                                                                    )}
                                                                    {active && (
                                                                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                                                            <Check className="size-3.5" />
                                                                        </span>
                                                                    )}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </ScrollArea>
                                </TabsContent>
                            ))}
                            <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border/70 px-5 text-[11px] text-muted-foreground sm:px-6">
                                <span>
                                    {modelCounts[scopeTab]} {modelCounts[scopeTab] === 1 ? "model" : "models"} from {groupsByScope[scopeTab].length} {groupsByScope[scopeTab].length === 1 ? "source" : "sources"}
                                </span>
                                {modelCounts[scopeTab] > 6 && <span className="hidden sm:inline">Scroll to browse more</span>}
                            </div>
                        </Tabs>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
