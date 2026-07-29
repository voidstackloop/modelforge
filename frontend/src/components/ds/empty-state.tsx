import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Shared empty-state layout: icon, short title, one-line description, and
 * an optional action — replaces the hand-rolled "No chats yet." style
 * paragraphs duplicated across the app. */
export function EmptyState({
    icon,
    title,
    description,
    action,
    className,
}: {
    icon?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
            {icon && <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div>}
            <p className="text-sm font-medium">{title}</p>
            {description && <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>}
            {action && <div className="mt-2">{action}</div>}
        </div>
    );
}
