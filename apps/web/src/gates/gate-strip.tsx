import type { GateView } from "@bayon/proto";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { GateActions } from "@/gates/gate-actions";
import { gateLine } from "@/gates/gate-announce";
import { GateAnnouncer } from "@/gates/gate-announcer";
import { GateStateBadge, ReviewerFacts } from "@/gates/gate-badges";
import {
  failureDetail,
  failureNote,
  gateGroups,
  gateName,
  retriedAttempt,
  stateLabel,
} from "@/gates/gate-model";
import { ConflictNotice, type OnConflict } from "@/gates/write-dialog";
import { formatTime } from "@/lib/format";
import { Panel } from "@/tickets/panel";
import { Muted } from "@/tickets/ticket-sections";

/**
 * §12.3's gate strip: each gate kind (and repo) at its latest attempt, with its reviewer, flags and
 * live session, and every earlier attempt with why it failed: each attempt is a review round.
 */
export function GateStrip({ gates }: { readonly gates: readonly GateView[] }) {
  const [notice, setNotice] = useState<string | null>(null);
  const groups = gateGroups(gates);
  return (
    <Panel label="gates" title="Gates">
      <GateAnnouncer lines={groups.map(({ latest }) => gateLine(latest))} />
      <ConflictNotice notice={notice} />
      {groups.length === 0 ? (
        <Muted>No gate has opened yet.</Muted>
      ) : (
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map(({ key, latest, earlier }) => (
            <li
              key={key}
              aria-label={gateName(latest)}
              className="flex flex-col gap-2 rounded-lg border bg-background p-3 shadow-xs"
            >
              <GateCard gate={latest} gates={gates} onConflict={setNotice} />
              {earlier.length > 0 && (
                <ul
                  aria-label="earlier attempts"
                  className="flex flex-col gap-1 border-t pt-2 text-xs"
                >
                  {earlier.map((gate) => (
                    <li key={gate.id}>{attemptLine(gate)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** An earlier attempt: its state and reason, and a waiver's reason (shown forever). */
const attemptLine = (gate: GateView): string =>
  [
    `#${gate.attempt} ${stateLabel(gate)}`,
    ...(gate.waive_reason === null ? [] : [`waived: ${gate.waive_reason}`]),
  ].join(" · ");

function timeline(gate: GateView): string {
  const parts = [
    ...(gate.started_at === null
      ? []
      : [`started ${formatTime(gate.started_at)} UTC`]),
    ...(gate.decided_at === null
      ? []
      : [`decided ${formatTime(gate.decided_at)} UTC`]),
    ...(gate.findings_total === 0
      ? []
      : [
          `${gate.findings_unresolved} open of ${gate.findings_total} findings`,
        ]),
  ];
  return parts.join(" · ");
}

function GateCard({
  gate,
  gates,
  onConflict,
}: {
  readonly gate: GateView;
  readonly gates: readonly GateView[];
  readonly onConflict: OnConflict;
}) {
  const retried = retriedAttempt(gate, gates);
  const note = failureNote(gate);
  const detail = failureDetail(gate);
  const when = timeline(gate);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-head">{gateName(gate)}</span>
        <span className="text-sm">{`attempt ${gate.attempt}`}</span>
        <GateStateBadge gate={gate} />
        {retried !== null && (
          <Badge variant="outline">{`automatic retry of #${retried.attempt}`}</Badge>
        )}
        {!gate.required && <Badge variant="ghost">optional</Badge>}
      </div>
      <ReviewerFacts gate={gate} />
      {note !== null && <p className="text-sm">{note}</p>}
      {detail !== null && (
        <p className="break-words text-sm text-muted-foreground">{detail}</p>
      )}
      {gate.waive_reason !== null && (
        <p className="text-sm">{`Waived: ${gate.waive_reason}`}</p>
      )}
      {when !== "" && <p className="text-xs text-muted-foreground">{when}</p>}
      <GateActions gate={gate} onConflict={onConflict} />
    </>
  );
}
