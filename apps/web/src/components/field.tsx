import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// One labelled control, instead of a copy per form: its label, its hint, and its problem
// once it has one, wired by id — the control is described by the problem first, then the hint, and is
// invalid while there is a problem. base-ui's Field wires ids only through its own Field.Control; our
// Textarea is a plain textarea and our Select names its trigger by aria-labelledby, so the ids are
// explicit and every control takes them the same way.

export interface FieldIds {
  /** The control's id: the label's `for`. */
  readonly id: string;
  /** The label's own id, for a control named by `aria-labelledby` (a Select trigger). */
  readonly labelId: string;
  /** The problem's and the hint's ids, for `aria-describedby`; undefined when there is neither. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

export function Field({
  label,
  hint,
  error,
  announce = false,
  layout = "stacked",
  id: given,
  className,
  children,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** The problem with the value as it stands; undefined while there is none. */
  readonly error?: string | undefined;
  /** Announce the problem as it appears (`role="alert"`): for one found on save, not while typing. */
  readonly announce?: boolean;
  /** `inline`: the control first, its label beside it (a switch); `stacked`: label above. */
  readonly layout?: "stacked" | "inline";
  /** The control's id, when the caller already has one. */
  readonly id?: string;
  readonly className?: string;
  /** The control, given the ids to wire; or a node already wired by the caller (`id`). */
  readonly children: ReactNode | ((ids: FieldIds) => ReactNode);
}) {
  const generated = useId();
  const id = given ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = error !== undefined;
  const describedBy =
    [invalid ? errorId : null, hint === undefined ? null : hintId]
      .filter((part) => part !== null)
      .join(" ") || undefined;
  const ids: FieldIds = { id, labelId: `${id}-label`, describedBy, invalid };
  const control = typeof children === "function" ? children(ids) : children;
  const labelNode = (
    <Label id={ids.labelId} htmlFor={id}>
      {label}
    </Label>
  );
  return (
    <div data-slot="field" className={cn("flex flex-col gap-1", className)}>
      {layout === "inline" ? (
        <div className="flex items-center gap-2">
          {control}
          {labelNode}
        </div>
      ) : (
        <>
          {labelNode}
          {control}
        </>
      )}
      {invalid && (
        <p
          id={errorId}
          role={announce ? "alert" : undefined}
          className="text-xs text-danger"
        >
          {error}
        </p>
      )}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
