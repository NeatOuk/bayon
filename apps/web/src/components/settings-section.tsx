import type { FormEvent, ReactNode } from "react";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// One settings section = one card: no card inside a card. Its title and a sentence on
// what it governs sit left of its controls once the card is wide enough (a container query, so an
// IDE view beside the explorer reads the same as a full-width screen), above them below that. Its
// one Save lives in the footer, with the save's own error beside it; the success is a toast.

export function SettingsSection({
  title,
  label = title,
  description,
  footer,
  form,
  className,
  children,
}: {
  /** The h2. */
  readonly title: string;
  /** The section's accessible name, when it is not the title. */
  readonly label?: string;
  readonly description?: ReactNode;
  /** The section's Save (SectionSave) and anything beside it. */
  readonly footer?: ReactNode;
  /** Makes the body and the footer one form, named `label`: the footer's Save submits it. */
  readonly form?: {
    readonly label: string;
    readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  };
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const inner = (
    <>
      <div className="grid gap-x-10 gap-y-4 p-5 @3xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1">
          <SectionTitle>{title}</SectionTitle>
          {description !== undefined && (
            <div className="text-[0.8125rem] leading-relaxed text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
      </div>
      {footer !== undefined && (
        <div
          data-slot="section-footer"
          className="flex flex-wrap items-center gap-2 border-t bg-muted/50 px-5 py-3"
        >
          {footer}
        </div>
      )}
    </>
  );
  return (
    <section
      aria-label={label}
      data-slot="settings-section"
      className={cn(
        "@container rounded-xl border bg-card text-card-foreground shadow-xs",
        className,
      )}
    >
      {form === undefined ? (
        inner
      ) : (
        <form
          aria-label={form.label}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            form.onSubmit(event);
          }}
        >
          {inner}
        </form>
      )}
    </section>
  );
}

/**
 * A section's Save: a submit button (its label while idle, "Saving…" while pending), whatever goes
 * beside it, and the save's failure in words, inline.
 */
export function SectionSave({
  label,
  pending = false,
  disabled = false,
  error = null,
  children,
}: {
  readonly label: string;
  readonly pending?: boolean;
  readonly disabled?: boolean;
  /** The failed save's message, shown as "Not saved: …". */
  readonly error?: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <>
      <Button type="submit" disabled={disabled || pending}>
        {pending ? "Saving…" : label}
      </Button>
      {children}
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {`Not saved: ${error}`}
        </p>
      )}
    </>
  );
}
