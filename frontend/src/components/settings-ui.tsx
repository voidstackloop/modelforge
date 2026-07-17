import { cn } from "@/lib/utils";

export function SettingsSection({
    title,
    description,
    children,
    className,
}: {
    title: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section className={cn("mb-8 last:mb-0", className)}>
            <h2 className="text-sm font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
            <div className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
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
            <div className="flex flex-col gap-2 p-4">
                {label && <p className="text-sm font-medium">{label}</p>}
                {description && <p className="-mt-1 text-xs text-muted-foreground">{description}</p>}
                {children}
            </div>
        );
    }

    return (
        <div className="flex items-center justify-between gap-4 p-4">
            {label && (
                <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{label}</p>
                    {description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>}
                </div>
            )}
            <div className="flex shrink-0 items-center gap-2">{children}</div>
        </div>
    );
}
