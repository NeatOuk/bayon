import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-2 py-0.5 text-xs font-head font-medium whitespace-nowrap shadow-xs transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-danger [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive text-destructive-foreground [a]:hover:bg-destructive/90",
        // Status tones (theme.css): green means success and nothing else, so "it passed" is this,
        // never the blue default.
        success: "bg-success text-success-foreground [a]:hover:bg-success/90",
        warning: "bg-warning text-warning-foreground [a]:hover:bg-warning/90",
        info: "bg-info text-info-foreground [a]:hover:bg-info/90",
        outline:
          "bg-transparent text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "border-transparent bg-transparent shadow-none hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "border-transparent bg-transparent shadow-none text-primary underline-offset-4 hover:underline",
      },
      // The soft status tones StatusBadge renders (status.ts): the tone's subtle surface, the tone as
      // text and edge (4.5:1 in both themes, colours.test.ts). Overrides the variant's colours.
      tone: {
        success: "border-success/40 bg-success-subtle text-success",
        warning: "border-warning/40 bg-warning-subtle text-warning",
        danger: "border-danger/40 bg-danger-subtle text-danger",
        info: "border-info/40 bg-info-subtle text-info",
        neutral: "border-border bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  tone,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, tone }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
