import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Heights are fixed, not padding-made, so a button lines up with an input, a select or a toggle of
// the same size: h-9 default, h-8 sm, h-7 xs, h-10 lg; icon sizes are squares of the same. Every
// variant carries a border (transparent where it shows none), so no variant is taller than another.
// Disabled keeps pointer events, so its not-allowed cursor shows; its hovers are `not-disabled:`.
const buttonVariants = cva(
  cn(
    "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border font-head text-sm font-medium whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,filter] duration-150",
    "disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring aria-invalid:border-danger",
    // Icons keep their own size; we only set a default when none is given.
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-xs hover:not-disabled:bg-primary-hover hover:not-disabled:shadow-sm active:not-disabled:shadow-none",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground shadow-xs hover:not-disabled:bg-secondary-hover active:not-disabled:shadow-none",
        destructive:
          "border-transparent bg-danger text-danger-foreground shadow-xs hover:not-disabled:bg-danger/90 hover:not-disabled:shadow-sm active:not-disabled:shadow-none",
        outline:
          "border-border bg-card text-foreground shadow-xs hover:not-disabled:bg-accent active:not-disabled:shadow-none",
        ghost: "border-transparent bg-transparent hover:not-disabled:bg-accent",
        link: "border-transparent bg-transparent underline-offset-4 hover:not-disabled:underline",
      },
      size: {
        default: "h-9 px-4",
        xs: "h-7 gap-1 px-2.5 text-xs",
        sm: "h-8 gap-1.5 px-3",
        lg: "h-10 px-6",
        icon: "size-9",
        "icon-xs": "size-7",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
