import type { CappedPatch, RepoDiff, SessionDiff } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { DIFF_ADDED, DIFF_REMOVED } from "@/components/diff-tones";
import { Loading } from "@/components/loading";
import { SectionTitle } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTime } from "@/lib/format";
import { sessionDiffQuery } from "@/session/diff-api";
import { patchLines, shortSha, type LineTone } from "@/session/diff-model";
import { Panel } from "@/tickets/panel";
import { Muted } from "@/tickets/ticket-sections";

/** §12.4 #5, "the only output that actually matters at review time": the session's diff per repo. */
export function DiffTab({ sessionId }: { readonly sessionId: string }) {
  const diff = useQuery(sessionDiffQuery(sessionId));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={diff.isFetching}
          onClick={() => void diff.refetch()}
        >
          Refresh
        </Button>
        {diff.data !== undefined && (
          <span className="text-sm text-muted-foreground">
            {`${sourceNote(diff.data)} Read ${formatTime(diff.data.generated_at)} UTC.`}
          </span>
        )}
      </div>
      {diff.isPending && <Loading label="Reading the diff…" />}
      {diff.isError && (
        <QueryError
          title="The diff is unavailable"
          error={diff.error}
          onRetry={() => void diff.refetch()}
        />
      )}
      {diff.data !== undefined && <DiffBody diff={diff.data} />}
    </div>
  );
}

function sourceNote(diff: SessionDiff): string {
  switch (diff.source) {
    case "worktree":
      return "The session's worktrees on the API's host, against their base.";
    case "gate":
      return "Its worktrees are not on the API's host: this is what its gates pinned (diff.patch).";
    case "none":
      return "";
  }
}

function DiffBody({ diff }: { readonly diff: SessionDiff }) {
  if (diff.source === "none")
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No diff</EmptyTitle>
          <EmptyDescription>
            {diff.reason ?? "Nothing to show."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="flex flex-col gap-4">
      {diff.repos.map((repo, i) => (
        <RepoView
          key={
            repo.worktree_id ?? repo.gate?.id ?? `${repo.repo_id ?? ""}-${i}`
          }
          repo={repo}
        />
      ))}
    </div>
  );
}

const repoTitle = (repo: RepoDiff): string =>
  [
    repo.repo_id ?? "repository",
    ...(repo.worktree_id === null ? [] : [repo.worktree_id]),
    ...(repo.gate === null ? [] : [`${repo.gate.kind} #${repo.gate.attempt}`]),
  ].join(" · ");

function RepoView({ repo }: { readonly repo: RepoDiff }) {
  const title = repoTitle(repo);
  return (
    <Panel label={title} title={title}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {repo.branch !== null && (
          <span className="font-mono">{repo.branch}</span>
        )}
        <span className="font-mono">{`${shortSha(repo.base_sha)}..${shortSha(repo.head_sha)}`}</span>
        {repo.gate !== null && (
          // The gate's state alone: the diff carries no failure reason (the gate strip has it).
          <StatusBadge entity="gate" state={repo.gate.state} />
        )}
      </div>
      {repo.unavailable !== null ? (
        <Muted>{`No diff: ${repo.unavailable}`}</Muted>
      ) : (
        <>
          <FileList repo={repo} />
          {repo.patch !== null && <PatchView patch={repo.patch} />}
        </>
      )}
    </Panel>
  );
}

const count = (n: number | null, sign: string): string =>
  n === null ? "binary" : `${sign}${n}`;

function FileList({ repo }: { readonly repo: RepoDiff }) {
  const shown = (listed: number, total: number) =>
    listed < total ? ` (first ${listed} shown)` : "";
  return (
    <>
      <SectionTitle as="h3">
        {`Files · ${repo.files_total}${shown(repo.files.length, repo.files_total)}`}
      </SectionTitle>
      {repo.files.length === 0 ? (
        <Muted>No tracked file changed since the base.</Muted>
      ) : (
        <Table aria-label="changed files">
          <TableHeader>
            <TableRow>
              <TableHead>path</TableHead>
              <TableHead>added</TableHead>
              <TableHead>deleted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repo.files.map((file) => (
              <TableRow key={file.path}>
                <TableCell className="font-mono">{file.path}</TableCell>
                <TableCell>{count(file.added, "+")}</TableCell>
                <TableCell>{count(file.deleted, "−")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {repo.untracked_total > 0 && (
        <>
          <SectionTitle as="h3">
            {`Untracked, not in the patch · ${repo.untracked_total}${shown(repo.untracked.length, repo.untracked_total)}`}
          </SectionTitle>
          <ul aria-label="untracked files" className="font-mono text-sm">
            {repo.untracked.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

const TONE: Readonly<Record<LineTone, string>> = {
  meta: "font-bold",
  hunk: "text-muted-foreground",
  add: DIFF_ADDED,
  del: DIFF_REMOVED,
  context: "",
};

function PatchView({ patch }: { readonly patch: CappedPatch }) {
  const lines = patchLines(patch.text);
  return (
    <>
      {patch.truncated && (
        <Alert status="warning" role="note">
          <AlertTitle>Patch capped</AlertTitle>
          <AlertDescription>
            {`Showing the first ${lines.length} of ${patch.lines} lines (${patch.bytes} bytes in all). ${
              patch.full_path === null
                ? "The full patch could not be kept on the API's host."
                : `The full patch is at ${patch.full_path}`
            }`}
          </AlertDescription>
        </Alert>
      )}
      {lines.length === 0 ? (
        <Muted>The patch is empty.</Muted>
      ) : (
        <pre
          aria-label="patch"
          className="overflow-x-auto rounded-lg border bg-background p-2 font-mono text-xs leading-5"
        >
          <code>
            {lines.map((line, i) => (
              <span
                // Lines repeat (context, blank) and have no id: their position is their identity.
                key={i}
                data-tone={line.tone}
                className={`block ${TONE[line.tone]}`}
              >
                {line.text === "" ? " " : line.text}
              </span>
            ))}
          </code>
        </pre>
      )}
    </>
  );
}
