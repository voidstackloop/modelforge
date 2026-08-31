import { ScrollArea } from "@/components/ui/scroll-area";

export function MultiSelectChecklist({
    items,
    selected,
    onChange,
}: {
    items: { id: string; label: string }[];
    selected: string[];
    onChange: (next: string[]) => void;
}) {
    if (items.length === 0) {
        return <p className="text-xs text-muted-foreground">None exist yet in this organization.</p>;
    }
    return (
        <ScrollArea className="max-h-48 rounded-lg border border-border p-2">
            {items.map((item) => (
                <label key={item.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                    <input
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        onChange={(e) => onChange(e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
                    />
                    {item.label}
                </label>
            ))}
        </ScrollArea>
    );
}
