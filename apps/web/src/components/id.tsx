import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// An identifier as the operator reads it: monospace, a ULID shortened in the middle — its
// head is a timestamp most ids share, its tail tells them apart — with the whole value in the title and
// for a screen reader, and a copy button where the id is something to paste elsewhere: a copy is
// said beside the button (a tick, and a polite line for a screen reader); a refusal is a toast.

const HEAD = 4;
const TAIL = 6;

/** `01J9…ZK4QF2`: the head and the tail of an id longer than both with room to spare. */
export const shortenId = (value: string): string =>
  value.length <= HEAD + TAIL + 2
    ? value
    : `${value.slice(0, HEAD)}…${value.slice(-TAIL)}`;

const COPIED_MS = 1_500;

function CopyButton({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    // Absent outside a secure context (a LAN page over plain http): say why; the id stays selectable.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      notify.error(
        `Could not copy the ${label}`,
        "Copying needs https or localhost: select it and copy it.",
      );
      return;
    }
    try {
      await clipboard.writeText(value);
      // A copy is a hint beside the id, not news for the whole screen (as CopyCommand's is).
      setCopied(true);
    } catch {
      notify.error(
        `Could not copy the ${label}`,
        "Select it and copy it instead.",
      );
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy the ${label}`}
        className="size-6 text-muted-foreground"
        onClick={() => void copy()}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? `Copied the ${label}.` : ""}
      </span>
    </>
  );
}

export function Id({
  value,
  short = value.length > HEAD + TAIL + 2,
  copy = false,
  label = "id",
  className,
}: {
  readonly value: string;
  /** Shorten in the middle; by default when the id is long enough to gain by it. */
  readonly short?: boolean;
  /** Offer a copy button. */
  readonly copy?: boolean;
  /** What the id is, for the copy button's name and its toast: "session id". */
  readonly label?: string;
  readonly className?: string;
}) {
  const shown = short ? shortenId(value) : value;
  return (
    <span
      data-slot="id"
      className={cn("inline-flex max-w-full items-center gap-1", className)}
    >
      <span
        title={value}
        className="truncate font-mono [font-variant-ligatures:none]"
      >
        {shown === value ? (
          value
        ) : (
          <>
            <span aria-hidden="true">{shown}</span>
            <span className="sr-only">{value}</span>
          </>
        )}
      </span>
      {copy && <CopyButton value={value} label={label} />}
    </span>
  );
}
