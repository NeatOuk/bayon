import type {
  DeliveryConfigView,
  DeliveryMode,
  DeliveryWhen,
} from "@bayon/proto";
import { Field } from "@/components/field";
import { RadioChoices } from "@/components/radio-choices";
import { Switch } from "@/components/ui/switch";

// A project's delivery, as the New project form and the Settings view both show it.
// Two choices and nothing else: what leaves, and when. There is no remote field — the remote is the
// one recorded when the project was created — no base branch (each repo's own), and no token (a
// host-store secret named by the forge, never typed into a browser).
//
// The wording says plainly that turning this on is the standing permission for Bayon to write to
// the project's remote, because that is exactly what it is (§14).

export const DELIVERY_SECTION_LABEL = "Delivery";

/** The close-on-merge switch's label. */
export const CLOSE_ON_MERGE_LABEL =
  "Close the ticket when its pull requests merge";

export const DELIVERY_MODE_LABELS: Readonly<Record<DeliveryMode, string>> = {
  none: "Keep the work here",
  push: "Push the branch",
  pull_request: "Push and open a pull request",
};

export const DELIVERY_MODE_HINTS: Readonly<Record<DeliveryMode, string>> = {
  none: "Nothing leaves this machine. You push finished work yourself.",
  push: "Each repository the ticket touched has its branch pushed to that repository's own remote — the one this project was created from.",
  pull_request:
    "As above, and a pull request per branch on the remote's forge. A host Bayon has no forge for still gets the push, and the ticket says so.",
};

export const DELIVERY_WHEN_LABELS: Readonly<Record<DeliveryWhen, string>> = {
  review_passed: "As soon as code review passes",
  done: "Only when the ticket is done",
};

/**
 * An existing project's history is never delivered by switching delivery on: only a
 * moment reached after it is. There is no "deliver now" for older work, so the line says who does.
 */
export const DELIVERY_SINCE_HINT =
  "Applies to tickets that reach this moment after delivery is turned on — work already done is not delivered.";

const MODES: readonly DeliveryMode[] = ["none", "push", "pull_request"];
const MOMENTS: readonly DeliveryWhen[] = ["review_passed", "done"];

/**
 * Whether a merge on the forge finishes the ticket: once every pull request its delivery
 * opened has merged, the supervisor moves it to done. Off, the merge is recorded and nothing moves.
 */
function CloseOnMerge({
  on,
  onChange,
}: {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <Field
      label={CLOSE_ON_MERGE_LABEL}
      layout="inline"
      hint="Bayon watches each pull request. When all of them have merged the ticket is done; one closed without merging asks you what to do."
    >
      {({ id, describedBy }) => (
        <Switch
          id={id}
          aria-describedby={describedBy}
          checked={on}
          onCheckedChange={(next: boolean) => onChange(next)}
        />
      )}
    </Field>
  );
}

export function DeliveryFields({
  draft,
  onChange,
  existing = false,
}: {
  readonly draft: DeliveryConfigView;
  readonly onChange: (draft: DeliveryConfigView) => void;
  /** A project that may already have finished work (Settings): say what happens to it. */
  readonly existing?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <RadioChoices
        legend="What happens to finished work"
        values={MODES}
        labels={DELIVERY_MODE_LABELS}
        hints={DELIVERY_MODE_HINTS}
        value={draft.mode}
        onChange={(mode) => onChange({ ...draft, mode })}
      />
      {draft.mode !== "none" && (
        <>
          <RadioChoices
            legend="When"
            values={MOMENTS}
            labels={DELIVERY_WHEN_LABELS}
            value={draft.when}
            onChange={(when) => onChange({ ...draft, when })}
          />
          {existing && (
            <p className="text-xs text-muted-foreground">
              {DELIVERY_SINCE_HINT}
            </p>
          )}
          {draft.mode === "pull_request" && (
            <CloseOnMerge
              on={draft.close_on_merge}
              onChange={(close_on_merge) =>
                onChange({ ...draft, close_on_merge })
              }
            />
          )}
          <p className="text-xs text-muted-foreground">
            Turning this on is your standing permission for Bayon to write to
            this project&rsquo;s remote. It only ever fast-forwards a
            ticket&rsquo;s own branch — it never force-pushes, and never deletes
            anything.
          </p>
        </>
      )}
    </div>
  );
}
