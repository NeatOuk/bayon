import type { ProjectView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { QueryError } from "@/components/query-error";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { addProjectAgent, afterAgentWrite } from "@/ide/agents-api";
import { ORCHESTRATOR } from "@/ide/orchestrator-api";
import { RunnerField, UncertifiedWarning } from "@/ide/runner-field";
import { runnersQuery } from "@/runners/runners-api";

// Add orchestrator: the Orchestrator view's empty state adds the project's orchestrator
// through `POST /projects/:id/agents`, on a runner the operator picks (each shown with its
// certification on `local`). It starts on the default pulse schedule with no mission. Once the
// server answers, the projects and the pulse schedule are refetched, and the view shows the
// orchestrator's controls in place of this form, and a toast names it. A refusal (a second enabled
// orchestrator, a disabled runner) is shown in the server's words.

export function AddOrchestrator({
  project,
}: {
  readonly project: ProjectView;
}) {
  const queryClient = useQueryClient();
  const [runnerId, setRunnerId] = useState<string | null>(null);
  const runners = useQuery(runnersQuery);
  const add = useMutation({
    mutationFn: (runner: string) =>
      addProjectAgent(project.id, { kind: ORCHESTRATOR, runner_id: runner }),
    onSuccess: async (agent) => {
      notify.success(`Added ${agent.name}`);
      await afterAgentWrite(queryClient, agent);
    },
  });
  const picked = runners.data?.runners.find((r) => r.id === runnerId);
  return (
    <form
      aria-label="add orchestrator"
      className="flex w-full max-w-sm flex-col gap-3 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        if (runnerId !== null) add.mutate(runnerId);
      }}
    >
      {runners.isError ? (
        <QueryError
          title="The runners are unavailable"
          error={runners.error}
          onRetry={() => void runners.refetch()}
        />
      ) : (
        <RunnerField
          runners={runners.data?.runners ?? []}
          loading={runners.isPending}
          value={runnerId}
          onChange={setRunnerId}
        />
      )}
      {picked !== undefined && <UncertifiedWarning runner={picked} />}
      {add.isError && (
        <p role="alert" className="text-sm text-destructive">
          {`Not added: ${add.error.message}`}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        className="self-start"
        disabled={runnerId === null || add.isPending}
      >
        <PlusIcon />
        Add orchestrator
      </Button>
    </form>
  );
}
