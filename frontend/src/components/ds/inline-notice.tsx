import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const ICON = {
    default: Info,
    info: Info,
    success: CheckCircle2,
    warning: AlertTriangle,
    destructive: XCircle,
} as const;

/** A persistent inline banner (as opposed to `components/toast.tsx`'s
 * transient floating notifications) — for warnings/errors/info that should
 * stay visible in the page flow, e.g. "checksum mismatch", "no GPU detected". */
export function InlineNotice({
    variant = "default",
    title,
    children,
    action,
    className,
}: {
    variant?: "default" | "info" | "success" | "warning" | "destructive";
    title?: ReactNode;
    children?: ReactNode;
    action?: ReactNode;
    className?: string;
}) {
    const Icon = ICON[variant];
    return (
        <Alert variant={variant} className={className}>
            <Icon />
            <div className="min-w-0 flex-1">
                {title && <AlertTitle>{title}</AlertTitle>}
                {children && <AlertDescription className={title ? "mt-0.5" : undefined}>{children}</AlertDescription>}
            </div>
            {action}
        </Alert>
    );
}
