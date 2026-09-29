import type {
  MissionDiffChange,
  MissionSectionDiff,
  MissionVersionSummary,
} from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { missionDiffQuery } from "@/api/queries";
import { DIFF_ADDED, DIFF_REMOVED } from "@/components/diff-tones";
import { Loading } from "@/components/loading";
import { SectionTitle } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";

type Op = MissionDiffChange["op"];

const OP_CLASS: Readonly<Record<Op, string>> = {
  same: "",
  add: DIFF_ADDED,
  remove: `${DIFF_REMOVED} line-through`,
};
const OP_MARK: Readonly<Record<Op, string>> = {
  same: " ",
  add: "+",
  remove: "-",
};
const OP_WORD: Readonly<Record<Op, string>> = {
  same: "",
  add: "added: ",
  remove: "removed: ",
};

interface Pair {
  readonly from: number;
  readonly to: number;
}
const pairLabel = ({ from, to }: Pair): string => `diff v${from} → v${to}`;

/** The changelog, newest first; any older version diffs against the latest (§12.3). */
export function MissionHistory({
  agent,
  versions,
  headingLevel = 2,
}: {
  readonly agent: string;
  readonly versions: readonly MissionVersionSummary[];
  /** The diff's heading level: 2 under the mission page's h1, 3 inside a host's h2 section. */
  readonly headingLevel?: 2 | 3;
}) {
  const [pair, setPair] = useState<Pair | null>(null);
  const latest = versions[0]?.version;
  if (latest === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        No versions yet: the first save is v1.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {versions.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 text-card-foreground"
          >
            <Badge variant="outline">{`v${row.version}`}</Badge>
            {row.version === latest && <Badge>Latest</Badge>}
            <span className="min-w-0 flex-1">{row.note ?? "(no note)"}</span>
            <span className="text-xs text-muted-foreground">
              {`${row.created_by} · ${formatTime(row.created_at)}`}
            </span>
            {row.version !== latest && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => setPair({ from: row.version, to: latest })}
              >
                {pairLabel({ from: row.version, to: latest })}
              </Button>
            )}
          </li>
        ))}
      </ol>
      {pair !== null && (
        <DiffView agent={agent} pair={pair} level={headingLevel} />
      )}
    </div>
  );
}

function DiffView({
  agent,
  pair,
  level,
}: {
  readonly agent: string;
  readonly pair: Pair;
  readonly level: 2 | 3;
}) {
  const diff = useQuery(missionDiffQuery(agent, pair.from, pair.to));
  return (
    <section aria-label={pairLabel(pair)} className="flex flex-col gap-2">
      <SectionTitle as={level === 2 ? "h2" : "h3"}>
        {pairLabel(pair)}
      </SectionTitle>
      {diff.isPending && <Loading label="Loading the diff…" />}
      {diff.isError && (
        <QueryError
          title="The diff is unavailable"
          error={diff.error}
          onRetry={() => void diff.refetch()}
        />
      )}
      {diff.data?.sections.map((section) => (
        <SectionDiffView
          key={section.section}
          diff={section}
          level={level === 2 ? "h3" : "h4"}
        />
      ))}
    </section>
  );
}

/** A change's text is a run of lines; each gets its own marked row. */
const linesOf = (change: MissionDiffChange): string[] =>
  change.text.replace(/\n$/, "").split("\n");

function SectionDiffView({
  diff,
  level,
}: {
  readonly diff: MissionSectionDiff;
  readonly level: "h3" | "h4";
}) {
  if (!diff.changed)
    return (
      <p className="text-sm text-muted-foreground">{`${diff.section}: unchanged`}</p>
    );
  const rows = diff.changes.flatMap((change) =>
    linesOf(change).map((line) => ({ op: change.op, line })),
  );
  return (
    <div className="flex flex-col gap-1">
      <SectionTitle as={level}>{diff.section}</SectionTitle>
      <pre className="overflow-auto rounded-lg border bg-card py-1 font-mono text-xs text-card-foreground">
        {rows.map(({ op, line }, index) => (
          <div key={index} data-op={op} className={`px-2 ${OP_CLASS[op]}`}>
            <span aria-hidden="true" className="inline-block w-4 select-none">
              {OP_MARK[op]}
            </span>
            <span className="sr-only">{OP_WORD[op]}</span>
            <span>{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
