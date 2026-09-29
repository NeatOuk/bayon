import { Field } from "@/components/field";
import { Switch } from "@/components/ui/switch";
import { QA_SECTION_LABEL, QaFields } from "@/qa/qa-fields";
import { checkQa, type QaDraft } from "@/qa/qa-form";
import type { DeliveryConfigView } from "@bayon/proto";

// New project's optional QA section. Off by default: a project without one passes QA the
// way it always has, with the operator's note. Everything it configures can be set later in the
// project's Settings view; this is here so an operator who already knows the command need not go
// looking for it afterwards.

export const QA_CREATE_LABEL = "Set up a QA harness";

/** Off by default. On, the mode and (for `command`) the harness's own fields. */
export function QaCreateSection({
  on,
  draft,
  delivery,
  onToggle,
  onChange,
}: {
  readonly on: boolean;
  readonly draft: QaDraft;
  /** The delivery this same form sets: what CI checks as QA are judged beside. */
  readonly delivery: Pick<DeliveryConfigView, "mode" | "when">;
  readonly onToggle: (on: boolean) => void;
  readonly onChange: (draft: QaDraft) => void;
}) {
  const incomplete = on && checkQa(draft, delivery).config === null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <Field
        label={QA_CREATE_LABEL}
        layout="inline"
        hint={
          <>
            {`The ${QA_SECTION_LABEL} runs on each reviewed commit before the work reaches human QA. You can set this up later in the project's Settings.`}
          </>
        }
      >
        {({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={on}
            onCheckedChange={(next: boolean) => onToggle(next)}
          />
        )}
      </Field>
      {on && (
        <>
          <QaFields draft={draft} delivery={delivery} onChange={onChange} />
          {incomplete && (
            <p className="text-sm text-muted-foreground">
              Complete the harness, or turn this off.
            </p>
          )}
        </>
      )}
    </div>
  );
}
