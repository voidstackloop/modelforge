import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Shown in place of Patient Cases content whenever case-encryption is
 * enabled but locked (fresh app start, or after the inactivity auto-lock) —
 * unlocking here is the same passphrase check Settings → Audit & Privacy
 * uses, just surfaced where the user actually hit the wall. */
export function CaseLockScreen({ onUnlocked }: { onUnlocked: () => void }) {
    const [passphrase, setPassphrase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const res = await window.api.encryption.unlock(passphrase);
            if (res.success) {
                setPassphrase("");
                onUnlocked();
            } else {
                setError("Incorrect passphrase.");
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted text-muted-foreground">
                <Lock className="size-5" />
            </div>
            <div>
                <p className="text-sm font-medium">Patient case data is locked</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                    Enter the passphrase to unlock — this is the same encryption managed in Settings → Audit &amp;
                    Privacy.
                </p>
            </div>
            <div className="flex w-full max-w-xs gap-2">
                <Input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    placeholder="Passphrase"
                    aria-label="Passphrase"
                    autoFocus
                    className="h-8 text-xs"
                />
                <Button size="sm" onClick={submit} disabled={busy || !passphrase}>
                    Unlock
                </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
    );
}
