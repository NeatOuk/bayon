import { Toast } from "@base-ui/react/toast";
import { CircleCheck, CircleX, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

// Toasts over base-ui's: one manager for the whole app, so a mutation's outcome is told
// from anywhere, and one Toaster that shows them — bottom right, newest last, on the raised popover
// surface with the tone's icon. A toast reports an event that already happened; anything the
// operator still has to act on stays on the screen, next to what it is about.
//
// Each toast is a `status` (an error an `alert`) rather than base-ui's non-modal dialog: it holds a
// sentence and a dismiss button, nothing to work inside, and a screen that has just closed its own
// dialog should not find another one open.

const manager = Toast.createToastManager();

type Kind = "success" | "error";

const add = (type: Kind, title: string, description?: string): string =>
  manager.add({
    type,
    title,
    description,
    // An error stays twice as long: it is the one worth reading twice.
    timeout: type === "error" ? 10_000 : 5_000,
  });

/** Tell the operator what just happened. Returns the toast's id. */
export const notify = {
  success: (title: string, description?: string): string =>
    add("success", title, description),
  error: (title: string, description?: string): string =>
    add("error", title, description),
  dismiss: (id: string): void => manager.close(id),
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => {
    const error = toast.type === "error";
    const Icon = error ? CircleX : CircleCheck;
    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        role={error ? "alert" : "status"}
        data-slot="toast"
        className="pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg transition-[opacity,translate] duration-200 data-ending-style:opacity-0 data-limited:hidden data-starting-style:translate-y-2 data-starting-style:opacity-0"
      >
        <Icon
          aria-hidden="true"
          className={
            error
              ? "mt-0.5 size-4 shrink-0 text-danger"
              : "mt-0.5 size-4 shrink-0 text-success"
          }
        />
        <Toast.Content className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* A div, not base-ui's h2: a toast is not a section of the page's outline. */}
          <Toast.Title render={<div />} className="font-medium" />
          <Toast.Description className="break-words text-muted-foreground" />
        </Toast.Content>
        <Toast.Close
          aria-label="Dismiss"
          render={
            <Button variant="ghost" size="icon-xs" className="-my-1 -mr-1" />
          }
        >
          <XIcon aria-hidden="true" />
        </Toast.Close>
      </Toast.Root>
    );
  });
}

/** Mounted once, near the root (app.tsx; the test render helper). */
export function Toaster() {
  return (
    <Toast.Provider toastManager={manager} limit={4}>
      <Toast.Portal>
        <Toast.Viewport
          data-slot="toaster"
          className="pointer-events-none fixed right-4 bottom-4 z-100 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 outline-none"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
