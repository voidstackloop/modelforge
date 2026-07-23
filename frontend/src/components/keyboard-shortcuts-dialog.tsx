import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";

function Shortcut({ label, keys }: { label: string; keys: string[] }) {
    return (
        <div className="flex items-center justify-between gap-4 py-1.5">
            <span className="text-sm text-muted-foreground">{label}</span>
            <div className="flex gap-1">
                {keys.map((k, i) => (
                    <kbd
                        key={i}
                        className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                    >
                        {k}
                    </kbd>
                ))}
            </div>
        </div>
    );
}

export function KeyboardShortcutsDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { t } = useI18n();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t.keyboardShortcuts}</DialogTitle>
                    <DialogDescription>{t.keyboardShortcutsHelp}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col divide-y divide-border">
                    <Shortcut label={t.shortcutCommandPalette} keys={[mod, "K"]} />
                    <Shortcut label={t.shortcutNewChat} keys={[mod, "N"]} />
                    <Shortcut label={t.shortcutSettings} keys={[mod, ","]} />
                    <Shortcut label={t.shortcutShowShortcuts} keys={[mod, "/"]} />
                    <Shortcut label={t.shortcutSend} keys={["Enter"]} />
                    <Shortcut label={t.shortcutNewline} keys={["Shift", "Enter"]} />
                    <Shortcut label={t.shortcutStopGenerating} keys={["Esc"]} />
                </div>
            </DialogContent>
        </Dialog>
    );
}
