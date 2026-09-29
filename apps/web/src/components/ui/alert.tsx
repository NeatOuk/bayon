import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// CSS-grid layout (shadcn-style): drop an icon as a direct child and the alert
// auto-arranges into an icon column + a content column — no manual flex wrapper.
// `has-[>svg]` adds the icon column only when an icon is present. Soft chrome:
// thin border, rounded corners, a gentle elevation shadow.
const alertVariants = cva(
  cn(
    "group/alert relative grid w-full grid-cols-[0_1fr] items-start gap-y-1 rounded-lg border px-4 py-3 text-left text-sm shadow-xs",
    "has-[>svg]:grid-cols-[1.25rem_1fr] has-[>svg]:gap-x-3",
    "has-data-[slot=alert-action]:pr-14",
    "[&>svg]:size-5 [&>svg]:translate-y-0.5 [&>svg]:shrink-0",
  ),
  {
    variants: {
      // shadcn's variant axis (kept for API compatibility); `solid` is an inverted block.
      variant: {
        default:
          "border-border bg-card text-card-foreground *:data-[slot=alert-description]:text-muted-foreground",
        destructive:
          "border-danger/50 bg-danger-subtle text-foreground [&>svg]:text-danger *:data-[slot=alert-title]:text-danger *:data-[slot=alert-description]:text-foreground",
        solid:
          "border-transparent bg-foreground text-background *:data-[slot=alert-description]:text-background/80",
      },
      // The status axis callers use: each a real tone (theme.css) — its soft surface, a tone edge,
      // the title and icon in the tone, the description in the foreground (all 4.5:1, colours.test.ts).
      // Overrides the variant's colours when set.
      status: {
        error:
          "border-danger/50 bg-danger-subtle text-foreground [&>svg]:text-danger *:data-[slot=alert-title]:text-danger *:data-[slot=alert-description]:text-foreground",
        success:
          "border-success/50 bg-success-subtle text-foreground [&>svg]:text-success *:data-[slot=alert-title]:text-success *:data-[slot=alert-description]:text-foreground",
        warning:
          "border-warning/50 bg-warning-subtle text-foreground [&>svg]:text-warning *:data-[slot=alert-title]:text-warning *:data-[slot=alert-description]:text-foreground",
        info: "border-info/50 bg-info-subtle text-foreground [&>svg]:text-info *:data-[slot=alert-title]:text-info *:data-[slot=alert-description]:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/**
 * `role` is `alert` unless the caller says otherwise: `status` for news that should not
 * interrupt, `note` for a standing notice that is not news at all.
 */
function Alert({
  className,
  variant,
  status,
  role = "alert",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role={role}
      className={cn(alertVariants({ variant, status }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 min-h-5 font-head text-sm leading-5 font-semibold [&_a]:underline [&_a]:underline-offset-3",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p]:leading-relaxed [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction, alertVariants };
