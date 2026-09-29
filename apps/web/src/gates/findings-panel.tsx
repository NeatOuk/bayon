import {
  ResolveFindingRequest,
  type FindingView,
  type GateView,
} from "@bayon/proto";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { REASON_FIELD, waiveReason } from "@/gates/gate-actions";
import { resolveFinding, waiveFinding } from "@/gates/gate-api";
import { gateName } from "@/gates/gate-model";
import {
  ConflictNotice,
  NOTE_MAX_CHARS,
  WriteDialog,
  type OnConflict,
} from "@/gates/write-dialog";
import { Panel } from "@/tickets/panel";
import { Muted } from "@/tickets/ticket-sections";

/** proto's row id bound: the fixing run's id. */
const RUN_ID_MAX_CHARS = 64;

const locationOf = (f: FindingView): string =>
  f.file === null ? "—" : f.line === null ? f.file : `${f.file}:${f.line}`;

/** Every gate's findings on the ticket, each open one resolvable or waivable (§10.3). */
export function FindingsPanel({
  gates,
}: {
  readonly gates: readonly GateView[];
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const findings = gates.flatMap((gate) =>
    gate.findings.map((finding) => ({ gate, finding })),
  );
  return (
    <Panel label="findings" title="Findings">
      <ConflictNotice notice={notice} />
      {findings.length === 0 ? (
        <Muted>No findings.</Muted>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>severity</TableHead>
              <TableHead>finding</TableHead>
              <TableHead>where</TableHead>
              <TableHead>gate</TableHead>
              <TableHead>status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {findings.map(({ gate, finding }) => (
              <TableRow key={finding.id}>
                <TableCell>{finding.severity}</TableCell>
                <TableCell className="whitespace-normal">
                  {finding.summary}
                </TableCell>
                <TableCell className="font-mono">
                  {locationOf(finding)}
                </TableCell>
                <TableCell>{`${gateName(gate)} #${gate.attempt}`}</TableCell>
                <TableCell className="whitespace-normal">
                  <FindingStatus finding={finding} onConflict={setNotice} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/** The fixing run and note from what was typed, or null when ResolveFindingRequest refuses them. */
const resolution = (values: Readonly<Record<string, string>>) => {
  const parsed = ResolveFindingRequest.safeParse({
    run_id: (values.run_id ?? "").trim(),
    note: values.note ?? "",
  });
  return parsed.success ? parsed.data : null;
};

/** Open, with its actions; or who resolved it and with which run; or who waived it and why, forever. */
function FindingStatus({
  finding,
  onConflict,
}: {
  readonly finding: FindingView;
  readonly onConflict: OnConflict;
}) {
  if (finding.status === "waived")
    return (
      <span>{`waived by ${finding.waived_by ?? "unknown"}: ${finding.waive_reason ?? ""}`}</span>
    );
  if (finding.status === "resolved")
    return (
      <span>
        {[
          `resolved by run ${finding.resolved_by_run_id ?? "unknown"}`,
          ...(finding.resolution_note === null
            ? []
            : [finding.resolution_note]),
        ].join(": ")}
      </span>
    );
  if (finding.status !== "open") return <span>{finding.status}</span>;
  const subject = `finding "${finding.summary}"`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>open</span>
      <WriteDialog
        trigger="Resolve"
        title="Resolve finding"
        description={`Name the run that fixed "${finding.summary}": it must work this ticket.`}
        submit="Resolve finding"
        fields={[
          {
            name: "run_id",
            label: "Fixing run",
            short: true,
            maxLength: RUN_ID_MAX_CHARS,
          },
          { name: "note", label: "Note", maxLength: NOTE_MAX_CHARS },
        ]}
        parse={resolution}
        invalid={`Name the fixing run and write a note of 1 to ${NOTE_MAX_CHARS} characters.`}
        send={(request: ResolveFindingRequest) =>
          resolveFinding(finding.id, request)
        }
        done={`Resolved ${subject}`}
        subject={subject}
        onConflict={onConflict}
      />
      <WriteDialog
        trigger="Waive"
        title="Waive finding"
        description={`"${finding.summary}" stops blocking. The reason is shown on the ticket forever.`}
        submit="Waive finding"
        fields={[REASON_FIELD]}
        parse={waiveReason}
        invalid={`Give a reason of 1 to ${NOTE_MAX_CHARS} characters.`}
        send={(reason: string) => waiveFinding(finding.id, reason)}
        done={`Waived ${subject}`}
        subject={subject}
        onConflict={onConflict}
      />
    </div>
  );
}
