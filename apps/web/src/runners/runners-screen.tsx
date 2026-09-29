import type { ExecutorView, RunnerView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { executorsQuery } from "@/executors/executors-api";
import { RunnerCard } from "@/runners/runner-card";
import { runnersQuery } from "@/runners/runners-api";

/** Runners (§12.3, §15): each registered runner, its capabilities and its certification per executor. */
export function RunnersScreen() {
  const runners = useQuery(runnersQuery);
  const executors = useQuery(executorsQuery);
  return (
    <PageContainer>
      <PageHeader title="Runners" />
      <p className="text-sm text-muted-foreground">
        Certification is per runner and executor: a conformance run certifies
        the pair, and a new runner version, capabilities or suite lapses it.
        Unattended work and reviews need a certified pair.
      </p>
      {runners.isPending && <Loading label="Loading the runners…" lines={3} />}
      {runners.isError && (
        <QueryError
          title="The runners are unavailable"
          error={runners.error}
          onRetry={() => void runners.refetch()}
        />
      )}
      {executors.isError && (
        <QueryError
          title="The executors are unavailable"
          error={executors.error}
          onRetry={() => void executors.refetch()}
        />
      )}
      {runners.data !== undefined && (
        <RunnerList
          runners={runners.data.runners}
          executors={executors.data?.executors ?? []}
          onRefresh={() => void runners.refetch()}
        />
      )}
    </PageContainer>
  );
}

function RunnerList({
  runners,
  executors,
  onRefresh,
}: {
  readonly runners: readonly RunnerView[];
  readonly executors: readonly ExecutorView[];
  /** Ask again: a supervisor that just booted has registered them since. */
  readonly onRefresh: () => void;
}) {
  if (runners.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No runner registered</EmptyTitle>
          <EmptyDescription>
            Runners register when the supervisor boots its adapters.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            Check again
          </Button>
        </EmptyContent>
      </Empty>
    );
  return (
    <div className="grid gap-4 2xl:grid-cols-2">
      {runners.map((runner) => (
        <RunnerCard key={runner.id} runner={runner} executors={executors} />
      ))}
    </div>
  );
}
