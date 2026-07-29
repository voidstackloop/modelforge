import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Consistent page-level heading used at the top of every route: title, an
 * optional one-line description, and a slot for page-level actions on the
 * right (kept on one row on desktop, wrapping below the title on narrow
 * widths so controls never clip). */
export function PageHeader({
    title,
    description,
    actions,
    icon,
    className,
}: {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    icon?: ReactNode;
    className?: string;
}) {
    return (
        <header className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
            <div className="flex min-w-0 items-start gap-3">
                {icon && <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{icon}</div>}
                <div className="min-w-0">
                    <h1 className="truncate text-lg font-semibold tracking-[-0.02em]">{title}</h1>
                    {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
                </div>
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
    );
}
