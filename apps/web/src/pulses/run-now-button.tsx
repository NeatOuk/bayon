import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { CommandStatus } from "@/commands/command-status";
import { Button } from "@/components/ui/button";
import { pulseAgentsQuery, pulsesQuery, runPulseNow } from "@/pulses/pulse-api";
import { runNowText } from "@/pulses/pulse-model";

/**
 * §9.7 manual: one pulse of this orchestrator now. It skips the gap, never the lease or the cap.
 * The POST only queues a `pulse.run`; the supervisor decides, so its command is followed until it
 * settles, and a refusal (the fleet or the project paused) is shown in the server's words. A
 * `label` names the button (the IDE's "Wake now"); without one it is "Run now", named for the agent.
 */
export function RunNowButton({
  agentId,
  agentName,
  label,
  variant = "default",
  blocked = null,
}: {
  readonly agentId: string;
  readonly agentName: string;
  readonly label?: string;
  /** Where it sits: a row of a schedule asks for a quieter button than a view's one action. */
  readonly variant?: "default" | "outline" | "ghost" | "secondary";
  /**
   * Why a pulse cannot run now (the fleet or its project paused): the button is disabled and says
   * why in its tooltip and description. The server would refuse it the same way.
   */
  readonly blocked?: string | null;
}) {
  const blockedId = useId();
  const queryClient = useQueryClient();
  const [commandId, setCommandId] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => runPulseNow(agentId),
    onSuccess: (accepted) => {
      setCommandId(accepted.command_id);
      void queryClient.invalidateQueries({ queryKey: pulsesQuery.queryKey });
      void queryClient.invalidateQueries({
        queryKey: pulseAgentsQuery.queryKey,
      });
    },
  });
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant={variant}
        aria-label={
          label === undefined ? `Run a pulse of ${agentName} now` : undefined
        }
        title={blocked ?? undefined}
        aria-describedby={blocked === null ? undefined : blockedId}
        disabled={run.isPending || blocked !== null}
        onClick={() => {
          setCommandId(null);
          run.mutate();
        }}
      >
        {label ?? "Run now"}
      </Button>
      {blocked !== null && (
        <span id={blockedId} className="sr-only">
          {blocked}
        </span>
      )}
      {commandId !== null && (
        <CommandStatus
          key={commandId}
          commandId={commandId}
          refresh={pulsesQuery.queryKey}
          describe={runNowText}
        />
      )}
      {run.isError && (
        <span role="alert" className="text-sm text-destructive">
          {run.error.message}
        </span>
      )}
    </div>
  );
}
