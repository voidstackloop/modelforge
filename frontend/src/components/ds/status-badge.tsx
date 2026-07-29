import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";

const DOT_CLASS: Record<StatusTone, string> = {
    success: "bg-success",
    warning: "bg-warning",
    error: "bg-destructive",
    info: "bg-info",
    neutral: "bg-muted-foreground",
};

const BADGE_VARIANT: Record<StatusTone, "success" | "warning" | "destructive" | "info" | "secondary"> = {
    success: "success",
    warning: "warning",
    error: "destructive",
    info: "info",
    neutral: "secondary",
};

/** A semantic status pill with a color dot, so state is never conveyed by
 * color alone — the label text always carries the meaning too. Use for
 * "Recommended", "Healthy", "Drifted", "Does not fit", etc. across Settings,
 * Runtime Manager, and Download Center. */
export function StatusBadge({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
    return (
        <Badge variant={BADGE_VARIANT[tone]} className={cn("gap-1.5", className)}>
            <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])} aria-hidden="true" />
            {children}
        </Badge>
    );
}
