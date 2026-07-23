import { cn } from "@/lib/utils";

export function SettingsSection({
    title,
    description,
    children,
    className,
    action,
}: {
    title: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
    action?: React.ReactNode;
}) {
    return (
        <section className={cn("mb-10 last:mb-0", className)}>
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold tracking-tight">{title}</h2>
                    {description && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{description}</p>}
                </div>
                {action}
            </div>
            <div className="surface-glass shadow-soft mt-4 divide-y divide-border/70 overflow-hidden rounded-2xl border border-border/80">
                {children}
            </div>
        </section>
    );
}

export function SettingsRow({
    label,
    description,
    stacked,
    children,
}: {
    label?: string;
    description?: string;
    stacked?: boolean;
    children: React.ReactNode;
}) {
    if (stacked) {
        return (
            <div className="flex flex-col gap-2.5 p-5 transition-colors hover:bg-muted/20">
                {label && <p className="text-sm font-medium">{label}</p>}
                {description && <p className="-mt-1 text-xs text-muted-foreground">{description}</p>}
                {children}
            </div>
        );
    }

    return (
        <div className="flex items-center justify-between gap-5 p-5 transition-colors hover:bg-muted/20 max-sm:flex-col max-sm:items-stretch">
            {label && (
                <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{label}</p>
                    {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
                </div>
            )}
            <div className="flex shrink-0 items-center gap-2 max-sm:justify-start">{children}</div>
        </div>
    );
}
