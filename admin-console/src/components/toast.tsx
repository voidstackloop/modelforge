/* eslint-disable react-refresh/only-export-components -- the provider and its
   hook are one inseparable unit; splitting them into separate files would be
   pure ceremony for a component this small. */
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastKind = "success" | "error" | "info";

interface Toast {
    id: number;
    kind: ToastKind;
    message: string;
}

const TOAST_DURATION_MS = 4000;

const ToastContext = createContext<((kind: ToastKind, message: string) => void) | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const nextId = useRef(1);

    const push = useCallback((kind: ToastKind, message: string) => {
        const id = nextId.current++;
        setToasts((prev) => [...prev, { id, kind, message }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_DURATION_MS);
    }, []);

    return (
        <ToastContext.Provider value={push}>
            {children}
            <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
                {toasts.map((toast) => (
                    <div
                        key={toast.id}
                        role="status"
                        className={cn(
                            "pointer-events-auto flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg",
                            "animate-in slide-in-from-bottom-2 fade-in bg-background",
                            toast.kind === "error" ? "border-destructive/50" : "border-border"
                        )}
                    >
                        {toast.kind === "success" && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />}
                        {toast.kind === "error" && <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                        {toast.kind === "info" && <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                        <span className="flex-1">{toast.message}</span>
                        <button
                            onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label="Dismiss notification"
                        >
                            <X className="size-3.5" />
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const push = useContext(ToastContext);
    return {
        success: (message: string) => push?.("success", message),
        error: (message: string) => push?.("error", message),
        info: (message: string) => push?.("info", message),
    };
}
