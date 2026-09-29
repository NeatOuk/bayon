import * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// shadcn's Sheet over base-ui's Dialog: a panel against one edge of the viewport. base-ui's Drawer
// adds swipe gestures and snap points; a panel that slides in without them is a positioned Dialog
// (its docs' words), so the focus trap, Esc, the backdrop and focus return are the Dialog's.

/** Links a Sheet to a trigger that lives elsewhere in the tree (base-ui's detached trigger). */
const createSheetHandle = () => SheetPrimitive.createHandle();

export type SheetHandle = ReturnType<typeof createSheetHandle>;

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

const SIDE = {
  left: "inset-y-0 left-0 h-full w-72 max-w-[calc(100%-3rem)] border-r data-open:slide-in-from-left data-closed:slide-out-to-left",
  right:
    "inset-y-0 right-0 h-full w-72 max-w-[calc(100%-3rem)] border-l data-open:slide-in-from-right data-closed:slide-out-to-right",
} as const;

/** The panel, with the page dimmed behind it; `side` is the edge it slides from. */
function SheetContent({
  className,
  children,
  side = "left",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: keyof typeof SIDE;
  showCloseButton?: boolean;
}) {
  return (
    <SheetPrimitive.Portal data-slot="sheet-portal">
      <SheetPrimitive.Backdrop
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 bg-overlay duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col bg-card text-card-foreground shadow-lg outline-none duration-200 data-open:animate-in data-closed:animate-out",
          SIDE[side],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-2 right-2"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 p-3 pr-12", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-head text-base font-semibold", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  createSheetHandle,
};
