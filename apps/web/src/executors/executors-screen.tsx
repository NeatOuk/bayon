import type { ExecutorSlots, ExecutorView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ExecutorCard } from "@/executors/executor-card";
import { executorsQuery } from "@/executors/executors-api";
import { NewExecutorDialog } from "@/executors/new-executor-dialog";
import { useFleet } from "@/fleet/use-fleet";
import { Panel } from "@/tickets/panel";
import { Muted } from "@/tickets/ticket-sections";

/** Executors (§6, §12.3): where sessions run, how many they hold now, and whether they are healthy. */
export function ExecutorsScreen() {
  const executors = useQuery(executorsQuery);
  const fleet = useFleet();
  return (
    <PageContainer>
      <PageHeader title="Executors" actions={<NewExecutorDialog />} />
      <p className="text-sm text-muted-foreground">
        Where sessions run. The supervisor records each executor's health; Check
        health asks it to check again. Slots in use are live.
      </p>
      {executors.isPending && (
        <Loading label="Loading the executors…" lines={3} />
      )}
      {executors.isError && (
        <QueryError
          title="The executors are unavailable"
          error={executors.error}
          onRetry={() => void executors.refetch()}
        />
      )}
      {executors.data !== undefined && (
        <>
          <TrustRule roles={executors.data.untrusted_roles} />
          <ExecutorList
            executors={executors.data.executors}
            slots={fleet.data?.slots}
            onRefresh={() => void executors.refetch()}
          />
        </>
      )}
    </PageContainer>
  );
}

function TrustRule({ roles }: { readonly roles: readonly string[] | null }) {
  return (
    <Panel label="trust rule" title="Trust rule">
      <p className="text-sm">
        Roles in executors.untrusted_roles, and spawns flagged untrusted_input,
        run only on an untrusted executor.
      </p>
      {roles === null ? (
        <p role="alert" className="text-sm text-destructive">
          The executors.untrusted_roles setting is missing or not a list of
          roles, so the trust rule cannot be applied.
        </p>
      ) : roles.length === 0 ? (
        <Muted>No role needs an untrusted executor.</Muted>
      ) : (
        <ul aria-label="untrusted roles" className="flex flex-wrap gap-1">
          {roles.map((role) => (
            <li key={role}>
              <Badge variant="outline">{role}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ExecutorList({
  executors,
  slots,
  onRefresh,
}: {
  readonly executors: readonly ExecutorView[];
  /** The fleet's live slot counts; undefined until the fleet loads. */
  readonly slots: readonly ExecutorSlots[] | undefined;
  /** Ask again: a supervisor that just booted has registered the local one since. */
  readonly onRefresh: () => void;
}) {
  if (executors.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No executor registered</EmptyTitle>
          <EmptyDescription>
            Add one above, or with frm; the local one registers when the
            supervisor boots.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            Check again
          </Button>
        </EmptyContent>
      </Empty>
    );
  // The fleet lists enabled executors, and disabled ones still running sessions: absent is none.
  const busyOn = (id: string): number | null =>
    slots === undefined
      ? null
      : (slots.find((s) => s.executor_id === id)?.busy ?? 0);
  return (
    <div className="grid gap-4 2xl:grid-cols-2">
      {executors.map((executor) => (
        <ExecutorCard
          key={executor.id}
          executor={executor}
          busy={busyOn(executor.id)}
        />
      ))}
    </div>
  );
}
