import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ProviderId } from "@/types/electron";

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

    const filteredGroups = useMemo(() => {
        const q = query.trim().toLowerCase();
        return groups
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
    }, [groups, query]);

    function handleOpenChange(next: boolean) {
        if (!next) {
            setQuery("");
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
            <DialogContent className="flex max-h-[80vh] max-w-xl flex-col gap-3 p-0 sm:max-w-xl">
                <DialogHeader className="px-4 pt-4">
                    <DialogTitle>{pendingCustomProvider ? "Enter a model ID" : "Select a model"}</DialogTitle>
                </DialogHeader>

                {pendingCustomProvider ? (
                    <div className="flex flex-col gap-3 px-4 pb-4">
                        <p className="text-xs text-muted-foreground">
                            The exact model ID {providerLabel(pendingCustomProvider)} expects — this isn't validated
                            against a catalog, so a typo will only surface as a failed request.
                        </p>
                        <Input
                            autoFocus
                            value={customModelInput}
                            onChange={(e) => onCustomModelInputChange(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && confirmCustom()}
                            placeholder="exact model id..."
                        />
                        <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={onCancelCustomProvider}>
                                Back
                            </Button>
                            <Button size="sm" onClick={confirmCustom} disabled={!customModelInput.trim()}>
                                Use this model
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="relative px-4">
                            <Search className="pointer-events-none absolute left-6 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                autoFocus
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search models..."
                                aria-label="Search models"
                                className="pl-8"
                            />
                        </div>
                        <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
                            <div className="flex flex-col gap-4">
                                {filteredGroups.length === 0 && (
                                    <p className="py-8 text-center text-sm text-muted-foreground">
                                        No models match &ldquo;{query}&rdquo;.
                                    </p>
                                )}
                                {filteredGroups.map((group) => (
                                    <div key={group.key} className="flex flex-col gap-1">
                                        <p className="section-eyebrow px-1">{group.label}</p>
                                        <div className="flex flex-col gap-0.5">
                                            {group.items.map((item) => {
                                                const size = formatSize(item.sizeBytes);
                                                const active = item.ref === currentModel;
                                                return (
                                                    <button
                                                        key={item.ref}
                                                        onClick={() => selectItem(item)}
                                                        className={cn(
                                                            "flex items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                                                            active && "border-primary/25 bg-primary/8"
                                                        )}
                                                    >
                                                        <span className="min-w-0 flex-1 truncate font-medium">
                                                            {item.name}
                                                        </span>
                                                        {size && (
                                                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                                                {size}
                                                            </span>
                                                        )}
                                                        {active && <Check className="size-3.5 shrink-0 text-primary" />}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </ScrollArea>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
