import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Formalizes the `.section-eyebrow` small-caps label pattern already used
 * ad hoc across the app into one component, with an optional trailing action
 * (e.g. a "Refresh" or "Manage" link) and description line. */
export function SectionHeader({
    title,
    description,
    action,
    className,
}: {
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("mb-2 flex items-center justify-between gap-3", className)}>
            <div>
                <p className="section-eyebrow">{title}</p>
                {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
            </div>
            {action}
        </div>
    );
}
