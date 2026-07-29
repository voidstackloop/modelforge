import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative flex w-full gap-2.5 rounded-xl border px-3.5 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-foreground [&>svg]:text-muted-foreground",
        info: "border-info/25 bg-info/10 text-foreground [&>svg]:text-info",
        success: "border-success/25 bg-success/10 text-foreground [&>svg]:text-success",
        warning: "border-warning/30 bg-warning/10 text-foreground [&>svg]:text-warning",
        destructive: "border-destructive/25 bg-destructive/10 text-foreground [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div data-slot="alert" role="status" className={cn(alertVariants({ variant }), className)} {...props} />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="alert-title" className={cn("text-sm leading-tight font-medium", className)} {...props} />
}

function AlertDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p data-slot="alert-description" className={cn("text-xs leading-relaxed text-muted-foreground", className)} {...props} />
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- shadcn convention: variants exported alongside the component
export { Alert, AlertDescription, AlertTitle, alertVariants }
