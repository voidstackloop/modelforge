import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Cpu, Cloud, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type OnboardingProvider = "llamacpp" | "openai" | "anthropic" | "gemini";

const CLOUD_KEY_INFO: Record<Exclude<OnboardingProvider, "llamacpp">, { secretKey: string; placeholder: string }> = {
    openai: { secretKey: "openai_api_key", placeholder: "sk-..." },
    anthropic: { secretKey: "anthropic_api_key", placeholder: "sk-ant-..." },
    gemini: { secretKey: "gemini_api_key", placeholder: "AIza..." },
};

export function OnboardingWizard({ open, onDone }: { open: boolean; onDone: () => void }) {
    const { t } = useI18n();
    const [selected, setSelected] = useState<OnboardingProvider | null>(null);
    const [keyInput, setKeyInput] = useState("");
    const [saved, setSaved] = useState(false);

    function selectProvider(provider: OnboardingProvider) {
        setSelected(provider);
        setKeyInput("");
        setSaved(false);
    }

    async function finish() {
        await window.api.settings.save({ onboardingComplete: true });
        onDone();
    }

    async function saveKeyAndFinish() {
        if (selected && selected !== "llamacpp" && keyInput.trim()) {
            await window.api.secrets.set(CLOUD_KEY_INFO[selected].secretKey, keyInput.trim());
            setSaved(true);
        }
        await finish();
    }

    const options: { id: OnboardingProvider; label: string; description: string; icon: React.ReactNode }[] = [
        { id: "llamacpp", label: t.onboardingLlamaCpp, description: t.onboardingLlamaCppDesc, icon: <Cpu className="size-5" /> },
        { id: "openai", label: "ChatGPT (OpenAI)", description: t.onboardingCloudDesc, icon: <Cloud className="size-5" /> },
        { id: "anthropic", label: "Claude (Anthropic)", description: t.onboardingCloudDesc, icon: <Cloud className="size-5" /> },
        { id: "gemini", label: "Gemini (Google)", description: t.onboardingCloudDesc, icon: <Cloud className="size-5" /> },
    ];

    const isCloud = selected && selected !== "llamacpp";

    return (
        <Dialog open={open} onOpenChange={(o) => !o && finish()}>
            <DialogContent className="max-w-md" showCloseButton={false}>
                <DialogHeader>
                    <DialogTitle>{t.onboardingTitle}</DialogTitle>
                    <DialogDescription>{t.onboardingSubtitle}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                    {options.map((o) => (
                        <button
                            key={o.id}
                            onClick={() => selectProvider(o.id)}
                            className={cn(
                                "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                                selected === o.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                            )}
                        >
                            <span className="text-muted-foreground">{o.icon}</span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium">{o.label}</span>
                                <span className="block text-xs text-muted-foreground">{o.description}</span>
                            </span>
                            {selected === o.id && <Check className="size-4 shrink-0 text-primary" />}
                        </button>
                    ))}
                </div>

                {isCloud && (
                    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                        <label className="text-xs text-muted-foreground">{t.onboardingKeyLabel}</label>
                        <Input
                            type="password"
                            value={keyInput}
                            onChange={(e) => setKeyInput(e.target.value)}
                            placeholder={CLOUD_KEY_INFO[selected].placeholder}
                            autoFocus
                        />
                        <p className="text-xs text-muted-foreground">{t.onboardingKeyHint}</p>
                    </div>
                )}

                <div className="flex items-center justify-between">
                    <button onClick={finish} className="text-xs text-muted-foreground hover:text-foreground">
                        {t.onboardingSkip}
                    </button>
                    {selected && (
                        <Button
                            size="sm"
                            onClick={isCloud ? saveKeyAndFinish : finish}
                            disabled={isCloud ? !keyInput.trim() || saved : false}
                        >
                            {t.onboardingContinue}
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
