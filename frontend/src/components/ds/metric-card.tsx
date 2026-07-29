import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const TONE_CLASS = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning-foreground dark:text-warning",
    destructive: "text-destructive",
} as const;

/** A compact KPI tile: label, a large value, and an optional hint/delta line.
 * Used for the Usage dashboard's KPI row and similar at-a-glance stat rows. */
export function MetricCard({
    label,
    value,
    hint,
    icon,
    tone = "default",
    className,
}: {
    label: ReactNode;
    value: ReactNode;
    hint?: ReactNode;
    icon?: ReactNode;
    tone?: keyof typeof TONE_CLASS;
    className?: string;
}) {
    const toneClass = TONE_CLASS[tone];
    return (
        <div className={cn("flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4", className)}>
            <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                {icon && <div className="text-muted-foreground">{icon}</div>}
            </div>
            <p className={cn("text-2xl font-semibold tracking-[-0.02em] tabular-nums", toneClass)}>{value}</p>
            {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
        </div>
    );
}
