import type { ProjectJiraView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  afterJiraSync,
  isSyncRunning,
  syncProjectJira,
  unrecordedRefusal,
} from "@/jira/jira-api";
import { formatLocalTime, relativeTime } from "@/lib/format";

// The strip's sync half: the newest sync as `GET /projects/:id/jira` has it, and Sync now.

type SyncRecord = NonNullable<ProjectJiraView["last_sync"]>;

const VIA = { rest: "manual", timer: "automatic" } as const;

/** `3 created · 1 updated · 0 parked · 2 ignored`, then skipped and capped only when they happened. */
function countsOf(record: SyncRecord): readonly string[] {
  return [
    `${record.created} created`,
    `${record.updated} updated`,
    `${record.parked} parked`,
    `${record.ignored} ignored`,
    ...(record.skipped.length > 0 ? [`${record.skipped.length} skipped`] : []),
    ...(record.capped
      ? ["capped: more issues than one sync reads, so none parked"]
      : []),
  ];
}

const skippedTitle = (record: SyncRecord): string | undefined =>
  record.skipped.length === 0
    ? undefined
    : `Mirrored by another project: ${record.skipped
        .map((s) => (s.project === null ? s.key : `${s.key} (${s.project})`))
        .join(", ")}`;

/**
 * The newest sync: when, how it was started, what it did, and why it failed if it did. A sync that
 * worked but saw no issue at all says so: Jira answers a query the account cannot see with nothing.
 * `email` is the source's account. A row from before `matched` was kept says nothing of it.
 */
export function LastSync({
  record,
  email,
  now,
}: {
  readonly record: SyncRecord | null;
  readonly email: string;
  readonly now: number;
}) {
  if (record === null)
    return <p className="text-sm text-muted-foreground">Not synced yet.</p>;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm" title={skippedTitle(record)}>
        {"Last sync "}
        <time
          dateTime={new Date(record.at).toISOString()}
          title={formatLocalTime(record.at)}
        >
          {relativeTime(record.at, now)}
        </time>
        {` (${VIA[record.via]}) · ${countsOf(record).join(" · ")}`}
      </p>
      {record.ok && record.matched === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {`Jira returned no issues for this query. Check that ${email} can see the project in Jira.`}
        </p>
      )}
      {!record.ok && (
        <p role="alert" className="text-sm text-destructive">
          {`It failed: ${record.error?.message ?? "Jira gave no reason."}`}
        </p>
      )}
    </div>
  );
}

/**
 * `POST /projects/:id/jira/sync`; the strip and the board refetch after it, run or refused. `start`
 * sends at most one at a time: the mutation reports pending a tick after `mutate`, so a second
 * click before the button re-renders disabled would otherwise send a second POST.
 */
export function useSyncNow(project: string) {
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const mutation = useMutation({
    mutationFn: () => syncProjectJira(project),
    onSettled: () => {
      inFlight.current = false;
      return afterJiraSync(queryClient, project);
    },
  });
  const start = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    mutation.reset();
    mutation.mutate();
  };
  return { mutation, start };
}

type SyncNow = ReturnType<typeof useSyncNow>;

/** Pending while the POST runs. */
export function SyncNowButton({ sync }: { readonly sync: SyncNow }) {
  const pending = sync.mutation.isPending;
  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      aria-busy={pending}
      onClick={sync.start}
    >
      {pending ? "Syncing…" : "Sync now"}
    </Button>
  );
}

/**
 * What Sync now's refusal says, when the last sync cannot: one already running is a notice, not an
 * error; a refusal the sync never reached is the route's own words. The rest are in the last sync.
 */
export function SyncNotice({ sync }: { readonly sync: SyncNow }) {
  const { error } = sync.mutation;
  if (error === null) return null;
  if (isSyncRunning(error))
    return (
      <p role="status" className="text-sm text-muted-foreground">
        A sync is already running; its result shows here when it ends.
      </p>
    );
  const refusal = unrecordedRefusal(error);
  return refusal === null ? null : (
    <p role="alert" className="text-sm text-destructive">
      {`Not synced: ${refusal}`}
    </p>
  );
}
