import { WaiveRequest } from "@bayon/proto";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { rerunGate, waiveGate } from "@/gates/gate-api";
import { gateName, type GateFacts } from "@/gates/gate-model";
import {
  NOTE_MAX_CHARS,
  WriteDialog,
  conflictText,
  isConflict,
  useGateRefresh,
  type OnConflict,
} from "@/gates/write-dialog";

/** The waive reason from what was typed, or null when WaiveRequest refuses it. */
export const waiveReason = (values: Readonly<Record<string, string>>) => {
  const parsed = WaiveRequest.safeParse({ reason: values.reason ?? "" });
  return parsed.success ? parsed.data.reason : null;
};

export const REASON_FIELD = {
  name: "reason",
  label: "Reason",
  maxLength: NOTE_MAX_CHARS,
} as const;

type GateSubject = Pick<GateFacts, "id" | "kind" | "repo_id" | "attempt">;

const subjectOf = (gate: GateSubject): string =>
  `${gateName(gate)} #${gate.attempt}`;

/**
 * Reruns a failed gate: `POST /gates/:id/run` opens its next attempt. A 409 (one of its kind already
 * running, or the gate moved on) is news for `onConflict`, and the ticket refetches; any other
 * failure is said beside the button. The ticket's next-step line offers it too.
 */
export function RerunGateButton({
  gate,
  label = "Rerun",
  onConflict,
}: {
  readonly gate: GateSubject;
  readonly label?: string;
  readonly onConflict: OnConflict;
}) {
  const refresh = useGateRefresh();
  const rerun = useMutation({
    mutationFn: () => rerunGate(gate.id),
    onSuccess: () => {
      notify.success(`Rerunning ${subjectOf(gate)}`);
      void refresh();
    },
    onError: (error) => {
      if (!isConflict(error)) return;
      onConflict(conflictText(subjectOf(gate), error));
      void refresh();
    },
  });
  return (
    <>
      <Button
        size="sm"
        disabled={rerun.isPending}
        onClick={() => rerun.mutate()}
      >
        {label}
      </Button>
      {rerun.isError && !isConflict(rerun.error) && (
        <p role="alert" className="text-sm text-destructive">
          {rerun.error.message}
        </p>
      )}
    </>
  );
}

/**
 * What the operator may do to a gate (§12.1): rerun a failed one (the next attempt), and waive a
 * running or failed one, which then passes even with open findings, its reason shown forever.
 */
export function GateActions({
  gate,
  onConflict,
}: {
  readonly gate: GateSubject & Pick<GateFacts, "state">;
  readonly onConflict: OnConflict;
}) {
  if (gate.state !== "running" && gate.state !== "failed") return null;
  const subject = subjectOf(gate);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {gate.state === "failed" && (
        <RerunGateButton gate={gate} onConflict={onConflict} />
      )}
      <WriteDialog
        trigger="Waive"
        title={`Waive ${subject}`}
        description="A waived gate passes even with open findings. The reason is shown on the ticket forever."
        submit="Waive gate"
        fields={[REASON_FIELD]}
        parse={waiveReason}
        invalid={`Give a reason of 1 to ${NOTE_MAX_CHARS} characters.`}
        send={(reason: string) => waiveGate(gate.id, reason)}
        done={`Waived ${subject}`}
        subject={subject}
        onConflict={onConflict}
      />
    </div>
  );
}
